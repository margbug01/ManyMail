package main

// The rules engine (was the mail-router container). A message is routed as soon as it is
// stored; the worker also wakes every few seconds for retries. State per message:
//
//	status   running | retry | done | failed
//	matched  rule ids, fixed when the message is first seen
//	results  {"<rule id>:<action index>": {status: done | error | waiting, ...}}
//
// Only actions that have not succeeded run again. The FORWARD_* / PAYPAL_FORWARD_*
// variables still become read-only rules, so an existing .env keeps working.

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const userAgent = "ManyMail-Router/2.0"

type router struct {
	cfg *Config
	st  *Store

	client                 *http.Client
	resendURL, telegramURL string
	env                    func(string) string // os.Getenv, swapped in tests
	now                    func() time.Time

	since time.Time
	wake  chan struct{}
	done  chan struct{} // closed when the worker has stopped
}

func newRouter(cfg *Config, st *Store) *router {
	return &router{cfg: cfg, st: st, client: &http.Client{Timeout: 20 * time.Second},
		resendURL: "https://api.resend.com", telegramURL: "https://api.telegram.org",
		env: os.Getenv, now: time.Now, wake: make(chan struct{}, 1), done: make(chan struct{})}
}

// Notify wakes the worker (called after a message is stored).
func (r *router) Notify() {
	select {
	case r.wake <- struct{}{}:
	default:
	}
}

// Start seeds the .env rules, fixes the cut-over time and runs the worker until ctx ends.
func (r *router) Start(ctx context.Context) error {
	r.seedLegacyRules()
	since, err := r.startTime()
	if err != nil {
		return err
	}
	r.since = since
	rules, _ := r.st.Rules()
	log.Printf("router: routing mail received since %s with %d rule(s)", since.Format(time.RFC3339), len(rules))
	go func() {
		defer close(r.done)
		cleanup := time.NewTicker(time.Hour)
		defer cleanup.Stop()
		for {
			for r.runOnce() {
			}
			select {
			case <-ctx.Done():
				return
			case <-r.wake:
			case <-time.After(r.cfg.RouterPoll):
			case <-cleanup.C:
				r.st.DeleteEventsOlderThan(r.now().Add(-30 * 24 * time.Hour))
			}
		}
	}()
	return nil
}

// Wait blocks until the worker has stopped (after ctx ends), so no action is cut off
// halfway and its result is saved before the store closes.
func (r *router) Wait() { <-r.done }

// startTime: only mail that arrives after the router first started is routed, so imported
// history is never replayed. ROUTER_START_FROM overrides it on the very first start.
func (r *router) startTime() (time.Time, error) {
	if v, found, err := r.st.Get("router_since"); err != nil || found {
		if err != nil {
			return time.Time{}, err
		}
		return time.Parse(time.RFC3339Nano, v)
	}
	since := r.now().UTC()
	if v := strings.TrimSpace(r.env("ROUTER_START_FROM")); v != "" {
		t, err := parseStartFrom(v)
		if err != nil {
			return since, err
		}
		since = t
	}
	if err := r.st.SetIfMissing("router_since", since.Format(time.RFC3339Nano)); err != nil {
		return since, err
	}
	return since, nil
}

// parseStartFrom accepts what Python's datetime.fromisoformat did here: a date, a
// datetime without zone (UTC), or a full RFC 3339 timestamp.
func parseStartFrom(v string) (time.Time, error) {
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02T15:04:05.999999999", "2006-01-02 15:04:05", "2006-01-02"} {
		if t, err := time.Parse(layout, v); err == nil {
			return t.UTC(), nil
		}
	}
	return time.Time{}, fmt.Errorf("ROUTER_START_FROM %q is not a date (use e.g. 2025-06-01 or 2025-06-01T08:00:00+08:00)", v)
}

func (r *router) legacyRule(id, prefix string) Rule {
	get := func(k string) string { return strings.TrimSpace(r.env(prefix + k)) }
	source, target, sender := strings.ToLower(get("FORWARD_SOURCE_ADDRESS")), strings.ToLower(get("FORWARD_TO_ADDRESS")), get("FORWARD_FROM")
	if source == "" || target == "" || sender == "" {
		return nil
	}
	return Rule{"_id": id, "name": "Forward " + source, "managed_by": "env", "enabled": true, "order": float64(0),
		"stop": false, "match": map[string]any{"to": []any{source}},
		"actions": []any{map[string]any{"type": "forward", "to": []any{target}, "from": sender,
			"subject_prefix": get("FORWARD_SUBJECT_PREFIX"), "api_key_env": prefix + "FORWARD_RESEND_API_KEY"}}}
}

func (r *router) seedLegacyRules() {
	for _, l := range [][2]string{{"env-forward", ""}, {"env-paypal-forward", "PAYPAL_"}} {
		id, prefix := l[0], l[1]
		rule := r.legacyRule(id, prefix)
		if rule == nil {
			// Only remove it if .env made it; a user rule with the same id stays.
			if cur, _ := r.st.Rule(id); cur != nil && cur["managed_by"] == "env" {
				r.st.DeleteRule(id)
			}
			continue
		}
		if problems := validateRule(rule); len(problems) > 0 {
			log.Printf("router: ignoring %sFORWARD_* settings: %s", prefix, strings.Join(problems, "; "))
			continue
		}
		rule["updated_at"] = r.now().UTC().Format(time.RFC3339)
		if err := r.st.PutRule(rule); err != nil {
			log.Printf("router: seed %s: %v", id, err)
			continue
		}
		log.Printf("router: rule %s from %sFORWARD_*: %s", id, prefix, strFrom(matchOf(rule)["to"].([]any)[0]))
	}
}

func (r *router) usableRules() []Rule {
	all, err := r.st.Rules()
	if err != nil {
		log.Printf("router: load rules: %v", err)
	}
	var out []Rule
	for _, rule := range all {
		if p := validateRule(rule); len(p) > 0 {
			log.Printf("router: skipping rule %s: %s", rule.ID(), strings.Join(p, "; "))
			continue
		}
		out = append(out, rule)
	}
	return out
}

// runOnce routes one pending message or IMAP event; false when there was nothing to do.
func (r *router) runOnce() bool {
	m, err := r.st.ClaimNext(r.since)
	if err != nil {
		log.Printf("router: claim: %v", err)
		return false
	}
	if m == nil {
		return false
	}
	// Rules are re-read per message (a handful of rows), so edits apply at once.
	if _, err := r.process(m, r.usableRules()); err != nil {
		log.Printf("router: save %s: %v", m.ID, err)
	}
	return true
}

// errRetryLater: not a failure, just not ready yet.
var errRetryLater = errors.New("retry later")

func (r *router) process(m *RouteMsg, rules []Rule) (string, error) {
	var matched []Rule
	if m.Routing.Matched != nil {
		for _, rule := range rules {
			if contains(m.Routing.Matched, rule.ID()) {
				matched = append(matched, rule)
			}
		}
	} else {
		matched = selectRules(rules, m)
	}
	if m.Routing.Results == nil {
		m.Routing.Results = map[string]ActionResult{}
	}
	m.Routing.Matched = []string{}
	for _, rule := range matched {
		m.Routing.Matched = append(m.Routing.Matched, rule.ID())
	}
	stamp := func() string { return r.now().UTC().Format(time.RFC3339) }
	failed, waiting := 0, 0
	for _, rule := range matched {
		for i, a := range actionsOf(rule) {
			key := fmt.Sprintf("%s:%d", rule.ID(), i)
			kind := strFrom(a["type"])
			if m.Routing.Results[key].Status == "done" {
				continue
			}
			if m.Source == "imap" && !notifyTypes[kind] {
				// Forwarding or changing a message needs it stored here; IMAP mail is a header only.
				m.Routing.Results[key] = ActionResult{Status: "done", Type: kind, Detail: "skipped for IMAP mail", At: stamp()}
				continue
			}
			detail, err := r.run(a, m, rule, key)
			switch {
			case err == nil:
				m.Routing.Results[key] = ActionResult{Status: "done", Type: kind, Detail: clip(detail, 300), At: stamp()}
				log.Printf("router: %s %s on %s: %s", key, kind, m.ID, clip(detail, 200))
			case errors.Is(err, errRetryLater):
				waiting++
				m.Routing.Results[key] = ActionResult{Status: "waiting", Type: kind, Error: clip(err.Error(), 300), At: stamp()}
			default:
				failed++
				m.Routing.Results[key] = ActionResult{Status: "error", Type: kind, Error: clip(err.Error(), 500), At: stamp()}
				log.Printf("router: %s %s on %s failed: %s", key, kind, m.ID, clip(err.Error(), 300))
			}
			// Save after every action: a crash or restart mid-rule must not send the done ones again.
			if err := r.st.SaveRouting(m, ms(r.now().Add(staleClaim))); err != nil {
				return "", err
			}
		}
	}
	m.Routing.Updated, m.Routing.Next = stamp(), ""
	var next int64
	switch {
	case failed > 0 && m.Routing.Attempts >= r.cfg.RouterMaxAttempts:
		m.Routing.Status = "failed"
	case failed > 0 || waiting > 0:
		m.Routing.Status = "retry"
		delay := 2 * r.cfg.RouterPoll
		if failed > 0 {
			delay = r.cfg.RouterRetry << min(m.Routing.Attempts-1, 6)
		}
		at := r.now().Add(min(delay, time.Hour))
		next, m.Routing.Next = ms(at), at.UTC().Format(time.RFC3339)
	default:
		m.Routing.Status = "done"
	}
	return m.Routing.Status, r.st.SaveRouting(m, next)
}

func clip(s string, n int) string {
	if r := []rune(s); len(r) > n {
		return string(r[:n])
	}
	return s
}

// ---- actions ----

func (r *router) run(a map[string]any, m *RouteMsg, rule Rule, key string) (string, error) {
	switch strFrom(a["type"]) {
	case "forward":
		return r.forward(a, m, key)
	case "ntfy":
		return r.ntfy(a, m)
	case "telegram":
		return r.telegram(a, m)
	case "webhook":
		return r.webhook(a, m, rule)
	case "tag":
		var tags []string
		for _, t := range asList(a["tags"]) {
			if s := strings.TrimSpace(strFrom(t)); s != "" && !contains(tags, s) {
				tags = append(tags, s)
			}
		}
		return "tagged " + strings.Join(tags, ", "), r.st.AddTags(m.ID, tags)
	case "mark_read":
		return "marked read", r.st.SetFlag(m.ID, "seen = 1")
	case "trash":
		return "moved to trash", r.st.SetFlag(m.ID, "is_deleted = 1")
	}
	return "", fmt.Errorf("unknown action %q", a["type"])
}

// envFirst returns the first non-empty variable among the names.
func (r *router) envFirst(names ...string) string {
	for _, n := range names {
		if n != "" {
			if v := strings.TrimSpace(r.env(n)); v != "" {
				return v
			}
		}
	}
	return ""
}

func (r *router) postJSON(url string, payload any, headers map[string]string) (map[string]any, error) {
	raw, _ := json.Marshal(payload)
	req, err := http.NewRequest("POST", url, bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", userAgent)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := r.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%s connection failed: %v", req.URL.Hostname(), err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode >= 300 {
		return nil, fmt.Errorf("%s HTTP %d: %s", req.URL.Hostname(), resp.StatusCode, clip(string(body), 300))
	}
	out := map[string]any{}
	json.Unmarshal(body, &out)
	return out, nil
}

type summary struct {
	ID       string   `json:"id"`
	From     string   `json:"from"`
	FromName string   `json:"from_name"`
	To       []string `json:"to"`
	Subject  string   `json:"subject"`
	Intro    string   `json:"intro"`
	Code     *string  `json:"code"`
	HasAtt   bool     `json:"has_attachments"`
	Created  string   `json:"created_at"`
}

func summarize(m *RouteMsg) summary {
	subject := strings.TrimSpace(m.Subject)
	if subject == "" {
		subject = "(no subject)"
	}
	body := m.Text
	if body == "" {
		body = m.Intro
	}
	to := m.To
	if to == nil {
		to = []string{}
	}
	return summary{ID: m.ID, From: m.FromAddress, FromName: m.FromName, To: to, Subject: subject,
		Intro: clip(m.Intro, 300), Code: extractCode(m.Subject, body), HasAtt: m.HasAtt, Created: m.Created.Format(time.RFC3339)}
}

func notificationText(s summary) string {
	sender := s.From
	if s.FromName != "" {
		sender = s.FromName + " <" + s.From + ">"
	}
	lines := []string{"From: " + sender, "To: " + strings.Join(s.To, ", ")}
	if s.Code != nil {
		lines = append(lines, "Code: "+*s.Code)
	}
	if s.Intro != "" {
		lines = append(lines, "", s.Intro)
	}
	return strings.Join(lines, "\n")
}

func (r *router) forward(a map[string]any, m *RouteMsg, key string) (string, error) {
	apiKey := r.envFirst(strFrom(a["api_key_env"]), "RESEND_API_KEY", "FORWARD_RESEND_API_KEY")
	if apiKey == "" {
		return "", errors.New("no Resend API key (set RESEND_API_KEY or the rule's api_key_env)")
	}
	subject := strings.TrimSpace(m.Subject)
	if subject == "" {
		subject = "(no subject)"
	}
	if prefix := strings.TrimSpace(strFrom(a["subject_prefix"])); prefix != "" {
		subject = prefix + " " + subject
	}
	var to []string
	for _, t := range asList(a["to"]) {
		to = append(to, strFrom(t))
	}
	payload := map[string]any{"from": strFrom(a["from"]), "to": to, "subject": clip(subject, 998)}
	if from := strings.ToLower(strings.TrimSpace(m.FromAddress)); strings.Contains(from, "@") {
		payload["reply_to"] = from
	}
	if m.Text != "" {
		payload["text"] = m.Text
	}
	if m.HTML != "" {
		payload["html"] = m.HTML
	}
	if m.Text == "" && m.HTML == "" {
		payload["text"] = "The original message did not contain a readable body."
	}
	atts, err := r.st.Attachments(m.ID)
	if err != nil {
		return "", err
	}
	var list []map[string]string
	for _, at := range atts {
		name := at.Filename
		if name == "" {
			name = "attachment"
		}
		list = append(list, map[string]string{"filename": name, "content": base64.StdEncoding.EncodeToString(at.Content)})
	}
	if len(list) > 0 {
		payload["attachments"] = list
	}
	body, err := r.postJSON(r.resendURL+"/emails", payload, map[string]string{
		"Authorization":   "Bearer " + apiKey,
		"Idempotency-Key": clip("manymail-route-"+m.ID+"-"+key, 256),
	})
	if err != nil {
		return "", err
	}
	id := strFrom(body["id"])
	if id == "" {
		return "", errors.New("Resend response did not include an email id")
	}
	return "resend " + id, nil
}

func (r *router) ntfy(a map[string]any, m *RouteMsg) (string, error) {
	s := summarize(m)
	server := strings.TrimRight(strFrom(a["server"]), "/")
	if server == "" {
		server = "https://ntfy.sh"
	}
	payload := map[string]any{"topic": strings.TrimSpace(strFrom(a["topic"])), "title": clip(s.Subject, 250),
		"message": notificationText(s), "tags": []string{"envelope"}}
	if truthy(a["priority"]) {
		p, err := strconv.Atoi(strFrom(a["priority"]))
		if err != nil {
			return "", fmt.Errorf("priority must be a number")
		}
		payload["priority"] = p
	}
	if r.cfg.ViewerPublicURL != "" {
		payload["click"] = r.cfg.ViewerPublicURL
	}
	headers := map[string]string{}
	if token := r.envFirst(strFrom(a["token_env"])); token != "" {
		headers["Authorization"] = "Bearer " + token
	}
	body, err := r.postJSON(server, payload, headers)
	if err != nil {
		return "", err
	}
	id := strFrom(body["id"])
	if id == "" {
		id = "sent"
	}
	return "ntfy " + id, nil
}

func (r *router) telegram(a map[string]any, m *RouteMsg) (string, error) {
	token := r.envFirst(strFrom(a["bot_token_env"]), "TELEGRAM_BOT_TOKEN")
	if token == "" {
		return "", errors.New("no Telegram bot token (set TELEGRAM_BOT_TOKEN or the rule's bot_token_env)")
	}
	s := summarize(m)
	text := "✉️ " + s.Subject + "\n" + notificationText(s)
	if r.cfg.ViewerPublicURL != "" {
		text += "\n\n" + r.cfg.ViewerPublicURL
	}
	body, err := r.postJSON(r.telegramURL+"/bot"+token+"/sendMessage",
		map[string]any{"chat_id": strFrom(a["chat_id"]), "text": clip(text, 4000), "disable_web_page_preview": true}, nil)
	if err != nil {
		// The bot token is part of the URL; keep it out of logs and the status page.
		return "", errors.New(strings.ReplaceAll(err.Error(), token, "***"))
	}
	id := "sent"
	if res, ok := body["result"].(map[string]any); ok && res["message_id"] != nil {
		id = strFrom(res["message_id"])
	}
	return "telegram " + id, nil
}

func (r *router) webhook(a map[string]any, m *RouteMsg, rule Rule) (string, error) {
	payload := map[string]any{"event": "message.received",
		"rule": map[string]string{"id": rule.ID(), "name": strFrom(rule["name"])}, "message": summarize(m)}
	raw, _ := json.Marshal(payload)
	req, err := http.NewRequest("POST", strFrom(a["url"]), bytes.NewReader(raw))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", userAgent)
	if secret := r.envFirst(strFrom(a["secret_env"])); secret != "" {
		mac := hmac.New(sha256.New, []byte(secret))
		mac.Write(raw) // exactly the bytes sent
		req.Header.Set("X-ManyMail-Signature", "sha256="+hex.EncodeToString(mac.Sum(nil)))
	}
	resp, err := r.client.Do(req)
	if err != nil {
		return "", fmt.Errorf("%s connection failed: %v", req.URL.Hostname(), err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 300))
		return "", fmt.Errorf("%s HTTP %d: %s", req.URL.Hostname(), resp.StatusCode, b)
	}
	return "webhook delivered", nil
}

// ---- HTTP API (page, IMAP bridge) under /router on the API port ----

type ruleError struct {
	status   int
	msg      string
	problems []string
}

func (e *ruleError) Error() string { return e.msg }

func ruleErr(status int, msg string, problems ...string) error {
	if problems == nil {
		problems = []string{}
	}
	return &ruleError{status, msg, problems}
}

var slugRe = regexp.MustCompile(`[^a-z0-9]+`)

func slug(name string) string {
	s := strings.Trim(slugRe.ReplaceAllString(strings.ToLower(name), "-"), "-")
	if len(s) > 40 {
		s = s[:40]
	}
	if s == "" {
		return "rule"
	}
	return s
}

// saveRule inserts or replaces a rule; created reports whether it is new.
func (r *router) saveRule(rule Rule, id string) (Rule, bool, error) {
	clean := Rule{}
	for k, v := range rule {
		if k != "managed_by" && k != "problems" && k != "updated_at" {
			clean[k] = v
		}
	}
	if _, ok := clean["enabled"]; !ok {
		clean["enabled"] = true
	}
	if _, ok := clean["order"]; !ok {
		clean["order"] = float64(100)
	}
	switch {
	case id != "":
		clean["_id"] = id
	case strFrom(clean["_id"]) != "":
		clean["_id"] = strFrom(clean["_id"])
	default:
		clean["_id"] = slug(strFrom(clean["name"]))
	}
	if p := validateRule(clean); len(p) > 0 {
		return nil, false, ruleErr(400, "invalid rule", p...)
	}
	cur, err := r.st.Rule(clean.ID())
	if err != nil {
		return nil, false, err
	}
	if cur != nil && cur["managed_by"] == "env" {
		return nil, false, ruleErr(409, clean.ID()+" comes from .env; change the FORWARD_* variables instead")
	}
	clean["updated_at"] = r.now().UTC().Format(time.RFC3339)
	return clean, cur == nil, r.st.PutRule(clean)
}

func (r *router) getRule(id string) (Rule, error) {
	rule, err := r.st.Rule(id)
	if err == nil && rule == nil {
		err = ruleErr(404, "no rule "+id)
	}
	return rule, err
}

func brief(m *RouteMsg) map[string]any {
	to := m.To
	if to == nil {
		to = []string{}
	}
	return map[string]any{"id": m.ID, "source": m.Source, "from": m.FromAddress, "to": to,
		"subject": clip(m.Subject, 200), "created_at": m.Created.Format(time.RFC3339)}
}

var sampleMsg = RouteMsg{ID: "test", Source: "smtp", To: []string{"you@example.com"}, FromAddress: "sender@example.com",
	FromName: "ManyMail test", Subject: "ManyMail router test", Intro: "If you can read this, the notification channel works. Code 123456."}

// testNotifications sends a sample through the rule's ntfy / telegram / webhook actions.
func (r *router) testNotifications(rule Rule) []map[string]any {
	out := []map[string]any{}
	sample := sampleMsg
	sample.Created = r.now().UTC()
	for i, a := range actionsOf(rule) {
		kind := strFrom(a["type"])
		if !notifyTypes[kind] {
			continue
		}
		detail, err := r.run(a, &sample, rule, fmt.Sprintf("test:%d", i))
		if err != nil {
			out = append(out, map[string]any{"type": kind, "ok": false, "detail": clip(err.Error(), 300)})
		} else {
			out = append(out, map[string]any{"type": kind, "ok": true, "detail": detail})
		}
	}
	return out
}

func newestFirst(list []RouteMsg, limit int) []RouteMsg {
	for i := 1; i < len(list); i++ { // insertion sort, lists are short
		for j := i; j > 0 && list[j].Created.After(list[j-1].Created); j-- {
			list[j], list[j-1] = list[j-1], list[j]
		}
	}
	if len(list) > limit {
		list = list[:limit]
	}
	return list
}

func (r *router) dryRun(rule Rule, limit int) (map[string]any, error) {
	limit = min(max(limit, 1), 500)
	rule = Rule(copyMap(rule))
	rule["enabled"] = true
	list, err := r.st.Recent(limit, false)
	if err != nil {
		return nil, err
	}
	list = newestFirst(list, limit)
	hits := []map[string]any{}
	for i := range list {
		if ruleMatches(rule, &list[i]) {
			hits = append(hits, brief(&list[i]))
		}
	}
	return map[string]any{"checked": len(list), "matched": hits}, nil
}

func copyMap(m map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range m {
		out[k] = v
	}
	return out
}

func (r *router) recentStatus(limit int) ([]map[string]any, error) {
	limit = min(max(limit, 1), 200)
	rules, err := r.st.Rules()
	if err != nil {
		return nil, err
	}
	names := map[string]string{}
	for _, rule := range rules {
		names[rule.ID()] = strFrom(rule["name"])
	}
	list, err := r.st.Recent(limit, true)
	if err != nil {
		return nil, err
	}
	out := []map[string]any{}
	for _, m := range newestFirst(list, limit) {
		row := brief(&m)
		matched := []string{}
		for _, id := range m.Routing.Matched {
			if n := names[id]; n != "" {
				id = n
			}
			matched = append(matched, id)
		}
		problems := []string{}
		for k, res := range m.Routing.Results {
			if res.Status != "done" {
				problems = append(problems, k+": "+clip(res.Error, 120))
			}
		}
		row["status"], row["rules"], row["errors"] = m.Routing.Status, matched, problems
		out = append(out, row)
	}
	return out, nil
}

const maxEvents = 50

// recordIMAPEvent stores new-mail notices from the IMAP bridge; duplicates are ignored.
func (r *router) recordIMAPEvent(body map[string]any) (int, error) {
	account := strings.ToLower(strings.TrimSpace(strFrom(body["account"])))
	if !strings.Contains(account, "@") {
		return 0, ruleErr(400, "account must be an email address")
	}
	list, ok := body["messages"].([]any)
	if !ok || len(list) == 0 {
		return 0, ruleErr(400, "messages must be a non-empty list")
	}
	validity := strFrom(body["uidvalidity"])
	if validity == "" {
		validity = "0"
	}
	accepted, now := 0, r.now()
	for _, raw := range list[:min(len(list), maxEvents)] {
		item, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		uid, err := strconv.ParseInt(strFrom(item["uid"]), 10, 64)
		if err != nil || uid < 0 {
			continue
		}
		sender, _ := item["from"].(map[string]any)
		isNew, err := r.st.InsertEvent(fmt.Sprintf("imap:%s:%s:%d", account, validity, uid), account, uid,
			strings.ToLower(clip(strFrom(sender["address"]), 320)), clip(strFrom(sender["name"]), 200),
			clip(strFrom(item["subject"]), 500), clip(strFrom(item["intro"]), 300), truthy(item["has_attachments"]), now)
		if err != nil {
			return accepted, err
		}
		if isNew {
			accepted++
		}
	}
	if accepted > 0 {
		r.Notify()
	}
	return accepted, nil
}

// handler serves the rules API. authed=false is for in-process calls from the web UI.
func (r *router) handler(authed bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		path := strings.Trim(strings.TrimPrefix(req.URL.Path, "/router"), "/")
		if req.Method == "GET" && path == "health" {
			writeJSON(w, 200, map[string]bool{"ok": true})
			return
		}
		if authed {
			if r.cfg.APIKey == "" {
				writeJSON(w, 503, map[string]string{"error": "API_KEY is not set"})
				return
			}
			if !hmac.Equal([]byte(req.Header.Get("X-API-Key")), []byte(r.cfg.APIKey)) {
				writeJSON(w, 401, map[string]string{"error": "invalid API key"})
				return
			}
		}
		status, out, err := r.route(req, strings.Split(path, "/"))
		var re *ruleError
		switch {
		case errors.As(err, &re):
			writeJSON(w, re.status, map[string]any{"error": re.msg, "problems": re.problems})
		case err != nil:
			log.Printf("router API %s %s: %v", req.Method, req.URL.Path, err)
			writeJSON(w, 500, map[string]string{"error": "internal error"})
		default:
			writeJSON(w, status, out)
		}
	})
}

func readBody(req *http.Request) (map[string]any, error) {
	raw, err := io.ReadAll(io.LimitReader(req.Body, 256<<10+1))
	if err != nil {
		return nil, err
	}
	if len(raw) > 256<<10 {
		return nil, ruleErr(413, "request body too large")
	}
	body := map[string]any{}
	if len(bytes.TrimSpace(raw)) == 0 {
		return body, nil
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return nil, ruleErr(400, "body must be a JSON object")
	}
	return body, nil
}

func (r *router) route(req *http.Request, parts []string) (int, any, error) {
	m, n := req.Method, len(parts)
	body := func() (map[string]any, error) { return readBody(req) }
	switch {
	case n == 1 && parts[0] == "rules" && m == "GET":
		rules, err := r.st.Rules()
		for _, rule := range rules {
			rule["problems"] = validateRule(rule)
		}
		return 200, map[string]any{"rules": rules}, err
	case n == 1 && parts[0] == "rules" && m == "POST", n == 2 && parts[0] == "rules" && m == "PUT":
		b, err := body()
		if err != nil {
			return 0, nil, err
		}
		id := ""
		if n == 2 {
			id = parts[1]
		}
		rule, created, err := r.saveRule(Rule(b), id)
		status := 200
		if created && n == 1 {
			status = 201
		}
		return status, map[string]any{"rule": rule, "created": created}, err
	case n == 2 && parts[0] == "rules" && m == "DELETE":
		rule, err := r.getRule(parts[1])
		if err != nil {
			return 0, nil, err
		}
		if rule["managed_by"] == "env" {
			return 0, nil, ruleErr(409, parts[1]+" comes from .env; clear its FORWARD_* variables instead")
		}
		return 200, map[string]string{"deleted": parts[1]}, r.st.DeleteRule(parts[1])
	case n == 3 && parts[0] == "rules" && m == "POST" && parts[2] == "enabled":
		rule, err := r.getRule(parts[1])
		if err != nil {
			return 0, nil, err
		}
		b, err := body()
		if err != nil {
			return 0, nil, err
		}
		rule["enabled"] = truthy(b["enabled"])
		rule["updated_at"] = r.now().UTC().Format(time.RFC3339)
		return 200, map[string]string{"id": parts[1]}, r.st.PutRule(rule)
	case n == 3 && parts[0] == "rules" && m == "POST" && parts[2] == "test":
		rule, err := r.getRule(parts[1])
		if err != nil {
			return 0, nil, err
		}
		return 200, map[string]any{"results": r.testNotifications(rule)}, nil
	case n == 1 && (parts[0] == "test" || parts[0] == "dry-run") && m == "POST":
		b, err := body()
		if err != nil {
			return 0, nil, err
		}
		rule, ok := b["rule"].(map[string]any)
		if !ok {
			return 0, nil, ruleErr(400, "rule must be an object")
		}
		if parts[0] == "test" {
			return 200, map[string]any{"results": r.testNotifications(rule)}, nil
		}
		limit := 50
		if l, ok := b["limit"].(float64); ok && l > 0 {
			limit = int(l)
		}
		out, err := r.dryRun(rule, limit)
		return 200, out, err
	case n == 1 && parts[0] == "status" && m == "GET":
		limit, err := strconv.Atoi(req.URL.Query().Get("limit"))
		if err != nil {
			limit = 20
		}
		rows, err := r.recentStatus(limit)
		return 200, map[string]any{"messages": rows}, err
	case n == 2 && parts[0] == "events" && parts[1] == "imap" && m == "POST":
		b, err := body()
		if err != nil {
			return 0, nil, err
		}
		accepted, err := r.recordIMAPEvent(b)
		return 202, map[string]int{"accepted": accepted}, err
	}
	return 404, map[string]string{"error": "not found"}, nil
}
