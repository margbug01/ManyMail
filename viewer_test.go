package main

// Ported from mail-viewer/tests/test_app.py; the viewer now talks to the store directly,
// so the upstream mocks became real data, and Resend / mail-router / IMAP are fake servers.

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"
)

// Made by Python cryptography's Fernet with mail-viewer's derivation and SECRET_KEY "test-secret-key".
const pyFernetToken = "gAAAAABq1E9wL7a4dIIs_yujq0thznLVBXTb5Bx1So9mmwWYP2BiB_gzUzeXy3BNwJ4OmKMeYl78e3TxtnBttaIrTlW9qPJZJoM8kUBRVimUhK6rb-4ErZM="

type venv struct {
	*env_
	v      *viewer
	web    *httptest.Server
	client *http.Client // keeps the session cookie, does not follow redirects
}

func newViewerEnv(t *testing.T) *venv {
	e := newEnv(t)
	cfg := e.api.cfg
	cfg.SecretKey, cfg.AccessPassword, cfg.UnifiedPassword = "test-secret-key", "viewer-pass", "mailbox-pass"
	cfg.LoginRateMax, cfg.LoginRateWindow = 2, 5*time.Minute
	cfg.SensitiveRateMax, cfg.SensitiveRateWindow = 100, time.Minute
	cfg.MaxImageProxyBytes, cfg.MaxContentLength = 1<<20, 1<<20
	cfg.MaxAttachmentBytes, cfg.MaxAttachmentTotalBytes, cfg.MaxAttachmentCount = 1<<20, 2<<20, 10
	cfg.ResendDomainKeys = map[string]string{}
	e.api.router = newRouter(cfg, e.st)
	v := newViewer(cfg, e.st, e.api)
	web := httptest.NewServer(v.routes())
	t.Cleanup(web.Close)
	jar, _ := cookiejar.New(nil)
	c := &http.Client{Jar: jar, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	return &venv{e, v, web, c}
}

func (e *venv) req(method, path string, body any) (*http.Response, string) {
	e.t.Helper()
	var rd io.Reader
	ct := ""
	switch b := body.(type) {
	case nil:
	case url.Values:
		rd, ct = strings.NewReader(b.Encode()), "application/x-www-form-urlencoded"
	case string:
		rd, ct = strings.NewReader(b), "text/plain"
	default:
		j, _ := json.Marshal(b)
		rd, ct = bytes.NewReader(j), "application/json"
	}
	r, _ := http.NewRequest(method, e.web.URL+path, rd)
	if ct != "" {
		r.Header.Set("Content-Type", ct)
	}
	resp, err := e.client.Do(r)
	if err != nil {
		e.t.Fatal(err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	return resp, string(data)
}

func (e *venv) call(path string, body any) map[string]any {
	e.t.Helper()
	_, data := e.req("POST", path, body)
	var out map[string]any
	if err := json.Unmarshal([]byte(data), &out); err != nil {
		e.t.Fatalf("%s: %v %q", path, err, data)
	}
	return out
}

func (e *venv) login() {
	e.t.Helper()
	if resp, _ := e.req("POST", "/login", url.Values{"password": {"viewer-pass"}}); resp.StatusCode != 302 {
		e.t.Fatalf("login: %d", resp.StatusCode)
	}
}

func TestViewerLoginAndPages(t *testing.T) {
	e := newViewerEnv(t)
	if _, body := e.req("POST", "/api/inbox/query", map[string]string{"email": "a@test.local"}); !strings.Contains(body, "未授权访问") {
		t.Errorf("json unauth: %s", body)
	}
	for _, p := range []string{"/", "/rules", "/dns-check", "/api/router/rules", "/imap/"} {
		if resp, _ := e.req("GET", p, nil); resp.StatusCode != 302 || resp.Header.Get("Location") != "/login" {
			t.Errorf("%s unauth: %d", p, resp.StatusCode)
		}
	}
	// Login page and its assets are public; asset URLs carry a content hash.
	_, page := e.req("GET", "/login", nil)
	if !regexp.MustCompile(`src="/i18n\.js\?v=[0-9a-f]{12}"`).MatchString(page) || !strings.Contains(page, `id="lang-select"`) {
		t.Errorf("login page: %s", page)
	}
	if _, js := e.req("GET", "/i18n.js", nil); !strings.Contains(js, "ManyMailI18n") {
		t.Error("i18n.js")
	}
	if _, js := e.req("GET", "/email-privacy.js", nil); !strings.Contains(js, "Content-Security-Policy") {
		t.Error("email-privacy.js")
	}

	if _, body := e.req("POST", "/login", url.Values{"password": {"bad"}}); !strings.Contains(body, "密码错误") {
		t.Error("wrong password message")
	}
	e.req("POST", "/login", url.Values{"password": {"bad"}})
	if resp, body := e.req("POST", "/login", url.Values{"password": {"viewer-pass"}}); resp.StatusCode != 429 || !strings.Contains(body, "过于频繁") {
		t.Errorf("login rate limit: %d", resp.StatusCode)
	}
	e.v.rate = map[string]map[string][]time.Time{}
	e.login()

	_, index := e.req("GET", "/", nil)
	for _, asset := range []string{"css/app.css", "app/main.js"} {
		m := regexp.MustCompile(`/static/` + regexp.QuoteMeta(asset) + `\?v=[0-9a-f]{12}`).FindString(index)
		if m == "" {
			t.Errorf("%s not versioned in index", asset)
			continue
		}
		resp, _ := e.req("GET", m, nil)
		if resp.StatusCode != 200 || !strings.Contains(resp.Header.Get("Cache-Control"), "immutable") {
			t.Errorf("%s: %d %v", m, resp.StatusCode, resp.Header)
		}
	}
	if strings.Contains(index, "{{") {
		t.Error("unrendered template action")
	}
	if _, rules := e.req("GET", "/rules", nil); !strings.Contains(rules, "rules.js") {
		t.Error("rules page")
	}

	// A forged or expired session does not pass.
	u, _ := url.Parse(e.web.URL)
	for _, val := range []string{"1." + e.v.sign("2"), "0." + e.v.sign("0")} {
		e.client.Jar.SetCookies(u, []*http.Cookie{{Name: "session", Value: val}})
		if resp, _ := e.req("GET", "/", nil); resp.StatusCode != 302 {
			t.Errorf("cookie %q accepted", val)
		}
	}
	e.login()
	if resp, _ := e.req("GET", "/logout", nil); resp.StatusCode != 302 {
		t.Error("logout")
	}
	if resp, _ := e.req("GET", "/", nil); resp.StatusCode != 302 {
		t.Error("still logged in after logout")
	}
}

func TestViewerInbox(t *testing.T) {
	e := newViewerEnv(t)
	e.login()
	if out := e.call("/api/inbox/query", map[string]string{"email": "new@test.local"}); out["success"] != false ||
		!strings.Contains(out["message"].(string), "自动创建已关闭") {
		t.Errorf("auto-create off: %v", out)
	}
	e.v.cfg.AutoCreateAccounts = true
	if out := e.call("/api/inbox/query", map[string]string{"email": "New@test.local"}); out["success"] != true || out["total"].(float64) != 0 {
		t.Fatalf("auto-create: %v", out)
	}
	if out := e.call("/api/inbox/query", map[string]string{"email": "new@test.local", "password": "other"}); out["message"] != addressUsed {
		t.Errorf("existing mailbox, wrong password: %v", out)
	}
	if out := e.call("/api/inbox/query", map[string]string{"email": "x@nope.test"}); !strings.Contains(out["message"].(string), "not available") {
		t.Errorf("foreign domain: %v", out)
	}

	att := Attachment{ID: newID(), Filename: "a.pdf", ContentType: "application/pdf", Content: []byte("%PDF")}
	id := e.deliver([]string{"new@test.local"}, "Your code 135790", "code inside: 246810",
		`<p onclick="x()">hi</p><img src="https://t.test/p.png"><script>bad()</script>`, att)
	e.deliver([]string{"new@test.local"}, "second", "plain", "")

	out := e.call("/api/inbox/query", map[string]any{"email": "new@test.local", "offset": "0", "limit": 1})
	list := out["messages"].([]any)
	if out["total"].(float64) != 2 || len(list) != 1 || list[0].(map[string]any)["extracted_code"] != nil {
		t.Errorf("query: %v", out)
	}
	_, raw := e.req("POST", "/api/inbox/query", map[string]any{"email": "new@test.local"})
	if !strings.Contains(raw, `"extracted_code":"135790"`) {
		t.Errorf("code in list: %s", raw)
	}

	d := e.call("/api/inbox/detail", map[string]string{"email": "new@test.local", "message_id": id})["detail"].(map[string]any)
	h := d["html"].(string)
	if strings.Contains(h, "onclick") || strings.Contains(h, "bad()") || !strings.Contains(h, `data-remote-src="https://t.test/p.png"`) ||
		d["text"] != "code inside: 246810" || d["extracted_code"] != "135790" {
		t.Errorf("detail: %v", d)
	}
	a := d["attachments"].([]any)[0].(map[string]any)
	if a["index"].(float64) != 0 || a["id"] != att.ID || a["filename"] != "a.pdf" || a["contentType"] != "application/pdf" || a["size"].(float64) != 4 {
		t.Errorf("attachment meta: %v", a)
	}
	if out := e.call("/api/inbox/detail", map[string]string{"email": "new@test.local", "message_id": id, "password": "bad"}); out["message"] != "登录失败" {
		t.Errorf("bad mailbox password: %v", out)
	}

	resp, body := e.req("GET", "/api/inbox/attachment/"+id+"/"+att.ID+"?email=new@test.local&filename=合同.pdf", nil)
	if body != "%PDF" || resp.Header.Get("Content-Disposition") != "attachment; filename*=UTF-8''%E5%90%88%E5%90%8C.pdf" {
		t.Errorf("download: %q %v", body, resp.Header)
	}
	if resp, _ := e.req("GET", "/api/inbox/attachment/"+id+"/"+att.ID+"?email=new@test.local&password=bad", nil); resp.StatusCode != 401 {
		t.Errorf("download with bad password: %d", resp.StatusCode)
	}
	if resp, body := e.req("GET", "/api/inbox/source/"+id+"?email=new@test.local", nil); resp.StatusCode != 404 || !strings.Contains(body, "邮件原文接口不可用") {
		t.Errorf("source: %d", resp.StatusCode)
	}

	if out := e.call("/api/inbox/search", map[string]string{"email": "new@test.local", "query": "second"}); len(out["messages"].([]any)) != 1 {
		t.Errorf("search: %v", out)
	}
	if out := e.call("/api/inbox/batch", map[string]any{"email": "new@test.local", "action": "mark_read", "message_ids": []string{id}}); out["count"].(float64) != 1 {
		t.Errorf("batch: %v", out)
	}
	if out := e.call("/api/inbox/batch", map[string]any{"email": "new@test.local", "action": "explode", "message_ids": []string{id}}); out["success"] != false {
		t.Errorf("batch unknown: %v", out)
	}
	if out := e.call("/api/inbox/delete", map[string]string{"email": "new@test.local", "message_id": id}); out["message"] != "邮件已删除" {
		t.Errorf("delete: %v", out)
	}
	if out := e.call("/api/trash/query", map[string]string{"email": "new@test.local"}); out["total"].(float64) != 1 {
		t.Errorf("trash: %v", out)
	}
	if out := e.call("/api/inbox/restore", map[string]string{"email": "new@test.local", "message_id": id}); out["message"] != "邮件已恢复" {
		t.Errorf("restore: %v", out)
	}
	if out := e.call("/api/inbox/permanent-delete", map[string]string{"email": "new@test.local", "message_id": id}); out["success"] != false {
		t.Errorf("purge outside trash: %v", out)
	}
	e.call("/api/inbox/delete", map[string]string{"email": "new@test.local", "message_id": id})
	if out := e.call("/api/inbox/permanent-delete", map[string]string{"email": "new@test.local", "message_id": id}); out["message"] != "邮件已彻底删除" {
		t.Errorf("purge: %v", out)
	}

	// Mutations share one rate limit.
	e.v.cfg.SensitiveRateMax = 1
	e.v.rate = map[string]map[string][]time.Time{}
	e.call("/api/inbox/delete", map[string]string{"email": "new@test.local", "message_id": id})
	if resp, _ := e.req("POST", "/api/inbox/delete", map[string]string{"email": "new@test.local", "message_id": id}); resp.StatusCode != 429 {
		t.Errorf("mutation rate limit: %d", resp.StatusCode)
	}
}

func TestViewerPasswordCache(t *testing.T) {
	e := newViewerEnv(t)
	if err := e.st.CreateAccount(newID(), "py@test.local", pyBcryptHash, time.Now()); err != nil {
		t.Fatal(err)
	}
	for i, c := range []struct {
		pw   string
		want bool
	}{{"pw-from-python", true}, {"pw-from-python", true}, {"wrong", false}, {"pw-from-python", true}} {
		if ok, err := e.v.checkMailbox("py@test.local", c.pw); err != nil || ok != c.want {
			t.Errorf("%d: %v %v", i, ok, err)
		}
	}
	// A changed password hash is checked again, not served from the cache.
	e.st.db.Exec(`UPDATE accounts SET password_hash = '$2b$04$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva' WHERE address = 'py@test.local'`)
	if ok, _ := e.v.checkMailbox("py@test.local", "pw-from-python"); ok {
		t.Error("stale cache after password change")
	}
}

// fakeResend records requests and answers with the next canned response.
type fakeResend struct {
	mu     sync.Mutex
	got    []*http.Request
	bodies []map[string]any
	status int
	reply  string
}

func (f *fakeResend) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var b map[string]any
	json.NewDecoder(r.Body).Decode(&b)
	f.got, f.bodies = append(f.got, r), append(f.bodies, b)
	w.WriteHeader(f.status)
	io.WriteString(w, f.reply)
}

func (e *venv) resend(status int, reply string) *fakeResend {
	f := &fakeResend{status: status, reply: reply}
	srv := httptest.NewServer(f)
	e.t.Cleanup(srv.Close)
	e.v.resendURL = srv.URL
	return f
}

func TestViewerSend(t *testing.T) {
	e := newViewerEnv(t)
	e.login()
	mail := func(from string, extra map[string]any) map[string]any {
		b := map[string]any{"from_email": from, "to": "x@example.org, y@example.org", "subject": "Hi", "text": "body",
			"html": `<p>hi</p><script>x()</script>`}
		for k, v := range extra {
			b[k] = v
		}
		return e.call("/api/send", b)
	}
	if out := mail("a@test.local", nil); out["success"] != false || !strings.Contains(out["message"].(string), "Resend") {
		t.Errorf("no key: %v", out)
	}

	f := e.resend(200, `{"id":"re-1"}`)
	e.v.cfg.ResendAPIKey = "re_fallback"
	e.v.cfg.ResendDomainKeys = map[string]string{"cnhealthtourism.com": "re_domainkey"}
	e.st.PutSenderKey("saved.test", pyFernetToken, "re_…1234") // saved on the settings page
	for from, key := range map[string]string{"a@cnhealthtourism.com": "re_domainkey", "a@test.local": "re_fallback", "a@saved.test": "re_savedkey_1234"} {
		if out := mail(from, nil); out["success"] != true || out["email_id"] != "re-1" {
			t.Errorf("%s: %v", from, out)
		}
		if got := f.got[len(f.got)-1].Header.Get("Authorization"); got != "Bearer "+key {
			t.Errorf("%s used %q", from, got)
		}
	}
	p := f.bodies[0]
	if p["html"] != "<p>hi</p>" || p["to"].([]any)[1] != "y@example.org" || !strings.HasPrefix(p["from"].(string), "a@") {
		t.Errorf("payload %v", p)
	}
	tok := e.api.createToken("1", "a@test.local")
	if code, out := e.do("GET", "/sent", tok, nil); code != 200 || out["hydra:totalItems"].(float64) != 1 {
		t.Errorf("sent record: %v", out)
	}

	content := base64.StdEncoding.EncodeToString([]byte("hello"))
	before := len(f.got)
	out := mail("a@test.local", map[string]any{"attachments": []map[string]string{{"filename": `..\..\etc/passwd`, "content": content, "contentType": "text/plain"}}})
	if out["success"] != true || len(f.got) != before+1 {
		t.Fatalf("attachment send: %v", out)
	}
	if a := f.bodies[len(f.bodies)-1]["attachments"].([]any)[0].(map[string]any); a["filename"] != "passwd" || a["content"] != content || a["content_type"] != "text/plain" {
		t.Errorf("attachment payload %v", a)
	}
	e.v.cfg.MaxAttachmentBytes = 16
	big := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte("x"), 64))
	for att, want := range map[string]string{big: "超过单个", "not-base64!!!": "编码不合法"} {
		if out := mail("a@test.local", map[string]any{"attachments": []map[string]string{{"filename": "f.bin", "content": att}}}); !strings.Contains(out["message"].(string), want) {
			t.Errorf("%s: %v", want, out)
		}
	}
	if len(f.got) != before+1 {
		t.Error("rejected attachments reached Resend")
	}

	f.status, f.reply = 422, `{"name":"validation_error","message":"The from address is not verified"}`
	if out := mail("a@test.local", nil); out["message"] != "The from address is not verified" {
		t.Errorf("resend error: %v", out)
	}

	e.v.cfg.MaxContentLength = 128
	e.web.Config.Handler = e.v.routes()
	if resp, body := e.req("POST", "/api/send", map[string]string{"text": strings.Repeat("x", 500)}); resp.StatusCode != 413 || !strings.Contains(body, `"success":false`) {
		t.Errorf("too large: %d %s", resp.StatusCode, body)
	}
}

func TestSenderKeySettings(t *testing.T) {
	e := newViewerEnv(t)
	if resp, _ := e.req("GET", "/api/settings/sender-keys", nil); resp.StatusCode != 302 {
		t.Error("needs login")
	}
	e.login()
	e.st.PutSenderKey("test.local", pyFernetToken, "re_…1234")
	e.st.PutSenderKey("broken.test", "not-a-token", "re_…9999")
	e.v.cfg.ResendDomainKeys = map[string]string{"env.test": "re_envdomainkey"}

	_, raw := e.req("GET", "/api/settings/sender-keys", nil)
	var out struct{ Domains []map[string]any }
	json.Unmarshal([]byte(raw), &out)
	items := map[string]map[string]any{}
	for _, i := range out.Domains {
		items[i["domain"].(string)] = i
	}
	if items["test.local"]["source"] != "settings" || items["test.local"]["hint"] != "re_…1234" ||
		items["broken.test"]["unreadable"] != true || items["env.test"]["source"] != "env-domain" ||
		items["env.test"]["hint"] != "re_…nkey" || items["example.test"]["source"] != "none" || items["example.test"]["hint"] != "" {
		t.Errorf("items %v", items)
	}
	if strings.Contains(raw, "re_envdomainkey") || strings.Contains(raw, "re_savedkey") {
		t.Error("plain key leaked")
	}

	f := e.resend(401, `{"name":"validation_error","message":"API key is invalid"}`)
	put := func(domain, key string) (*http.Response, map[string]any) {
		resp, body := e.req("PUT", "/api/settings/sender-keys/"+domain, map[string]string{"api_key": key})
		var m map[string]any
		json.Unmarshal([]byte(body), &m)
		return resp, m
	}
	if resp, _ := put("a.test", "sk-nope"); resp.StatusCode != 400 || len(f.got) != 0 {
		t.Error("format check")
	}
	if resp, m := put("a.test", "re_badbadbad1"); resp.StatusCode != 400 || !strings.Contains(m["message"].(string), "API key is invalid") {
		t.Errorf("rejected key: %v", m)
	}
	if resp, _ := put("bad_domain", "re_sendonly_5678"); resp.StatusCode != 400 {
		t.Error("domain check")
	}
	f.status, f.reply = 401, `{"name":"restricted_api_key","message":"restricted"}`
	if resp, m := put("A.test", "re_sendonly_5678"); resp.StatusCode != 200 || !strings.Contains(m["message"].(string), "仅限发信") || m["hint"] != "re_…5678" {
		t.Errorf("send-only key: %v", m)
	}
	if k, src := e.v.resendKeyFor("a.test"); k != "re_sendonly_5678" || src != "settings" {
		t.Errorf("saved key not used: %q %q", k, src)
	}
	var cipherText string
	e.st.db.QueryRow(`SELECT ciphertext FROM sender_keys WHERE domain = 'a.test'`).Scan(&cipherText)
	if strings.Contains(cipherText, "re_sendonly") {
		t.Error("stored in plain text")
	}
	f.status, f.reply = 200, `{"data":[{"name":"a.test","status":"verified"}]}`
	if _, m := put("a.test", "re_fullaccess_1"); !strings.Contains(m["message"].(string), "域名已验证") {
		t.Errorf("verified: %v", m)
	}
	f.reply = `{"data":[{"name":"other.test","status":"verified"}]}`
	if _, m := put("a.test", "re_fullaccess_1"); !strings.Contains(m["message"].(string), "没有 a.test") {
		t.Errorf("missing domain: %v", m)
	}
	if _, body := e.req("DELETE", "/api/settings/sender-keys/a.test", nil); strings.TrimSpace(body) != `{"success":true}` {
		t.Errorf("delete: %s", body)
	}
	if k, src := e.v.resendKeyFor("a.test"); k != "" || src != "none" {
		t.Errorf("after delete: %q %q", k, src)
	}
}

func TestFernet(t *testing.T) {
	c := senderKeyCipher("test-secret-key")
	if plain, err := c.Decrypt(pyFernetToken); err != nil || string(plain) != "re_savedkey_1234" {
		t.Errorf("python token: %q %v", plain, err)
	}
	for _, s := range []string{"", "x", strings.Repeat("y", 33)} {
		if plain, err := c.Decrypt(c.Encrypt([]byte(s))); err != nil || string(plain) != s {
			t.Errorf("roundtrip %q: %q %v", s, plain, err)
		}
	}
	tok := []byte(c.Encrypt([]byte("secret")))
	tok[20] ^= 1
	if _, err := c.Decrypt(string(tok)); err == nil {
		t.Error("tampered token accepted")
	}
	if _, err := senderKeyCipher("other").Decrypt(pyFernetToken); err == nil {
		t.Error("wrong key accepted")
	}
}

func TestViewerDomainsAndDNSPage(t *testing.T) {
	e := newViewerEnv(t)
	e.login()
	if out := e.call("/api/domains", map[string]string{"domain": "New.Test"}); out["success"] != true {
		t.Errorf("add: %v", out)
	}
	if resp, _ := e.req("POST", "/api/domains", map[string]string{"domain": "new.test"}); resp.StatusCode != 409 {
		t.Error("duplicate")
	}
	_, raw := e.req("GET", "/api/domains", nil)
	if !strings.Contains(raw, `{"domain":"new.test","is_active":true}`) {
		t.Errorf("list: %s", raw)
	}
	if resp, _ := e.req("DELETE", "/api/domains/new.test", nil); resp.StatusCode != 200 {
		t.Error("delete")
	}
	if resp, _ := e.req("DELETE", "/api/domains/new.test", nil); resp.StatusCode != 200 { // deactivating twice still finds it
		t.Error("delete twice")
	}
	if resp, _ := e.req("DELETE", "/api/domains/ghost.test", nil); resp.StatusCode != 404 {
		t.Error("delete missing")
	}

	e.api.lookup = func(name, rtype string) ([]string, error) {
		if rtype == "MX" && name == "test.local" {
			return []string{"10 <mx>.test.local"}, nil
		}
		return nil, nil
	}
	_, page := e.req("GET", "/dns-check?ip=203.0.113.7", nil)
	for _, want := range []string{"&lt;mx&gt;.test.local", "status-fail", "example.test.  MX  10  mail.test.local.", "<code>203.0.113.7</code>", `href="/dns-check?ip=203.0.113.7"`} {
		if !strings.Contains(page, want) {
			t.Errorf("dns page lacks %q", want)
		}
	}
	if strings.Contains(page, "<mx>") {
		t.Error("detail not escaped")
	}
	if _, page := e.req("GET", "/dns-check?ip=nope", nil); !strings.Contains(page, "ip is not a valid IP address") {
		t.Error("bad ip message")
	}
}

func TestRouterAndIMAPProxy(t *testing.T) {
	e := newViewerEnv(t)
	e.login()
	resp, body := e.req("POST", "/api/router/rules", map[string]any{"name": "Push OTP",
		"actions": []map[string]string{{"type": "ntfy", "topic": "t1"}}})
	if resp.StatusCode != 201 || !strings.Contains(body, `"_id":"push-otp"`) {
		t.Errorf("create through the page: %d %s", resp.StatusCode, body)
	}
	if _, body := e.req("GET", "/api/router/rules", nil); !strings.Contains(body, `"problems":[]`) {
		t.Errorf("list: %s", body)
	}
	if resp, _ := e.req("GET", "/api/router/status?limit=5", nil); resp.StatusCode != 200 {
		t.Error("status")
	}
	for _, p := range []string{"events/imap", "rules/../health", "rules/a/b/c", "health"} {
		// 404 here, or a 307 from the path cleaning; either way the router never sees it.
		if resp, body := e.req("POST", "/api/router/"+p, map[string]any{"account": "a@b.c", "messages": []any{}}); resp.StatusCode < 300 || strings.Contains(body, "accepted") {
			t.Errorf("%s reached the router: %d", p, resp.StatusCode)
		}
	}
	if resp, _ := e.req("POST", "/api/router/rules", "name=x"); resp.StatusCode != 415 {
		t.Error("non-JSON write")
	}

	imap := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/go" {
			http.Redirect(w, r, "/next", http.StatusFound)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Set-Cookie", "leak=1")
		io.WriteString(w, `<script>fetch('/api/accounts'); fetch("/api/x")</script>`+r.URL.RawQuery)
	}))
	defer imap.Close()
	e.v.cfg.IMAPURL = imap.URL
	resp, body = e.req("GET", "/imap/?q=1", nil)
	if body != `<script>fetch('/imap/api/accounts'); fetch("/imap/api/x")</script>q=1` || resp.Header.Get("Set-Cookie") != "" {
		t.Errorf("imap page: %q %v", body, resp.Header)
	}
	if resp, _ := e.req("GET", "/imap/go", nil); resp.Header.Get("Location") != "/imap/next" {
		t.Errorf("imap redirect: %v", resp.Header)
	}
}

func TestImageProxy(t *testing.T) {
	e := newViewerEnv(t)
	e.login()
	resolve := map[string][]netip.Addr{}
	e.v.lookupHost = func(_ context.Context, host string) ([]netip.Addr, error) { return resolve[host], nil }

	resolve["internal.test"] = []netip.Addr{netip.MustParseAddr("10.0.0.5")}
	resolve["mixed.test"] = []netip.Addr{netip.MustParseAddr("93.184.216.34"), netip.MustParseAddr("::ffff:127.0.0.1")}
	for _, u := range []string{"http://internal.test/a.png", "http://mixed.test/a.png", "ftp://x.test/a", "http://nowhere.test/a.png"} {
		if resp, _ := e.req("GET", "/api/image-proxy?url="+url.QueryEscape(u), nil); resp.StatusCode != 400 {
			t.Errorf("%s: %d", u, resp.StatusCode)
		}
	}

	img := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/a.png":
			w.Header().Set("Content-Type", "image/png")
			w.Write([]byte("\x89PNG"))
		case "/big.png":
			w.Header().Set("Content-Type", "image/png")
			w.Write(bytes.Repeat([]byte("x"), 2<<20))
		case "/page":
			w.Header().Set("Content-Type", "text/html")
			io.WriteString(w, "<html>")
		case "/to-internal":
			http.Redirect(w, r, "http://internal.test/a.png", http.StatusFound)
		default:
			http.NotFound(w, r)
		}
	}))
	defer img.Close()
	host := strings.TrimPrefix(img.URL, "http://")
	// DNS rebinding: the check sees a public address, the connection goes to 127.0.0.1.
	resolve["127.0.0.1"] = []netip.Addr{netip.MustParseAddr("93.184.216.34")}
	if resp, _ := e.req("GET", "/api/image-proxy?url="+url.QueryEscape("http://"+host+"/a.png"), nil); resp.StatusCode != 502 {
		t.Errorf("rebinding not blocked: %d", resp.StatusCode)
	}

	// The rest of the checks, with a client that may reach the test server.
	e.v.images.Transport = http.DefaultTransport
	get := func(path string) (*http.Response, string) {
		return e.req("GET", "/api/image-proxy?url="+url.QueryEscape("http://"+host+path), nil)
	}
	if resp, body := get("/a.png"); resp.StatusCode != 200 || body != "\x89PNG" || resp.Header.Get("Content-Type") != "image/png" ||
		resp.Header.Get("X-Content-Type-Options") != "nosniff" || !strings.Contains(resp.Header.Get("Content-Security-Policy"), "sandbox") {
		t.Errorf("image: %d %v", resp.StatusCode, resp.Header)
	}
	for path, want := range map[string]int{"/page": 415, "/big.png": 413, "/to-internal": 502, "/missing": 502} {
		if resp, _ := get(path); resp.StatusCode != want {
			t.Errorf("%s: %d, want %d", path, resp.StatusCode, want)
		}
	}

	for ip, public := range map[string]bool{"93.184.216.34": true, "2606:4700::1": true, "100.108.228.121": false, "169.254.169.254": false,
		"::ffff:10.0.0.1": false, "fd7a:115c:a1e0::1": false, "0.0.0.0": false, "192.168.1.1": false} {
		if isPublicIP(netip.MustParseAddr(ip)) != public {
			t.Errorf("isPublicIP(%s) != %v", ip, public)
		}
	}
}
