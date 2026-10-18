package main

// Regressions from the 2026-10-18 code review.

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
	"time"
)

func TestNestedAttachedMessagesStayCheap(t *testing.T) {
	inner := "Subject: x\r\n\r\n"
	for i := 0; i < 4000; i++ {
		b := fmt.Sprintf("b%d", i)
		inner = "MIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=" + b + "\r\n\r\n--" + b +
			"\r\nContent-Type: message/rfc822\r\n\r\n" + inner + "\r\n--" + b + "--\r\n"
	}
	start := time.Now()
	parseMessage([]byte("From: a@b.c\r\n" + inner))
	if d := time.Since(start); d > 300*time.Millisecond {
		t.Errorf("4000 nested messages took %v", d)
	}
}

func TestBase64PaddedPerLine(t *testing.T) {
	h := map[string][]string{"Content-Transfer-Encoding": {"base64"}}
	if got := string(decodeCTE(h, []byte("QQ==\r\nQg==\r\n"))); got != "AB" {
		t.Errorf("got %q", got)
	}
	if got := string(decodeCTE(h, []byte("aGVs\r\nbG8=\r\n"))); got != "hello" {
		t.Errorf("plain: %q", got)
	}
	// Lines wrapped at a length that is not a multiple of 4.
	if got := string(decodeCTE(h, []byte("aGVsb\r\nG8gd29\r\nybGQh\r\n"))); got != "hello world!" {
		t.Errorf("odd wrap: %q", got)
	}
}

func TestRateTablesShrink(t *testing.T) {
	store, now := map[string][]time.Time{}, time.Now()
	for i := 0; i < 5000; i++ {
		hit(store, fmt.Sprint(i), time.Minute, 10, now)
	}
	hit(store, "new", time.Minute, 10, now.Add(2*time.Minute))
	if len(store) > 1 {
		t.Errorf("%d stale keys kept", len(store))
	}
}

func TestStartFromFormats(t *testing.T) {
	for _, v := range []string{"2025-06-01", "2025-06-01T08:00:00", "2025-06-01T08:00:00+08:00"} {
		e := newRouterEnv(t) // its own store, router_since already set by now
		e.st.db.Exec(`DELETE FROM kv`)
		e.env["ROUTER_START_FROM"] = v
		got, err := e.r.startTime()
		if err != nil || got.Year() != 2025 {
			t.Errorf("%s: %v %v", v, got, err)
		}
		// Later starts ignore the variable, even a broken one.
		e.env["ROUTER_START_FROM"] = "not a date"
		if again, err := e.r.startTime(); err != nil || !again.Equal(got) {
			t.Errorf("restart with %s: %v %v", v, again, err)
		}
	}
}

func TestRoutingSavedAfterEachAction(t *testing.T) {
	e := newRouterEnv(t)
	id := e.deliver()
	seen := ""
	hook := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = e.routing(id).Results["r:0"].Status // what a crash right now would leave behind
	}))
	defer hook.Close()
	rule := Rule{"_id": "r", "name": "r", "match": map[string]any{}, "actions": list(
		map[string]any{"type": "ntfy", "topic": "t", "server": e.web.srv.URL},
		map[string]any{"type": "webhook", "url": hook.URL})}
	if s := e.step(rule); s != "done" {
		t.Fatal(s)
	}
	if seen != "done" {
		t.Errorf("first action not saved before the second ran: %q", seen)
	}
}

func TestBatchTooManyIDs(t *testing.T) {
	e := newEnv(t)
	tok := e.account("user@test.local")
	ids := make([]string, 5000)
	for i := range ids {
		ids[i] = newID()
	}
	if code, _ := e.do("POST", "/messages/batch", tok, map[string]any{"action": "delete", "ids": ids}); code != 422 {
		t.Errorf("got %d", code)
	}
}

func TestViewerReviewFixes(t *testing.T) {
	e := newViewerEnv(t)
	e.login()
	// JSON APIs refuse other content types (a cross-site form can only send those).
	if resp, _ := e.req("POST", "/api/domains", `{"domain":"csrf.test"}`); resp.StatusCode != 415 {
		t.Errorf("text/plain body: %d", resp.StatusCode)
	}
	// A path that decodes to an invalid URL is a 400, not a panic.
	// (the bridge is not running here, so 502; what matters is no panic and no decoding)
	if resp, _ := e.req("GET", "/imap/a%25zz", nil); resp.StatusCode != 502 {
		t.Errorf("imap bad path: %d", resp.StatusCode)
	}
	// Short .env keys do not crash the settings page.
	e.v.cfg.ResendAPIKey = "abc"
	if resp, _ := e.req("GET", "/api/settings/sender-keys", nil); resp.StatusCode != 200 {
		t.Errorf("short key: %d", resp.StatusCode)
	}
	// Attachments are served inert.
	att := Attachment{ID: newID(), Filename: "x.html", ContentType: "text/html", Content: []byte("<b>x</b>")}
	e.st.CreateAccount(newID(), "a@test.local", pyBcryptHash, time.Now())
	id := e.deliver([]string{"a@test.local"}, "s", "t", "", att)
	resp, _ := e.req("GET", "/api/inbox/attachment/"+id+"/"+att.ID+"?email=a@test.local&password=pw-from-python", nil)
	if resp.Header.Get("X-Content-Type-Options") != "nosniff" || !strings.Contains(resp.Header.Get("Content-Security-Policy"), "sandbox") {
		t.Errorf("attachment headers: %d %v", resp.StatusCode, resp.Header)
	}
	// Changing ACCESS_PASSWORD ends existing sessions.
	e.v.cfg.AccessPassword = "new-pass"
	if resp, _ := e.req("GET", "/", nil); resp.StatusCode != 302 {
		t.Errorf("old session after password change: %d", resp.StatusCode)
	}
}

func TestSanitizeReviewFixes(t *testing.T) {
	out := sanitizeEmailHTML(`<a href="https://x.test" target="_blank" rel="opener">x</a>`)
	if strings.Contains(out, "opener\"") || !strings.Contains(out, `rel="noopener noreferrer"`) {
		t.Errorf("rel: %q", out)
	}
	if out := sanitizeStylesheet(`div{font:is(*){position:fixed;inset:0}}`, 0); strings.Contains(out, "position") || strings.Count(out, "{") != strings.Count(out, "}") {
		t.Errorf("nested css: %q", out)
	}
	for _, ip := range []string{"::1%lo", "::7f00:1", "fe80::1%eth0"} {
		if isPublicIP(netip.MustParseAddr(ip)) {
			t.Errorf("%s counted as public", ip)
		}
	}
}
