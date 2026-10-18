package main

// Ported from mail-service/tests/test_api.py, test_sender_keys.py and the API part of test_dnscheck.py.

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const testSecret = "test-secret-key-for-ci"

// Issued by PyJWT 2.10.1 with testSecret, exp in 2100: tokens from the Python service keep working.
const pyJWTToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhY2NvdW50X2lkIjoiNjUyZjAwMDAwMDAwMDAwMDAwMDAwMDAxIiwiYWRkcmVzcyI6InB5QHRlc3QubG9jYWwiLCJleHAiOjQxMDI0NDQ4MDB9.Nnquz717mX-wK-kp3tKgJj0lrJRF1cvdtNRYxBmKmIA"

// Hash made by Python bcrypt for "pw-from-python": accounts migrated from MongoDB can log in.
const pyBcryptHash = "$2b$04$gTZxTw8HHw2n5/k3OAd94OVKv9wX3magljICbisd0EcgL8DFo5nCW"

type env_ struct {
	t   *testing.T
	st  *Store
	api *api
	srv *httptest.Server
}

func newEnv(t *testing.T) *env_ {
	st, err := openStore(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	if err := st.SeedDomains([]string{"test.local", "example.test"}); err != nil {
		t.Fatal(err)
	}
	cfg := &Config{JWTSecret: testSecret, APIKey: "test-api-key", HealthDetails: true, CORSOrigins: []string{"*"},
		Domains: []string{"test.local", "example.test"}, Hostname: "mail.test.local"}
	a := newAPI(cfg, st)
	a.lookup = func(string, string) ([]string, error) { return nil, nil }
	a.detectIP = func() string { return "" }
	srv := httptest.NewServer(a.routes())
	t.Cleanup(srv.Close)
	return &env_{t, st, a, srv}
}

// do sends a request; auth is a JWT, "key:<api key>", or "".
func (e *env_) do(method, path, auth string, body any) (int, map[string]any) {
	e.t.Helper()
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, e.srv.URL+path, rd)
	if strings.HasPrefix(auth, "key:") {
		req.Header.Set("X-API-Key", auth[4:])
	} else if auth != "" {
		req.Header.Set("Authorization", "Bearer "+auth)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer resp.Body.Close()
	var out map[string]any
	json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

func (e *env_) account(addr string) string {
	e.t.Helper()
	if code, out := e.do("POST", "/accounts", "", map[string]string{"address": addr, "password": "pw"}); code != 201 {
		e.t.Fatalf("create %s: %d %v", addr, code, out)
	}
	code, out := e.do("POST", "/token", "", map[string]string{"address": addr, "password": "pw"})
	if code != 200 {
		e.t.Fatalf("login %s: %d %v", addr, code, out)
	}
	return out["token"].(string)
}

// deliver stores a message like the SMTP path does and returns its id.
func (e *env_) deliver(to []string, subject, text, html string, atts ...Attachment) string {
	e.t.Helper()
	m := &Message{ID: newID(), To: to, Size: 100, CreatedAt: time.Now().UTC(),
		Mail: &Parsed{FromAddress: "sender@example.com", FromName: "Sender", Subject: subject, Text: text, HTML: html, Attachments: atts}}
	if err := e.st.InsertMessage(m); err != nil {
		e.t.Fatal(err)
	}
	time.Sleep(2 * time.Millisecond) // distinct created_at for ordering
	return m.ID
}

func members(out map[string]any) []map[string]any {
	var list []map[string]any
	for _, m := range out["hydra:member"].([]any) {
		list = append(list, m.(map[string]any))
	}
	return list
}

func TestHealthAndDomains(t *testing.T) {
	e := newEnv(t)
	if code, out := e.do("GET", "/health", "", nil); code != 200 || out["status"] != "ok" {
		t.Errorf("health %d %v", code, out)
	}
	_, out := e.do("GET", "/domains", "", nil)
	if ms := members(out); len(ms) != 2 || ms[0]["domain"] != "test.local" || ms[0]["@id"] != "/domains/test.local" {
		t.Errorf("domains %v", out)
	}
}

func TestAdminDomains(t *testing.T) {
	e := newEnv(t)
	if code, _ := e.do("POST", "/admin/domains", "", map[string]string{"domain": "new.test"}); code != 403 {
		t.Errorf("no key: %d", code)
	}
	key := "key:test-api-key"
	if code, _ := e.do("POST", "/admin/domains", key, map[string]string{"domain": "New.Test"}); code != 201 {
		t.Errorf("add: %d", code)
	}
	if code, _ := e.do("POST", "/admin/domains", key, map[string]string{"domain": "new.test"}); code != 409 {
		t.Errorf("dup: %d", code)
	}
	if code, _ := e.do("POST", "/admin/domains", key, map[string]string{"domain": "nodot"}); code != 422 {
		t.Errorf("bad: %d", code)
	}
	if code, _ := e.do("DELETE", "/admin/domains/new.test", key, nil); code != 200 {
		t.Errorf("delete: %d", code)
	}
	if code, _ := e.do("DELETE", "/admin/domains/missing.test", key, nil); code != 404 {
		t.Errorf("delete missing: %d", code)
	}
	if code, out := e.do("POST", "/admin/domains", key, map[string]string{"domain": "new.test"}); code != 200 ||
		!strings.Contains(out["message"].(string), "reactivated") {
		t.Errorf("reactivate: %d %v", code, out)
	}
	_, out := e.do("GET", "/admin/domains", "Bearer-less", nil)
	if out["detail"] != "Invalid or missing API key" {
		t.Errorf("bearer junk accepted: %v", out)
	}
	_, out = e.do("GET", "/admin/domains", "test-api-key", nil) // Authorization: Bearer <key> also works
	if len(out["domains"].([]any)) != 3 {
		t.Errorf("list %v", out)
	}
}

func TestAccountsAndLogin(t *testing.T) {
	e := newEnv(t)
	code, out := e.do("POST", "/accounts", "", map[string]string{"address": " User@Test.Local ", "password": "pw"})
	if code != 201 || out["address"] != "user@test.local" || out["isActive"] != true || len(out["id"].(string)) != 24 {
		t.Errorf("create %d %v", code, out)
	}
	for name, body := range map[string]map[string]string{
		"missing":   {"address": "x@test.local"},
		"no at":     {"address": "nope", "password": "pw"},
		"domain":    {"address": "x@other.com", "password": "pw"},
		"duplicate": {"address": "user@test.local", "password": "pw"},
	} {
		if code, out := e.do("POST", "/accounts", "", body); code != 422 || out["detail"].(map[string]any)["hydra:description"] == nil {
			t.Errorf("%s: %d %v", name, code, out)
		}
	}
	if code, out := e.do("POST", "/token", "", map[string]string{"address": "USER@test.local", "password": "pw"}); code != 200 || out["token"] == "" {
		t.Errorf("login %d %v", code, out)
	}
	if code, _ := e.do("POST", "/token", "", map[string]string{"address": "user@test.local", "password": "bad"}); code != 401 {
		t.Errorf("wrong password %d", code)
	}
	if code, _ := e.do("POST", "/token", "", map[string]string{"address": "ghost@test.local", "password": "pw"}); code != 401 {
		t.Errorf("ghost %d", code)
	}

	// Account carried over from MongoDB with a Python bcrypt hash.
	if err := e.st.CreateAccount(newID(), "py@test.local", pyBcryptHash, time.Now()); err != nil {
		t.Fatal(err)
	}
	if code, _ := e.do("POST", "/token", "", map[string]string{"address": "py@test.local", "password": "pw-from-python"}); code != 200 {
		t.Errorf("python bcrypt hash: %d", code)
	}
}

func TestTokens(t *testing.T) {
	e := newEnv(t)
	if code, out := e.do("GET", "/messages", "", nil); code != 401 || out["detail"] != "Missing or invalid token" {
		t.Errorf("missing: %d %v", code, out)
	}
	if code, out := e.do("GET", "/messages", "abc.def.ghi", nil); code != 401 || out["detail"] != "Invalid token" {
		t.Errorf("invalid: %d %v", code, out)
	}
	// Tampered signature.
	tok := e.api.createToken("1", "a@test.local")
	if code, _ := e.do("GET", "/messages", tok[:len(tok)-2]+"xx", nil); code != 401 {
		t.Errorf("tampered: %d", code)
	}
	// Expired.
	header := b64.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))
	payload := b64.EncodeToString([]byte(`{"address":"a@test.local","exp":1000}`))
	expired := header + "." + payload + "." + b64.EncodeToString(e.api.sign(header+"."+payload))
	if code, out := e.do("GET", "/messages", expired, nil); code != 401 || out["detail"] != "Token expired" {
		t.Errorf("expired: %d %v", code, out)
	}
	// alg=none is refused even with a valid-looking body.
	none := b64.EncodeToString([]byte(`{"alg":"none"}`)) + "." + payload + "."
	if code, _ := e.do("GET", "/messages", none, nil); code != 401 {
		t.Errorf("alg none: %d", code)
	}
	// Token from the Python service.
	e.deliver([]string{"py@test.local"}, "hi", "x", "")
	if code, out := e.do("GET", "/messages", pyJWTToken, nil); code != 200 || out["hydra:totalItems"].(float64) != 1 {
		t.Errorf("pyjwt token: %d %v", code, out)
	}
}

func TestMessages(t *testing.T) {
	e := newEnv(t)
	tok := e.account("user@test.local")
	other := e.account("other@test.local")

	if _, out := e.do("GET", "/messages", tok, nil); out["hydra:totalItems"].(float64) != 0 || len(out["hydra:member"].([]any)) != 0 {
		t.Errorf("empty: %v", out)
	}
	var ids []string
	for i := 0; i < 5; i++ {
		ids = append(ids, e.deliver([]string{"user@test.local", "cc@test.local"}, "Subject "+string(rune('A'+i)), "body", ""))
	}
	e.deliver([]string{"other@test.local"}, "not yours", "x", "")

	_, out := e.do("GET", "/messages?limit=2&offset=1", tok, nil)
	list := members(out)
	if out["hydra:totalItems"].(float64) != 5 || len(list) != 2 || list[0]["subject"] != "Subject D" || out["limit"].(float64) != 2 {
		t.Errorf("page: %v", out)
	}
	m := list[0]
	to := m["to"].([]any)
	if m["@type"] != "Message" || m["msgid"] != m["id"] || len(to) != 2 || to[0].(map[string]any)["address"] != "user@test.local" ||
		m["from"].(map[string]any)["name"] != "Sender" || !strings.HasSuffix(m["createdAt"].(string), "Z") || m["text"] != nil {
		t.Errorf("list item shape: %v", m)
	}
	if code, _ := e.do("GET", "/messages?limit=x", tok, nil); code != 422 {
		t.Errorf("bad limit %d", code)
	}

	// Detail marks seen; the response still shows the state before this read.
	code, d := e.do("GET", "/messages/"+strings.ToUpper(ids[0]), tok, nil)
	if code != 200 || d["seen"] != false || d["text"] != "body" || d["html"] != "" || len(d["attachments"].([]any)) != 0 {
		t.Errorf("detail %d %v", code, d)
	}
	if _, d = e.do("GET", "/messages/"+ids[0], tok, nil); d["seen"] != true {
		t.Errorf("not marked seen: %v", d)
	}
	if code, _ := e.do("GET", "/messages/"+ids[0], other, nil); code != 404 {
		t.Errorf("other user can read: %d", code)
	}
	if code, _ := e.do("GET", "/messages/nope", tok, nil); code != 404 {
		t.Errorf("bad id: %d", code)
	}

	// Trash, restore, permanent delete.
	if code, _ := e.do("DELETE", "/messages/"+ids[1], other, nil); code != 404 {
		t.Errorf("other user can delete: %d", code)
	}
	if code, _ := e.do("DELETE", "/messages/"+ids[1], tok, nil); code != 200 {
		t.Errorf("delete: %d", code)
	}
	if code, _ := e.do("DELETE", "/messages/"+ids[2]+"/permanent", tok, nil); code != 404 {
		t.Errorf("permanent delete outside trash: %d", code)
	}
	_, out = e.do("GET", "/messages/trash", tok, nil)
	if l := members(out); len(l) != 1 || l[0]["id"] != ids[1] || l[0]["isDeleted"] != true {
		t.Errorf("trash: %v", out)
	}
	if _, out = e.do("GET", "/messages", tok, nil); out["hydra:totalItems"].(float64) != 4 {
		t.Errorf("inbox after delete: %v", out)
	}
	if code, _ := e.do("POST", "/messages/"+ids[1]+"/restore", tok, nil); code != 200 {
		t.Errorf("restore: %d", code)
	}
	if code, _ := e.do("POST", "/messages/"+ids[1]+"/restore", tok, nil); code != 404 {
		t.Errorf("restore twice: %d", code)
	}
	e.do("DELETE", "/messages/"+ids[1], tok, nil)
	if code, _ := e.do("DELETE", "/messages/"+ids[1]+"/permanent", tok, nil); code != 200 {
		t.Errorf("permanent: %d", code)
	}
	var left int
	e.st.db.QueryRow(`SELECT count(*) FROM message_to WHERE message_id = ?`, ids[1]).Scan(&left)
	if left != 0 {
		t.Errorf("permanent delete left recipients")
	}

	// Batch.
	if _, out = e.do("POST", "/messages/batch", tok, map[string]any{"action": "mark_read", "message_ids": ids[2:4]}); out["count"].(float64) != 2 {
		t.Errorf("mark_read: %v", out)
	}
	if _, out = e.do("POST", "/messages/batch", tok, map[string]any{"action": "delete", "ids": append([]string{"junk"}, ids[2:4]...)}); out["count"].(float64) != 2 {
		t.Errorf("batch delete: %v", out)
	}
	if _, out = e.do("POST", "/messages/batch", tok, map[string]any{"action": "restore", "ids": ids[2:5]}); out["count"].(float64) != 2 {
		t.Errorf("batch restore only trash: %v", out)
	}
	if code, _ := e.do("POST", "/messages/batch", tok, map[string]any{"action": "explode", "ids": ids[2:3]}); code != 422 {
		t.Errorf("unknown action: %d", code)
	}
	if code, _ := e.do("POST", "/messages/batch", tok, map[string]any{"action": "delete", "ids": []string{"junk"}}); code != 422 {
		t.Errorf("no valid ids: %d", code)
	}
	if _, out = e.do("POST", "/messages/batch", other, map[string]any{"action": "delete", "ids": ids}); out["count"].(float64) != 0 {
		t.Errorf("other user batch: %v", out)
	}
}

func TestSearch(t *testing.T) {
	e := newEnv(t)
	tok := e.account("user@test.local")
	e.deliver([]string{"user@test.local"}, "Your Code", "nothing", "")
	e.deliver([]string{"user@test.local"}, "plain", "price is 100% (a.b)", "")
	e.deliver([]string{"user@test.local"}, "html", "", "<p>验证码 654321</p>")
	e.deliver([]string{"user@test.local"}, "under_score", "x", "")
	e.deliver([]string{"other@test.local"}, "your code", "", "")

	for q, want := range map[string]int{"your code": 1, "100% (a.b)": 1, "654321": 1, "验证码": 1, "%": 1, "_": 1, "SENDER": 5 - 1, " ": 0} {
		_, out := e.do("GET", "/messages/search?q="+urlQuery(q), tok, nil)
		if got := len(out["hydra:member"].([]any)); got != want {
			t.Errorf("q=%q: %d results, want %d", q, got, want)
		}
	}
}

func urlQuery(s string) string {
	return strings.NewReplacer("%", "%25", " ", "+", "(", "%28", ")", "%29").Replace(s)
}

func TestAttachmentDownload(t *testing.T) {
	e := newEnv(t)
	tok := e.account("user@test.local")
	other := e.account("other@test.local")
	att := Attachment{ID: newID(), Filename: "合同 v1.pdf", ContentType: "application/pdf", Content: []byte("%PDF-1.4")}
	id := e.deliver([]string{"user@test.local"}, "doc", "see file", "", att)

	_, d := e.do("GET", "/messages/"+id, tok, nil)
	meta := d["attachments"].([]any)[0].(map[string]any)
	if d["hasAttachments"] != true || meta["filename"] != "合同 v1.pdf" || meta["contentType"] != "application/pdf" ||
		meta["content_type"] != "application/pdf" || meta["size"].(float64) != 8 || meta["downloadUrl"] != "/messages/"+id+"/attachments/"+att.ID {
		t.Errorf("meta %v", meta)
	}
	req, _ := http.NewRequest("GET", e.srv.URL+meta["downloadUrl"].(string), nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if string(body) != "%PDF-1.4" || resp.Header.Get("Content-Type") != "application/pdf" ||
		resp.Header.Get("Content-Disposition") != "attachment; filename*=UTF-8''%E5%90%88%E5%90%8C%20v1.pdf" {
		t.Errorf("download: %q %v", body, resp.Header)
	}
	if code, out := e.do("GET", "/messages/"+id+"/attachments/"+att.ID, other, nil); code != 404 || out["detail"] != "Message not found" {
		t.Errorf("other user download: %d %v", code, out)
	}
	if code, out := e.do("GET", "/messages/"+id+"/attachments/nope", tok, nil); code != 404 || out["detail"] != "Attachment not found" {
		t.Errorf("missing attachment: %d %v", code, out)
	}
}

func TestSentMessages(t *testing.T) {
	e := newEnv(t)
	tok := e.account("user@test.local")
	key := "key:test-api-key"
	if code, _ := e.do("POST", "/admin/sent", "", map[string]any{"from_address": "user@test.local", "to": "x@y.z"}); code != 403 {
		t.Errorf("no key: %d", code)
	}
	if code, _ := e.do("POST", "/admin/sent", key, map[string]any{"from_address": "user@test.local", "to": []string{}}); code != 422 {
		t.Errorf("empty to: %d", code)
	}
	code, out := e.do("POST", "/admin/sent", key, map[string]any{"from_address": "User@test.local", "to": "x@y.z",
		"subject": "Hi", "text": "t", "html": "<b>h</b>", "resend_id": "re_1"})
	if code != 201 || out["message"] != "Stored" {
		t.Fatalf("store: %d %v", code, out)
	}
	id := out["id"].(string)
	e.do("POST", "/admin/sent", key, map[string]any{"from_address": "other@test.local", "to": []string{"a@b.c"}})

	_, out = e.do("GET", "/sent", tok, nil)
	l := members(out)
	if out["hydra:totalItems"].(float64) != 1 || out["limit"].(float64) != 100 || l[0]["to"].([]any)[0] != "x@y.z" || l[0]["html"] != "<b>h</b>" {
		t.Errorf("list %v", out)
	}
	if code, d := e.do("GET", "/sent/"+id, tok, nil); code != 200 || d["resend_id"] != "re_1" || d["subject"] != "Hi" {
		t.Errorf("detail %d %v", code, d)
	}
	if code, _ := e.do("GET", "/sent/"+id, e.account("other@test.local"), nil); code != 404 {
		t.Errorf("other user sees sent: %d", code)
	}
}

func TestSenderKeys(t *testing.T) {
	e := newEnv(t)
	key := "key:test-api-key"
	if code, _ := e.do("GET", "/admin/sender-keys", "", nil); code != 403 {
		t.Errorf("no key: %d", code)
	}
	if code, _ := e.do("PUT", "/admin/sender-keys/Example.COM.", key, map[string]string{"ciphertext": "gAAA", "hint": strings.Repeat("h", 50)}); code != 200 {
		t.Errorf("put: %d", code)
	}
	_, out := e.do("GET", "/admin/sender-keys", key, nil)
	k := out["keys"].([]any)[0].(map[string]any)
	if k["domain"] != "example.com" || k["ciphertext"] != "gAAA" || len(k["hint"].(string)) != 40 || k["updated_at"] == nil {
		t.Errorf("list %v", out)
	}
	if code, _ := e.do("PUT", "/admin/sender-keys/bad_domain", key, map[string]string{"ciphertext": "x"}); code != 400 {
		t.Errorf("bad domain: %d", code)
	}
	if code, _ := e.do("PUT", "/admin/sender-keys/example.com", key, map[string]string{"ciphertext": ""}); code != 400 {
		t.Errorf("empty ciphertext: %d", code)
	}
	if code, _ := e.do("DELETE", "/admin/sender-keys/example.com", key, nil); code != 200 {
		t.Errorf("delete: %d", code)
	}
	if code, _ := e.do("DELETE", "/admin/sender-keys/example.com", key, nil); code != 404 {
		t.Errorf("delete twice: %d", code)
	}
}

func TestDNSCheckEndpoint(t *testing.T) {
	e := newEnv(t)
	var seen []string
	e.api.lookup = func(name, rtype string) ([]string, error) {
		if rtype == "MX" {
			seen = append(seen, name)
		}
		return nil, nil
	}
	if code, _ := e.do("GET", "/admin/dns-check?ip=203.0.113.7", "", nil); code != 403 {
		t.Errorf("no key: %d", code)
	}
	key := "key:test-api-key"
	if code, _ := e.do("GET", "/admin/dns-check?ip=nope", key, nil); code != 400 {
		t.Errorf("bad ip: %d", code)
	}
	code, out := e.do("GET", "/admin/dns-check?ip=203.0.113.7", key, nil)
	if code != 200 || out["ip"] != "203.0.113.7" || strings.Join(seen, ",") != "example.test,test.local" {
		t.Errorf("check %d ip=%v domains=%v", code, out["ip"], seen)
	}
	if _, out = e.do("GET", "/admin/dns-check", key, nil); out["ip"] != nil {
		t.Errorf("undetectable ip should be null: %v", out["ip"])
	}
}

func TestCORSAndRateLimit(t *testing.T) {
	e := newEnv(t)
	req, _ := http.NewRequest("OPTIONS", e.srv.URL+"/messages", nil)
	req.Header.Set("Origin", "https://mail.example.com")
	req.Header.Set("Access-Control-Request-Method", "GET")
	req.Header.Set("Access-Control-Request-Headers", "authorization")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 200 || resp.Header.Get("Access-Control-Allow-Origin") != "*" || resp.Header.Get("Access-Control-Allow-Headers") != "authorization" {
		t.Errorf("preflight %d %v", resp.StatusCode, resp.Header)
	}

	e.api.cfg.CORSOrigins = []string{"https://ok.example"}
	h := e.api.routes()
	rec := httptest.NewRecorder()
	r := httptest.NewRequest("OPTIONS", "/messages", nil)
	r.Header.Set("Origin", "https://evil.example")
	r.Header.Set("Access-Control-Request-Method", "GET")
	h.ServeHTTP(rec, r)
	if rec.Code != 400 {
		t.Errorf("disallowed origin preflight: %d", rec.Code)
	}

	// Rate limit applies to public clients only.
	e.api.cfg.RateLimitMax, e.api.cfg.RateLimitWindow = 2, time.Minute
	codes := []int{}
	for i := 0; i < 3; i++ {
		rec := httptest.NewRecorder()
		r := httptest.NewRequest("POST", "/token", strings.NewReader(`{"address":"a@test.local","password":"x"}`))
		r.RemoteAddr = "203.0.113.9:4000"
		h.ServeHTTP(rec, r)
		codes = append(codes, rec.Code)
	}
	if codes[0] != 401 || codes[2] != 429 {
		t.Errorf("rate limit codes %v", codes)
	}
	rec = httptest.NewRecorder()
	r = httptest.NewRequest("POST", "/token", strings.NewReader(`{"address":"a@test.local","password":"x"}`))
	r.RemoteAddr = "172.18.0.4:4000"
	h.ServeHTTP(rec, r)
	if rec.Code != 401 {
		t.Errorf("internal client limited: %d", rec.Code)
	}
}

func TestProductionConfigCheck(t *testing.T) {
	ok := &Config{Production: true, JWTSecret: "s", APIKey: "k", CORSOrigins: []string{"https://x"},
		SecretKey: "sk", AccessPassword: "ap", UnifiedPassword: "up"}
	if err := ok.check(); err != nil {
		t.Error(err)
	}
	for _, bad := range []Config{
		{Production: true, JWTSecret: defaultJWTSecret, APIKey: "k", CORSOrigins: []string{"x"}},
		{Production: true, JWTSecret: "s", CORSOrigins: []string{"x"}},
		{Production: true, JWTSecret: "s", APIKey: "k"},
		{Production: true, JWTSecret: "s", APIKey: "k", CORSOrigins: []string{"x"}, SecretKey: defaultSecretKey, AccessPassword: "ap", UnifiedPassword: "up"},
		{Production: true, JWTSecret: "s", APIKey: "k", CORSOrigins: []string{"x"}, SecretKey: "sk", UnifiedPassword: "up"},
	} {
		if bad.check() == nil {
			t.Errorf("accepted %+v", bad)
		}
	}
}
