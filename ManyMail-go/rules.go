package main

// Rule validation and matching, ported from router/rules.py. A rule:
//
//	{
//	  "_id": "...", "name": "OTP to phone", "enabled": true, "order": 10, "stop": false,
//	  "match": {
//	    "to": ["otp-*@example.com"],        glob, any of
//	    "from": ["*@github.com"],           glob, any of
//	    "subject": ["verification"],        substring, any of, case-insensitive
//	    "subject_regex": "code\\s*\\d+",    RE2 regex, case-insensitive
//	    "body": ["invoice"],                substring of the text body, any of
//	    "has_attachments": true,
//	    "include_spam": false,
//	    "source": ["smtp", "imap"]          default ["smtp"]: mail received here
//	  },
//	  "actions": [{"type": "forward" | "ntfy" | "telegram" | "webhook" | "tag" | "mark_read" | "trash", ...}]
//	}
//
// Every condition present must hold; inside a list any entry may match. An empty match
// takes all mail received here that is not spam. IMAP events (new mail in external
// accounts) only match rules whose source includes "imap", and only notifications run.

import (
	"fmt"
	"math"
	"regexp"
	"sort"
	"strings"
)

var (
	actionTypes = []string{"forward", "ntfy", "telegram", "webhook", "tag", "mark_read", "trash"}
	notifyTypes = map[string]bool{"ntfy": true, "telegram": true, "webhook": true}
	matchKeys   = toSet([]string{"to", "from", "subject", "subject_regex", "body", "has_attachments", "include_spam", "source"})
	envName     = regexp.MustCompile(`^[A-Z_][A-Z0-9_]*$`)
)

// strFrom is Python's str() for JSON values: numbers without ".0", nil as "".
func strFrom(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	case float64:
		if x == math.Trunc(x) && math.Abs(x) < 1e15 {
			return fmt.Sprintf("%d", int64(x))
		}
	}
	return fmt.Sprint(v)
}

func truthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case string:
		return x != ""
	case float64:
		return x != 0
	case []any:
		return len(x) > 0
	case map[string]any:
		return len(x) > 0
	}
	return true
}

// asList: nil or "" is empty, a list drops its empty entries, anything else is one entry.
func asList(v any) []any {
	switch x := v.(type) {
	case nil:
		return nil
	case string:
		if x == "" {
			return nil
		}
	case []any:
		var out []any
		for _, e := range x {
			if e != nil && e != "" {
				out = append(out, e)
			}
		}
		return out
	}
	return []any{v}
}

func matchOf(r Rule) map[string]any {
	m, _ := r["match"].(map[string]any)
	return m
}

func actionsOf(r Rule) []map[string]any {
	list, _ := r["actions"].([]any)
	var out []map[string]any
	for _, a := range list {
		if m, ok := a.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out
}

func ruleOrder(r Rule) float64 {
	if n, ok := r["order"].(float64); ok {
		return n
	}
	return 100
}

func sortRules(rules []Rule) []Rule {
	sort.SliceStable(rules, func(i, j int) bool {
		if a, b := ruleOrder(rules[i]), ruleOrder(rules[j]); a != b {
			return a < b
		}
		return rules[i].ID() < rules[j].ID()
	})
	return rules
}

// globRegexp translates an fnmatch pattern ("*" crosses "/" too, unlike path.Match).
func globRegexp(pattern string) *regexp.Regexp {
	var b strings.Builder
	b.WriteString("^")
	rs := []rune(pattern)
	for i := 0; i < len(rs); i++ {
		switch c := rs[i]; c {
		case '*':
			b.WriteString(".*")
		case '?':
			b.WriteString(".")
		case '[':
			j := i + 1
			if j < len(rs) && rs[j] == '!' {
				j++
			}
			if j < len(rs) && rs[j] == ']' {
				j++
			}
			for j < len(rs) && rs[j] != ']' {
				j++
			}
			if j >= len(rs) { // no closing bracket: a literal "["
				b.WriteString(`\[`)
				continue
			}
			class := string(rs[i+1 : j])
			if strings.HasPrefix(class, "!") {
				class = "^" + class[1:]
			} else if strings.HasPrefix(class, "^") {
				class = `\` + class
			}
			b.WriteString("[" + strings.ReplaceAll(class, `\`, `\\`) + "]")
			i = j
		default:
			b.WriteString(regexp.QuoteMeta(string(c)))
		}
	}
	b.WriteString("$")
	re, err := regexp.Compile("(?s)" + b.String())
	if err != nil {
		return regexp.MustCompile(`^` + regexp.QuoteMeta(pattern) + `$`)
	}
	return re
}

func globAny(patterns []any, values []string) bool {
	for _, p := range patterns {
		re := globRegexp(strings.ToLower(strings.TrimSpace(strFrom(p))))
		for _, v := range values {
			if v = strings.ToLower(strings.TrimSpace(v)); v != "" && re.MatchString(v) {
				return true
			}
		}
	}
	return false
}

func containsAny(needles []any, haystack string) bool {
	haystack = strings.ToLower(haystack)
	for _, n := range needles {
		if strings.Contains(haystack, strings.ToLower(strFrom(n))) {
			return true
		}
	}
	return false
}

func validEmail(v any) bool {
	text := strFrom(v)
	if strings.Contains(text, "<") && strings.HasSuffix(text, ">") {
		text = text[strings.LastIndex(text, "<")+1 : len(text)-1]
	}
	return strings.Contains(text, "@") && !strings.Contains(strings.TrimSpace(text), " ")
}

func compileSubjectRegex(p string) (*regexp.Regexp, error) { return regexp.Compile("(?i)" + p) }

// validateRule returns human-readable problems; empty means the rule is usable.
func validateRule(rule Rule) []string {
	errs := []string{}
	if strings.TrimSpace(strFrom(rule["name"])) == "" {
		errs = append(errs, "name is required")
	}
	match := map[string]any{}
	if raw, ok := rule["match"]; ok && truthy(raw) {
		if m, ok := raw.(map[string]any); ok {
			match = m
		} else {
			errs = append(errs, "match must be an object")
		}
	}
	var unknown []string
	for k := range match {
		if !matchKeys[k] {
			unknown = append(unknown, k)
		}
	}
	if len(unknown) > 0 {
		sort.Strings(unknown)
		errs = append(errs, "unknown match keys: "+strings.Join(unknown, ", "))
	}
	for _, s := range asList(match["source"]) {
		if s != "smtp" && s != "imap" {
			errs = append(errs, "match.source must be smtp and/or imap")
			break
		}
	}
	if truthy(match["subject_regex"]) {
		if _, err := compileSubjectRegex(strFrom(match["subject_regex"])); err != nil {
			errs = append(errs, "subject_regex is not a valid regex: "+err.Error())
		}
	}

	list, ok := rule["actions"].([]any)
	if !ok || len(list) == 0 {
		return append(errs, "actions must be a non-empty list")
	}
	for i, raw := range list {
		prefix := fmt.Sprintf("actions[%d]", i)
		a, ok := raw.(map[string]any)
		if !ok {
			errs = append(errs, prefix+" must be an object")
			continue
		}
		kind := strFrom(a["type"])
		if _, isStr := a["type"].(string); !isStr || !contains(actionTypes, kind) {
			errs = append(errs, prefix+".type must be one of "+strings.Join(actionTypes, ", "))
			continue
		}
		for _, key := range []string{"api_key_env", "token_env", "bot_token_env", "secret_env"} {
			if truthy(a[key]) && !envName.MatchString(strFrom(a[key])) {
				errs = append(errs, prefix+"."+key+" must be an environment variable name")
			}
		}
		switch kind {
		case "forward":
			targets := asList(a["to"])
			ok := len(targets) > 0
			for _, t := range targets {
				ok = ok && validEmail(t)
			}
			if !ok {
				errs = append(errs, prefix+".to needs one or more email addresses")
			}
			if !validEmail(a["from"]) {
				errs = append(errs, prefix+".from needs a sender address on a Resend-verified domain")
			}
		case "ntfy":
			if strings.TrimSpace(strFrom(a["topic"])) == "" {
				errs = append(errs, prefix+".topic is required")
			}
			server := strFrom(a["server"])
			if server == "" {
				server = "https://ntfy.sh"
			}
			if !strings.HasPrefix(server, "http://") && !strings.HasPrefix(server, "https://") {
				errs = append(errs, prefix+".server must be an http(s) URL")
			}
		case "telegram":
			if strings.TrimSpace(strFrom(a["chat_id"])) == "" {
				errs = append(errs, prefix+".chat_id is required")
			}
		case "webhook":
			if u := strFrom(a["url"]); !strings.HasPrefix(u, "http://") && !strings.HasPrefix(u, "https://") {
				errs = append(errs, prefix+".url must be an http(s) URL")
			}
		case "tag":
			if len(asList(a["tags"])) == 0 {
				errs = append(errs, prefix+".tags needs at least one tag")
			}
		}
	}
	return errs
}

func ruleMatches(rule Rule, m *RouteMsg) bool {
	if v, set := rule["enabled"]; set && !truthy(v) {
		return false
	}
	match := matchOf(rule)
	sources := asList(match["source"])
	if len(sources) == 0 {
		sources = []any{"smtp"}
	}
	found := false
	for _, s := range sources {
		found = found || s == m.Source
	}
	if !found {
		return false
	}
	// Spam is stored in the trash; anything else deleted before routing ran is skipped.
	if m.Deleted && !(m.IsSpam && truthy(match["include_spam"])) {
		return false
	}
	if p := asList(match["to"]); len(p) > 0 && !globAny(p, m.To) {
		return false
	}
	if p := asList(match["from"]); len(p) > 0 && !globAny(p, []string{m.FromAddress}) {
		return false
	}
	if n := asList(match["subject"]); len(n) > 0 && !containsAny(n, m.Subject) {
		return false
	}
	if truthy(match["subject_regex"]) {
		re, err := compileSubjectRegex(strFrom(match["subject_regex"]))
		if err != nil || !re.MatchString(m.Subject) {
			return false
		}
	}
	body := m.Text
	if body == "" {
		body = m.Intro
	}
	if n := asList(match["body"]); len(n) > 0 && !containsAny(n, body) {
		return false
	}
	if v, set := match["has_attachments"]; set && v != nil && truthy(v) != m.HasAtt {
		return false
	}
	return true
}

// selectRules: the rules that apply, in order; a matching rule with stop=true ends the list.
func selectRules(rules []Rule, m *RouteMsg) []Rule {
	var out []Rule
	for _, r := range sortRules(append([]Rule{}, rules...)) {
		if ruleMatches(r, m) {
			out = append(out, r)
			if truthy(r["stop"]) {
				break
			}
		}
	}
	return out
}
