package main

// Ported from router/tests (test_rules.py, test_router.py, test_api.py), plus the parts
// that are new here: routing right after SMTP delivery and the rule-aware loop guard.

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	netsmtp "net/smtp"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// ---- rules (pure) ----

var ruleMsg = RouteMsg{Source: "smtp", To: []string{"otp-github@example.com"}, FromAddress: "noreply@GitHub.com",
	Subject: "[GitHub] Your verification code", Text: "Code: 123456. Invoice attached."}

func mkRule(match map[string]any, extra ...any) Rule {
	r := Rule{"_id": "r", "name": "r", "match": match, "actions": []any{map[string]any{"type": "mark_read"}}}
	for i := 0; i+1 < len(extra); i += 2 {
		r[extra[i].(string)] = extra[i+1]
	}
	return r
}

func list(v ...any) []any { return v }

func TestRuleMatching(t *testing.T) {
	m := ruleMsg
	spam := ruleMsg
	spam.IsSpam, spam.Deleted = true, true
	deleted := ruleMsg
	deleted.Deleted = true
	imap := ruleMsg
	imap.Source = "imap"
	cases := []struct {
		name string
		rule Rule
		msg  RouteMsg
		want bool
	}{
		{"empty match", mkRule(nil), m, true},
		{"spam skipped", mkRule(nil), spam, false},
		{"spam when asked", mkRule(map[string]any{"include_spam": true}), spam, true},
		{"user-deleted never", mkRule(map[string]any{"include_spam": true}), deleted, false},
		{"to glob any case", mkRule(map[string]any{"to": list("OTP-*@example.com")}), m, true},
		{"to and from", mkRule(map[string]any{"to": list("*@example.com"), "from": "*@github.com"}), m, true},
		{"to miss", mkRule(map[string]any{"to": list("hello@example.com")}), m, false},
		{"from miss", mkRule(map[string]any{"from": list("*@gitlab.com")}), m, false},
		{"glob star crosses slash", mkRule(map[string]any{"subject": nil, "to": list("otp*")}), m, true},
		{"glob class", mkRule(map[string]any{"to": list("otp-[gx]ithub@*")}), m, true},
		{"glob negated class", mkRule(map[string]any{"to": list("otp-[!g]ithub@*")}), m, false},
		{"glob dots are literal", mkRule(map[string]any{"to": list("otp-github@example_com")}), m, false},
		{"subject or, and body", mkRule(map[string]any{"subject": list("nothing", "VERIFICATION"), "body": list("invoice")}), m, true},
		{"body miss", mkRule(map[string]any{"subject": list("verification"), "body": list("refund")}), m, false},
		{"regex", mkRule(map[string]any{"subject_regex": `^\[github\]`}), m, true},
		{"regex miss", mkRule(map[string]any{"subject_regex": `^github`}), m, false},
		{"attachments wanted", mkRule(map[string]any{"has_attachments": true}), m, false},
		{"attachments unwanted", mkRule(map[string]any{"has_attachments": false}), m, true},
		{"disabled", mkRule(nil, "enabled", false), m, false},
		{"smtp only by default", mkRule(nil), imap, false},
		{"imap source", mkRule(map[string]any{"source": list("imap")}), imap, true},
		{"imap-only rule", mkRule(map[string]any{"source": "imap"}), m, false},
		{"both sources", mkRule(map[string]any{"source": list("smtp", "imap")}), imap, true},
	}
	for _, c := range cases {
		if got := ruleMatches(c.rule, &c.msg); got != c.want {
			t.Errorf("%s: %v", c.name, got)
		}
	}
	rules := []Rule{mkRule(nil, "_id", "late", "order", 50.0),
		mkRule(map[string]any{"to": list("otp-*@example.com")}, "_id", "first", "order", 1.0, "stop", true),
		mkRule(nil, "_id", "early", "order", 0.0)}
	var ids []string
	for _, r := range selectRules(rules, &m) {
		ids = append(ids, r.ID())
	}
	if strings.Join(ids, ",") != "early,first" {
		t.Errorf("order/stop: %v", ids)
	}
}

func jsonRule(t *testing.T, s string) Rule {
	t.Helper()
	var r Rule
	if err := json.Unmarshal([]byte(s), &r); err != nil {
		t.Fatal(err)
	}
	return r
}

func TestValidateRule(t *testing.T) {
	good := jsonRule(t, `{"name":"all","match":{"to":["*@example.com"]},"actions":[
		{"type":"forward","to":["me@gmail.com"],"from":"Me <hi@example.com>"},{"type":"ntfy","topic":"abc"},
		{"type":"telegram","chat_id":"1","bot_token_env":"MY_BOT"},{"type":"webhook","url":"https://hooks.test/x"},
		{"type":"tag","tags":["otp"]},{"type":"trash"}]}`)
	if p := validateRule(good); len(p) != 0 {
		t.Errorf("good rule: %v", p)
	}
	bad := jsonRule(t, `{"name":"","match":{"subject_regex":"(","colour":"red","source":["pop3"]},"actions":[
		{"type":"explode"},{"type":"forward","to":["not-an-address"]},{"type":"ntfy"},{"type":"webhook","url":"ftp://x"},
		{"type":"telegram","chat_id":"1","bot_token_env":"lower-case"}]}`)
	problems := strings.Join(validateRule(bad), " | ")
	for _, want := range []string{"name is required", "unknown match keys: colour", "match.source must be smtp and/or imap",
		"subject_regex", "actions[0].type", "actions[1].to", "actions[1].from", "actions[2].topic", "actions[3].url",
		"actions[4].bot_token_env"} {
		if !strings.Contains(problems, want) {
			t.Errorf("missing %q in %s", want, problems)
		}
	}
	if p := validateRule(jsonRule(t, `{"name":"x","actions":[]}`)); len(p) != 1 || p[0] != "actions must be a non-empty list" {
		t.Errorf("empty actions: %v", p)
	}
	if c := extractCode("Your code", "is 482913."); c == nil || *c != "482913" {
		t.Error("code")
	}
	if extractCode("order 12345 or 1234567") != nil {
		t.Error("code false positive")
	}
}

// ---- engine ----

// fakeWeb stands in for Resend, ntfy, Telegram and webhooks; it records every request.
type fakeWeb struct {
	mu    sync.Mutex
	calls []webCall
	fail  map[string]int // path -> remaining failures (500)
	srv   *httptest.Server
}

type webCall struct {
	Path    string
	Header  http.Header
	Raw     []byte
	Payload map[string]any
}

func newFakeWeb(t *testing.T) *fakeWeb {
	f := &fakeWeb{fail: map[string]int{}}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var p map[string]any
		json.Unmarshal(raw, &p)
		f.mu.Lock()
		f.calls = append(f.calls, webCall{r.URL.Path, r.Header.Clone(), raw, p})
		failing := f.fail[r.URL.Path] > 0
		if failing {
			f.fail[r.URL.Path]--
		}
		f.mu.Unlock()
		switch {
		case failing:
			w.WriteHeader(500)
			io.WriteString(w, `{"message":"down"}`)
		case strings.HasPrefix(r.URL.Path, "/bot"):
			io.WriteString(w, `{"ok":true,"result":{"message_id":7}}`)
		default:
			io.WriteString(w, `{"id":"id-1"}`)
		}
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeWeb) count(prefix string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, c := range f.calls {
		if strings.HasPrefix(c.Path, prefix) {
			n++
		}
	}
	return n
}

type renv struct {
	t   *testing.T
	st  *Store
	r   *router
	web *fakeWeb
	env map[string]string
}

func newRouterEnv(t *testing.T) *renv {
	st, err := openStore(filepath.Join(t.TempDir(), "r.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	st.SeedDomains([]string{"example.com"})
	cfg := &Config{RouterPoll: 5 * time.Second, RouterRetry: time.Minute, RouterMaxAttempts: 12, APIKey: "k-123",
		ViewerPublicURL: "https://mail.example"}
	e := &renv{t: t, st: st, r: newRouter(cfg, st), web: newFakeWeb(t), env: map[string]string{"RESEND_API_KEY": "re_test"}}
	e.r.resendURL, e.r.telegramURL = e.web.srv.URL, e.web.srv.URL
	e.r.env = func(k string) string { return e.env[k] }
	since, err := e.r.startTime()
	if err != nil {
		t.Fatal(err)
	}
	e.r.since = since
	return e
}

type msgOpt func(*Message)

// deliver stores a message like SMTP would; created is "now" unless an option changes it.
func (e *renv) deliver(opts ...msgOpt) string {
	e.t.Helper()
	m := &Message{ID: newID(), To: []string{"hello@example.com"}, Size: 10, CreatedAt: time.Now().UTC(),
		Mail: &Parsed{FromAddress: "alice@sender.test", FromName: "Alice", Subject: "Your code",
			Text: "Use 482913 to sign in."}}
	for _, o := range opts {
		o(m)
	}
	if err := e.st.InsertMessage(m); err != nil {
		e.t.Fatal(err)
	}
	return m.ID
}

// step is the old run_once(rules): route one message, "" when nothing was due.
func (e *renv) step(rules ...Rule) string {
	e.t.Helper()
	m, err := e.st.ClaimNext(e.r.since)
	if err != nil {
		e.t.Fatal(err)
	}
	if m == nil {
		return ""
	}
	status, err := e.r.process(m, rules)
	if err != nil {
		e.t.Fatal(err)
	}
	return status
}

func (e *renv) routing(id string) Routing {
	var doc string
	e.st.db.QueryRow(`SELECT coalesce(routing, '{}') FROM messages WHERE id = ?`, id).Scan(&doc)
	var r Routing
	json.Unmarshal([]byte(doc), &r)
	return r
}

func (e *renv) dueNow(id string) {
	e.st.db.Exec(`UPDATE messages SET route_next = 0 WHERE id = ?`, id)
}

var forwardRule = Rule{"_id": "fwd", "name": "forward hello", "match": map[string]any{"to": list("hello@example.com")},
	"actions": list(map[string]any{"type": "forward", "to": list("me@gmail.com"), "from": "Me <hello@example.com>", "subject_prefix": "[MM]"})}

func TestLegacyEnvRules(t *testing.T) {
	e := newRouterEnv(t)
	e.env["FORWARD_SOURCE_ADDRESS"] = "Hello@Example.com"
	e.env["FORWARD_TO_ADDRESS"] = "me@gmail.com"
	e.env["FORWARD_FROM"] = "Shop <hello@example.com>"
	e.env["FORWARD_SUBJECT_PREFIX"] = "[Shop]"
	e.env["PAYPAL_FORWARD_SOURCE_ADDRESS"] = "paypal@example.com" // incomplete: no rule
	e.r.seedLegacyRules()
	rule, _ := e.st.Rule("env-forward")
	a := actionsOf(rule)[0]
	if rule["managed_by"] != "env" || matchOf(rule)["to"].([]any)[0] != "hello@example.com" || a["subject_prefix"] != "[Shop]" ||
		a["api_key_env"] != "FORWARD_RESEND_API_KEY" || a["to"].([]any)[0] != "me@gmail.com" {
		t.Errorf("rule %v", rule)
	}
	if r, _ := e.st.Rule("env-paypal-forward"); r != nil {
		t.Error("incomplete PAYPAL_ settings made a rule")
	}
	// The loop guard now knows the target from the rule.
	if targets, _ := e.st.ForwardTargets(); !targets["me@gmail.com"] {
		t.Error("forward target not found")
	}
	delete(e.env, "FORWARD_TO_ADDRESS")
	e.r.seedLegacyRules()
	if r, _ := e.st.Rule("env-forward"); r != nil {
		t.Error("cleared settings left the rule")
	}
	// A user's own rule with that id is not removed.
	user := Rule(copyMap(forwardRule))
	user["_id"] = "env-forward"
	e.st.PutRule(user)
	e.r.seedLegacyRules()
	if r, _ := e.st.Rule("env-forward"); r == nil {
		t.Error("user rule deleted")
	}

	// The legacy key variable is used when the rule names it.
	delete(e.env, "RESEND_API_KEY")
	e.env["FORWARD_RESEND_API_KEY"] = "re_legacy"
	e.env["FORWARD_TO_ADDRESS"], e.env["FORWARD_FROM"], e.env["FORWARD_SUBJECT_PREFIX"] = "me@gmail.com", "hello@example.com", ""
	id := e.deliver()
	m := &RouteMsg{ID: id, Subject: "Your code", To: []string{"hello@example.com"}}
	if _, err := e.r.forward(actionsOf(e.r.legacyRule("env-forward", ""))[0], m, "env-forward:0"); err != nil {
		t.Fatal(err)
	}
	c := e.web.calls[0]
	if c.Header.Get("Authorization") != "Bearer re_legacy" || strings.Contains(c.Payload["subject"].(string), "[") {
		t.Errorf("legacy forward: %v %v", c.Header, c.Payload)
	}
}

func TestOnlyNewMailIsRouted(t *testing.T) {
	e := newRouterEnv(t)
	e.deliver(func(m *Message) { m.CreatedAt = time.Now().Add(-72 * time.Hour) })
	if s := e.step(forwardRule); s != "" || e.web.count("/emails") != 0 {
		t.Errorf("old mail routed: %q", s)
	}
	e.deliver(func(m *Message) { m.Mail.Subject = "fresh" })
	if s := e.step(forwardRule); s != "done" {
		t.Errorf("fresh: %q", s)
	}
	if p := e.web.calls[0].Payload; p["subject"] != "[MM] fresh" {
		t.Errorf("subject %v", p["subject"])
	}
	if s := e.step(forwardRule); s != "" {
		t.Error("routed twice")
	}
	// The cut-over time survives a restart.
	again, _ := e.r.startTime()
	if !again.Equal(e.r.since) {
		t.Errorf("since moved: %v -> %v", e.r.since, again)
	}
	// Unmatched mail is marked done with nothing matched.
	id := e.deliver(func(m *Message) { m.To = []string{"other@example.com"} })
	if s := e.step(forwardRule); s != "done" || len(e.routing(id).Matched) != 0 || e.web.count("/emails") != 1 {
		t.Errorf("unmatched: %q %+v", s, e.routing(id))
	}
}

func TestRetries(t *testing.T) {
	e := newRouterEnv(t)
	rule := Rule(copyMap(forwardRule))
	rule["actions"] = append(list(), forwardRule["actions"].([]any)[0], map[string]any{"type": "ntfy", "topic": "t", "server": e.web.srv.URL + "/ntfy"})
	id := e.deliver()
	e.web.fail["/ntfy"] = 1
	if s := e.step(rule); s != "retry" {
		t.Fatalf("first: %q", s)
	}
	r := e.routing(id)
	if r.Results["fwd:0"].Status != "done" || !strings.Contains(r.Results["fwd:1"].Error, "HTTP 500") || r.Next == "" {
		t.Errorf("results %+v", r)
	}
	if s := e.step(rule); s != "" {
		t.Error("retried before the backoff")
	}
	e.dueNow(id)
	if s := e.step(rule); s != "done" || e.web.count("/emails") != 1 || e.web.count("/ntfy") != 2 {
		t.Errorf("second: %q forwards=%d ntfy=%d", s, e.web.count("/emails"), e.web.count("/ntfy"))
	}

	// Gives up after the last attempt.
	e.r.cfg.RouterMaxAttempts = 2
	id = e.deliver()
	e.web.fail["/emails"] = 10
	if s := e.step(forwardRule); s != "retry" {
		t.Errorf("attempt 1: %q", s)
	}
	e.dueNow(id)
	if s := e.step(forwardRule); s != "failed" {
		t.Errorf("attempt 2: %q", s)
	}
	e.dueNow(id)
	if s := e.step(forwardRule); s != "" {
		t.Error("failed message routed again")
	}
	e.web.fail["/emails"] = 0

	// Matched rules are fixed when first seen: trashing it does not cancel the owed forward.
	e.r.cfg.RouterMaxAttempts = 12
	bin := Rule{"_id": "bin", "name": "bin", "order": 0.0, "match": map[string]any{}, "actions": list(map[string]any{"type": "trash"})}
	id = e.deliver()
	e.web.fail["/emails"] = 1
	before := e.web.count("/emails")
	if s := e.step(bin, forwardRule); s != "retry" {
		t.Errorf("trash+forward: %q", s)
	}
	e.dueNow(id)
	if s := e.step(bin, forwardRule); s != "done" || e.web.count("/emails") != before+2 {
		t.Errorf("owed forward: %q", s)
	}
}

func TestForwardPayload(t *testing.T) {
	e := newRouterEnv(t)
	id := e.deliver(func(m *Message) {
		m.Mail.Subject, m.Mail.Text, m.Mail.HTML = "", "", "<p>hi</p>"
		m.Mail.Attachments = []Attachment{{ID: newID(), Filename: "a.pdf", ContentType: "application/pdf", Content: []byte("%PDF")}}
	})
	m := &RouteMsg{ID: id, FromAddress: "alice@sender.test", HTML: "<p>hi</p>"}
	if _, err := e.r.forward(actionsOf(forwardRule)[0], m, "fwd:0"); err != nil {
		t.Fatal(err)
	}
	c := e.web.calls[0]
	p := c.Payload
	att := p["attachments"].([]any)[0].(map[string]any)
	if c.Path != "/emails" || c.Header.Get("Authorization") != "Bearer re_test" || c.Header.Get("Idempotency-Key") != "manymail-route-"+id+"-fwd:0" ||
		p["subject"] != "[MM] (no subject)" || p["reply_to"] != "alice@sender.test" || p["html"] != "<p>hi</p>" || p["text"] != nil ||
		att["filename"] != "a.pdf" || att["content"] != "JVBERg==" {
		t.Errorf("payload %v %v", c.Header, p)
	}
	delete(e.env, "RESEND_API_KEY")
	if _, err := e.r.forward(actionsOf(forwardRule)[0], m, "fwd:0"); err == nil || !strings.Contains(err.Error(), "no Resend API key") {
		t.Errorf("no key: %v", err)
	}
}

func TestNotifications(t *testing.T) {
	e := newRouterEnv(t)
	m := &RouteMsg{ID: "x", FromAddress: "alice@sender.test", FromName: "Alice", To: []string{"hello@example.com"},
		Subject: "Login code", Text: "Use 482913 to sign in.", Intro: "Use 482913 to sign in."}

	e.env["NTFY_TOKEN"] = "tk"
	if _, err := e.r.ntfy(map[string]any{"topic": "mine", "server": e.web.srv.URL + "/n/", "token_env": "NTFY_TOKEN", "priority": 4.0}, m); err != nil {
		t.Fatal(err)
	}
	c := e.web.calls[0]
	p := c.Payload
	if c.Path != "/n" || c.Header.Get("Authorization") != "Bearer tk" || p["topic"] != "mine" || p["title"] != "Login code" ||
		p["priority"].(float64) != 4 || !strings.Contains(p["message"].(string), "From: Alice <alice@sender.test>") ||
		!strings.Contains(p["message"].(string), "Code: 482913") || p["click"] != "https://mail.example" {
		t.Errorf("ntfy %v %v", c.Path, p)
	}

	if _, err := e.r.telegram(map[string]any{"chat_id": "1"}, m); err == nil || !strings.Contains(err.Error(), "Telegram bot token") {
		t.Errorf("no token: %v", err)
	}
	e.env["TELEGRAM_BOT_TOKEN"] = "123:abc"
	if d, err := e.r.telegram(map[string]any{"chat_id": 42.0}, m); err != nil || d != "telegram 7" {
		t.Errorf("telegram: %q %v", d, err)
	}
	c = e.web.calls[1]
	if c.Path != "/bot123:abc/sendMessage" || c.Payload["chat_id"] != "42" {
		t.Errorf("telegram call %v %v", c.Path, c.Payload)
	}
	e.web.fail["/bot123:abc/sendMessage"] = 1
	if _, err := e.r.telegram(map[string]any{"chat_id": "1"}, m); err == nil || strings.Contains(err.Error(), "123:abc") {
		t.Errorf("token in error: %v", err)
	}

	e.env["HOOK_SECRET"] = "s3cret"
	rule := Rule{"_id": "hook", "name": "Hook"}
	if _, err := e.r.webhook(map[string]any{"url": e.web.srv.URL + "/in", "secret_env": "HOOK_SECRET"}, m, rule); err != nil {
		t.Fatal(err)
	}
	c = e.web.calls[len(e.web.calls)-1]
	mac := hmac.New(sha256.New, []byte("s3cret"))
	mac.Write(c.Raw)
	msg := c.Payload["message"].(map[string]any)
	if c.Header.Get("X-ManyMail-Signature") != "sha256="+hex.EncodeToString(mac.Sum(nil)) || msg["code"] != "482913" ||
		c.Payload["rule"].(map[string]any)["id"] != "hook" {
		t.Errorf("webhook %v %v", c.Header, c.Payload)
	}
}

func TestMailboxActions(t *testing.T) {
	e := newRouterEnv(t)
	id := e.deliver()
	rule := Rule{"_id": "otp", "name": "otp", "match": map[string]any{},
		"actions": list(map[string]any{"type": "tag", "tags": list("otp", "otp", " ")}, map[string]any{"type": "mark_read"}, map[string]any{"type": "trash"})}
	if s := e.step(rule); s != "done" {
		t.Fatalf("%q", s)
	}
	var tags string
	var seen, deleted bool
	e.st.db.QueryRow(`SELECT tags, seen, is_deleted FROM messages WHERE id = ?`, id).Scan(&tags, &seen, &deleted)
	if tags != `["otp"]` || !seen || !deleted {
		t.Errorf("tags=%s seen=%v deleted=%v", tags, seen, deleted)
	}
}

// ---- API ----

func (e *renv) call(method, path string, body any, key string) (int, map[string]any) {
	e.t.Helper()
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req := httptest.NewRequest(method, "/router"+path, rd)
	if key != "" {
		req.Header.Set("X-API-Key", key)
	}
	rec := httptest.NewRecorder()
	e.r.handler(true).ServeHTTP(rec, req)
	var out map[string]any
	json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

var ntfyRuleBody = map[string]any{"name": "Push OTP", "match": map[string]any{"to": list("*@example.com")},
	"actions": list(map[string]any{"type": "ntfy", "topic": "t1"})}

func TestRouterAPI(t *testing.T) {
	e := newRouterEnv(t)
	const key = "k-123"
	if code, _ := e.call("GET", "/health", nil, ""); code != 200 {
		t.Error("health")
	}
	for _, k := range []string{"", "wrong"} {
		if code, _ := e.call("GET", "/rules", nil, k); code != 401 {
			t.Errorf("key %q: %d", k, code)
		}
	}
	if code, _ := e.call("GET", "/nope", nil, key); code != 404 {
		t.Error("404")
	}
	e.r.cfg.APIKey = ""
	if code, _ := e.call("GET", "/rules", nil, ""); code != 503 {
		t.Error("empty key must refuse")
	}
	e.r.cfg.APIKey = key

	code, out := e.call("POST", "/rules", ntfyRuleBody, key)
	if code != 201 || out["rule"].(map[string]any)["_id"] != "push-otp" || out["created"] != true {
		t.Fatalf("create %d %v", code, out)
	}
	_, out = e.call("GET", "/rules", nil, key)
	rules := out["rules"].([]any)
	if len(rules) != 1 || len(rules[0].(map[string]any)["problems"].([]any)) != 0 {
		t.Errorf("list %v", out)
	}
	changed := copyMap(ntfyRuleBody)
	changed["name"], changed["order"] = "Push OTP 2", 5
	if _, out = e.call("PUT", "/rules/push-otp", changed, key); out["rule"].(map[string]any)["order"].(float64) != 5 {
		t.Errorf("put %v", out)
	}
	e.call("POST", "/rules/push-otp/enabled", map[string]any{"enabled": false}, key)
	if r, _ := e.st.Rule("push-otp"); r["enabled"] != false {
		t.Error("disable")
	}
	if code, out = e.call("PUT", "/rules/push-otp", map[string]any{"name": "x", "actions": list(map[string]any{"type": "explode"})}, key); code != 400 || len(out["problems"].([]any)) == 0 {
		t.Errorf("invalid %d %v", code, out)
	}
	if code, out = e.call("DELETE", "/rules/push-otp", nil, key); code != 200 || out["deleted"] != "push-otp" {
		t.Error("delete")
	}
	if code, _ = e.call("DELETE", "/rules/push-otp", nil, key); code != 404 {
		t.Error("delete twice")
	}

	// .env rules are read-only, and managed_by cannot be smuggled in.
	envRule := Rule(copyMap(ntfyRuleBody))
	envRule["_id"], envRule["managed_by"] = "env-forward", "env"
	e.st.PutRule(envRule)
	if code, _ = e.call("PUT", "/rules/env-forward", ntfyRuleBody, key); code != 409 {
		t.Error("env put")
	}
	if code, _ = e.call("DELETE", "/rules/env-forward", nil, key); code != 409 {
		t.Error("env delete")
	}
	smuggled := copyMap(ntfyRuleBody)
	smuggled["_id"], smuggled["managed_by"] = "mine", "env"
	if code, _ = e.call("POST", "/rules", smuggled, key); code != 201 {
		t.Error("smuggle create")
	}
	if r, _ := e.st.Rule("mine"); r["managed_by"] != nil {
		t.Error("managed_by smuggled in")
	}
}

func TestDryRunTestAndIMAPEvents(t *testing.T) {
	e := newRouterEnv(t)
	const key = "k-123"
	e.deliver(func(m *Message) { m.To, m.Mail.Subject = []string{"a@example.com"}, "hit" })
	time.Sleep(2 * time.Millisecond)
	e.deliver(func(m *Message) { m.To, m.Mail.Subject = []string{"a@other.test"}, "miss" })
	rule := copyMap(ntfyRuleBody)
	rule["actions"] = list(map[string]any{"type": "ntfy", "topic": "t1", "server": e.web.srv.URL})
	_, out := e.call("POST", "/dry-run", map[string]any{"rule": rule, "limit": 10}, key)
	matched := out["matched"].([]any)
	if out["checked"].(float64) != 2 || len(matched) != 1 || matched[0].(map[string]any)["subject"] != "hit" {
		t.Errorf("dry-run %v", out)
	}
	_, out = e.call("POST", "/test", map[string]any{"rule": rule}, key)
	if res := out["results"].([]any); len(res) != 1 || res[0].(map[string]any)["detail"] != "ntfy id-1" || res[0].(map[string]any)["ok"] != true {
		t.Errorf("test %v", out)
	}
	if e.web.calls[0].Payload["click"] != "https://mail.example" {
		t.Error("click link")
	}
	if code, _ := e.call("POST", "/dry-run", map[string]any{"rule": "x"}, key); code != 400 {
		t.Error("dry-run bad rule")
	}

	// IMAP events: notifications only, duplicates ignored, smtp-only rules skip them.
	e.st.PutRule(Rule{"_id": "ext", "name": "external", "match": map[string]any{"source": list("imap"), "from": list("*@bank.test")},
		"actions": list(map[string]any{"type": "ntfy", "topic": "t1", "server": e.web.srv.URL},
			map[string]any{"type": "forward", "to": list("me@gmail.com"), "from": "a@b.test"}, map[string]any{"type": "trash"})})
	e.st.PutRule(Rule{"_id": "smtp-only", "name": "smtp", "match": map[string]any{}, "actions": list(map[string]any{"type": "mark_read"})})
	event := map[string]any{"account": "Me@Gmail.com", "uidvalidity": 7, "messages": list(
		map[string]any{"uid": 41, "from": map[string]any{"address": "alerts@bank.test", "name": "Bank"}, "subject": "Login code 551234"},
		map[string]any{"uid": 42, "from": map[string]any{"address": "news@shop.test"}, "subject": "Sale"},
		map[string]any{"uid": "bad"})}
	if code, out := e.call("POST", "/events/imap", event, key); code != 202 || out["accepted"].(float64) != 2 {
		t.Errorf("events %d %v", code, out)
	}
	if _, out := e.call("POST", "/events/imap", event, key); out["accepted"].(float64) != 0 {
		t.Error("duplicates accepted")
	}
	if code, _ := e.call("POST", "/events/imap", map[string]any{"account": "nobody", "messages": list(map[string]any{"uid": 1})}, key); code != 400 {
		t.Error("bad account")
	}
	calls := len(e.web.calls)
	for e.r.runOnce() { // the two SMTP messages, then the two events
	}
	var doc string
	e.st.db.QueryRow(`SELECT routing FROM routing_events WHERE uid = 41`).Scan(&doc)
	var bank Routing
	json.Unmarshal([]byte(doc), &bank)
	if bank.Status != "done" || bank.Results["ext:0"].Detail != "ntfy id-1" || bank.Results["ext:1"].Detail != "skipped for IMAP mail" ||
		bank.Results["ext:2"].Detail != "skipped for IMAP mail" {
		t.Errorf("bank event %+v", bank)
	}
	e.st.db.QueryRow(`SELECT routing FROM routing_events WHERE uid = 42`).Scan(&doc)
	if !strings.Contains(doc, `"matched":[]`) {
		t.Errorf("shop event %s", doc)
	}
	if len(e.web.calls) != calls+1 || !strings.Contains(e.web.calls[calls].Payload["message"].(string), "Code: 551234") {
		t.Error("one notification for the bank mail")
	}
	_, out = e.call("GET", "/status?limit=5", nil, key)
	subjects := map[string]bool{}
	for _, row := range out["messages"].([]any) {
		subjects[row.(map[string]any)["subject"].(string)] = true
	}
	if !subjects["Login code 551234"] || !subjects["Sale"] || !subjects["hit"] {
		t.Errorf("status %v", out)
	}
}

// ---- new: SMTP delivery wakes the router; loop guard knows rule targets ----

func TestSMTPDeliveryRoutesAtOnce(t *testing.T) {
	e := newRouterEnv(t)
	e.st.SeedDomains([]string{"test.local"})
	e.st.PutRule(Rule{"_id": "push", "name": "push", "match": map[string]any{},
		"actions": list(map[string]any{"type": "ntfy", "topic": "t", "server": e.web.srv.URL + "/push"},
			map[string]any{"type": "forward", "to": list("me@gmail.com"), "from": "hi@test.local"})})
	e.r.cfg.RouterPoll = time.Hour // only the wake-up can make this pass in time
	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	if err := e.r.Start(ctx); err != nil {
		t.Fatal(err)
	}
	cfg := &Config{Hostname: "mx.test.local", MaxMessageBytes: 1 << 20, MaxAddrLen: 320}
	srv := newSMTPServer(cfg, e.st, e.r)
	l, _ := net.Listen("tcp", "127.0.0.1:0")
	go srv.Serve(l)
	defer srv.Close()

	if err := netsmtp.SendMail(l.Addr().String(), nil, "a@x.cn", []string{"a@test.local"},
		raw([]string{"From: a@x.cn", "Subject: code 135790"}, "hi")); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for e.web.count("/push") == 0 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if e.web.count("/push") != 1 {
		t.Fatal("not routed right after delivery")
	}
	// An auto-reply from the rule's forward target is dropped, ordinary mail from it is kept.
	var before int
	e.st.db.QueryRow(`SELECT count(*) FROM messages`).Scan(&before)
	netsmtp.SendMail(l.Addr().String(), nil, "me@gmail.com", []string{"a@test.local"},
		raw([]string{"From: me@gmail.com", "Subject: Automatic reply: code"}, "away"))
	netsmtp.SendMail(l.Addr().String(), nil, "me@gmail.com", []string{"a@test.local"},
		raw([]string{"From: me@gmail.com", "Subject: a real question"}, "hello"))
	var after int
	e.st.db.QueryRow(`SELECT count(*) FROM messages`).Scan(&after)
	if after != before+1 {
		t.Errorf("loop guard: %d -> %d messages", before, after)
	}
}
