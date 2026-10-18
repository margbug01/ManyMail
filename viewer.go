package main

// The web UI that used to be mail-viewer (Flask). Same pages, same /api/* JSON for
// static/js/app.js. It reads the store directly instead of logging in to the REST API
// for every call; mailbox passwords are still checked.

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"io"
	"io/fs"
	"log"
	"mime"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"golang.org/x/crypto/bcrypt"
)

//go:embed web
var webFS embed.FS

type viewer struct {
	cfg *Config
	st  *Store
	api *api

	tmpl     *template.Template
	versions map[string]string // asset path -> content hash

	mu       sync.Mutex
	rate     map[string]map[string][]time.Time // scope -> ip -> hits; one table per window
	verified map[string][32]byte               // address -> sha256(hash, password) of the last good login

	resendURL  string
	upstream   *http.Client // IMAP bridge, mail-router, Resend
	images     *http.Client // remote images, public addresses only
	lookupHost func(ctx context.Context, host string) ([]netip.Addr, error)
	cipher     fernet
}

func newViewer(cfg *Config, st *Store, a *api) *viewer {
	v := &viewer{cfg: cfg, st: st, api: a, versions: map[string]string{},
		rate: map[string]map[string][]time.Time{}, verified: map[string][32]byte{},
		resendURL: "https://api.resend.com", cipher: senderKeyCipher(cfg.SecretKey),
		lookupHost: func(ctx context.Context, host string) ([]netip.Addr, error) {
			return net.DefaultResolver.LookupNetIP(ctx, "ip", host)
		}}
	fs.WalkDir(webFS, "web", func(p string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			b, _ := webFS.ReadFile(p)
			sum := sha256.Sum256(b)
			v.versions[p] = hex.EncodeToString(sum[:])[:12]
		}
		return nil
	})
	v.tmpl = template.Must(template.New("").Funcs(template.FuncMap{
		"asset":  func(name string) string { return "/static/" + name + "?v=" + v.versions["web/static/"+name] },
		"shared": func(name string) string { return "/" + name + "?v=" + v.versions["web/shared/"+name] },
		"upper":  strings.ToUpper,
	}).ParseFS(webFS, "web/templates/*.html"))
	noRedirect := func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	v.upstream = &http.Client{Timeout: 60 * time.Second, CheckRedirect: noRedirect}
	v.images = v.imageClient()
	return v
}

// ---- small helpers ----

func (v *viewer) clientIP(r *http.Request) string {
	if f, _, _ := strings.Cut(r.Header.Get("X-Forwarded-For"), ","); strings.TrimSpace(f) != "" {
		return strings.TrimSpace(f)
	}
	return clientIP(r)
}

// bucket returns the hit table for a scope; call with v.mu held.
func (v *viewer) bucket(scope string) map[string][]time.Time {
	if v.rate[scope] == nil {
		v.rate[scope] = map[string][]time.Time{}
	}
	return v.rate[scope]
}

// limited is the viewer's per-scope, per-IP limiter; it answers 429 itself.
func (v *viewer) limited(w http.ResponseWriter, r *http.Request, scope string, window time.Duration, max int) bool {
	if max <= 0 {
		return false
	}
	v.mu.Lock()
	hitLimit := hit(v.bucket(scope), v.clientIP(r), window, max, time.Now())
	v.mu.Unlock()
	if hitLimit {
		writeJSON(w, 429, map[string]any{"success": false, "message": "操作过于频繁，请稍后再试"})
	}
	return hitLimit
}

func (v *viewer) sensitive(w http.ResponseWriter, r *http.Request, scope string) bool {
	return v.limited(w, r, scope, v.cfg.SensitiveRateWindow, v.cfg.SensitiveRateMax)
}

func isJSONRequest(r *http.Request) bool {
	mt, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
	return mt == "application/json" || strings.HasSuffix(mt, "+json")
}

type jsonBody map[string]any

func (b jsonBody) str(key string) string {
	s, _ := b[key].(string)
	return strings.TrimSpace(s)
}

func (b jsonBody) num(key string, def int) int {
	switch n := b[key].(type) {
	case float64:
		return int(n)
	case string:
		if i, err := strconv.Atoi(strings.TrimSpace(n)); err == nil {
			return i
		}
	}
	return def
}

// body reads a JSON object; an empty body is {}. Answers 413/400 itself on failure.
func (v *viewer) body(w http.ResponseWriter, r *http.Request) (jsonBody, bool) {
	// Like Flask's request.json: a form a page on another (same-site) origin can post
	// without a CORS preflight never has this content type.
	if !isJSONRequest(r) {
		writeJSON(w, 415, map[string]any{"success": false, "message": "请求需为 JSON"})
		return nil, false
	}
	b := jsonBody{}
	err := json.NewDecoder(r.Body).Decode(&b)
	var tooBig *http.MaxBytesError
	switch {
	case err == nil || err == io.EOF:
		return b, true
	case errors.As(err, &tooBig):
		writeJSON(w, 413, map[string]any{"success": false, "message": "请求内容过大，请减小附件体积"})
	default:
		writeJSON(w, 400, map[string]any{"success": false, "message": "请求格式不正确"})
	}
	return nil, false
}

func internalError(w http.ResponseWriter, err error, extra ...string) {
	log.Printf("viewer error: %v", err)
	out := map[string]any{"success": false, "message": "服务内部错误，请稍后重试"}
	for _, k := range extra {
		out[k] = []any{}
	}
	writeJSON(w, 200, out)
}

var codeRe = regexp.MustCompile(`\b(\d{6})\b`)

// extractCode returns the first 6-digit code in the parts, or nil.
func extractCode(parts ...string) *string {
	if m := codeRe.FindStringSubmatch(strings.Join(parts, " ")); m != nil {
		return &m[1]
	}
	return nil
}

// ---- session (a signed timestamp, like Flask's 31-day signed cookie) ----

const sessionCookie = "session"
const sessionMaxAge = 31 * 24 * time.Hour

func (v *viewer) sign(s string) string {
	m := hmac.New(sha256.New, []byte(v.cfg.SecretKey))
	// The password is part of the signature: changing ACCESS_PASSWORD ends every session.
	m.Write([]byte("viewer-session:" + s + "\x00" + v.cfg.AccessPassword))
	return hex.EncodeToString(m.Sum(nil))
}

func (v *viewer) authed(r *http.Request) bool {
	if v.cfg.AccessPassword == "" {
		return true
	}
	c, err := r.Cookie(sessionCookie)
	if err != nil {
		return false
	}
	ts, sig, ok := strings.Cut(c.Value, ".")
	issued, err := strconv.ParseInt(ts, 10, 64)
	return ok && err == nil && hmac.Equal([]byte(sig), []byte(v.sign(ts))) &&
		time.Since(time.Unix(issued, 0)) < sessionMaxAge
}

func (v *viewer) setSession(w http.ResponseWriter, value string, maxAge int) {
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: value, Path: "/", MaxAge: maxAge,
		HttpOnly: true, SameSite: http.SameSiteLaxMode, Secure: v.cfg.Production})
}

func (v *viewer) login(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !v.authed(r) {
			if isJSONRequest(r) {
				writeJSON(w, 401, map[string]any{"success": false, "message": "未授权访问"})
			} else {
				http.Redirect(w, r, "/login", http.StatusFound)
			}
			return
		}
		h(w, r)
	}
}

// ---- mailbox credentials ----

// checkMailbox verifies a mailbox password. Successful checks are remembered (keyed by the
// stored hash, so a changed password is checked again): the inbox auto-refreshes, and
// bcrypt at Python's cost 12 is ~0.3 s of CPU per call on the ARM box.
func (v *viewer) checkMailbox(addr, password string) (bool, error) {
	_, hash, found, err := v.st.Account(addr)
	if err != nil || !found {
		return false, err
	}
	key := sha256.Sum256([]byte(hash + "\x00" + password))
	v.mu.Lock()
	known := v.verified[addr] == key
	v.mu.Unlock()
	if known {
		return true, nil
	}
	if bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) != nil {
		return false, nil
	}
	v.mu.Lock()
	v.verified[addr] = key
	v.mu.Unlock()
	return true, nil
}

func (v *viewer) password(p string) string {
	if p == "" {
		return v.cfg.UnifiedPassword
	}
	return p
}

// mailbox authenticates email/password from a JSON body. On failure it has answered.
func (v *viewer) mailbox(w http.ResponseWriter, b jsonBody, required string, emptyLists ...string) (string, bool) {
	addr := strings.ToLower(b.str("email"))
	reply := func(msg string) {
		out := map[string]any{"success": false, "message": msg}
		for _, k := range emptyLists {
			out[k] = []any{}
		}
		writeJSON(w, 200, out)
	}
	if addr == "" || (required != "" && b.str(required) == "") {
		reply("缺少必要参数")
		return "", false
	}
	ok, err := v.checkMailbox(addr, v.password(b.str("password")))
	if err != nil {
		internalError(w, err, emptyLists...)
		return "", false
	}
	if !ok {
		reply("登录失败")
	}
	return addr, ok
}

// ---- routes ----

func (v *viewer) routes() http.Handler {
	mux := http.NewServeMux()
	static, _ := fs.Sub(webFS, "web/static")
	shared, _ := fs.Sub(webFS, "web/shared")
	mux.Handle("GET /static/", cacheByVersion(http.StripPrefix("/static/", http.FileServerFS(static))))
	sharedFiles := cacheByVersion(http.FileServerFS(shared))
	mux.Handle("GET /i18n.js", sharedFiles)
	mux.Handle("GET /email-privacy.js", sharedFiles)

	mux.HandleFunc("GET /login", v.loginPage)
	mux.HandleFunc("POST /login", v.loginPage)
	mux.HandleFunc("GET /logout", func(w http.ResponseWriter, r *http.Request) {
		v.setSession(w, "", -1)
		http.Redirect(w, r, "/login", http.StatusFound)
	})
	mux.HandleFunc("GET /{$}", v.login(func(w http.ResponseWriter, r *http.Request) { v.render(w, 200, "index.html", nil) }))
	mux.HandleFunc("GET /rules", v.login(func(w http.ResponseWriter, r *http.Request) { v.render(w, 200, "rules.html", nil) }))
	mux.HandleFunc("GET /dns-check", v.login(v.dnsPage))

	mux.HandleFunc("/api/router/{path...}", v.login(v.routerProxy))
	mux.HandleFunc("GET /imap", v.login(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, "/imap/", http.StatusFound) }))
	mux.HandleFunc("/imap/{path...}", v.login(v.imapProxy))
	mux.HandleFunc("GET /api/image-proxy", v.login(v.imageProxy))

	mux.HandleFunc("POST /api/inbox/query", v.login(v.inboxQuery))
	mux.HandleFunc("POST /api/inbox/detail", v.login(v.inboxDetail))
	mux.HandleFunc("GET /api/inbox/attachment/{id}/{att}", v.login(v.inboxAttachment))
	mux.HandleFunc("GET /api/inbox/source/{id}", v.login(v.inboxSource))
	mux.HandleFunc("POST /api/inbox/batch", v.login(v.inboxBatch))
	mux.HandleFunc("POST /api/inbox/search", v.login(v.inboxSearch))
	mux.HandleFunc("POST /api/inbox/delete", v.login(v.inboxDelete))
	mux.HandleFunc("POST /api/trash/query", v.login(v.trashQuery))
	mux.HandleFunc("POST /api/inbox/restore", v.login(v.messageAction("邮件已恢复", "is_deleted = 0")))
	mux.HandleFunc("POST /api/inbox/permanent-delete", v.login(v.messageAction("邮件已彻底删除", "")))
	mux.HandleFunc("POST /api/sent/detail", v.login(v.sentDetail))
	mux.HandleFunc("POST /api/sent/query", v.login(v.sentQuery))

	mux.HandleFunc("GET /api/domains", v.login(v.listDomains))
	mux.HandleFunc("POST /api/domains", v.login(v.addDomain))
	mux.HandleFunc("DELETE /api/domains/{domain}", v.login(v.deleteDomain))
	mux.HandleFunc("GET /api/settings/sender-keys", v.login(v.listSenderKeys))
	mux.HandleFunc("PUT /api/settings/sender-keys/{domain}", v.login(v.putSenderKey))
	mux.HandleFunc("DELETE /api/settings/sender-keys/{domain}", v.login(v.deleteSenderKey))
	mux.HandleFunc("POST /api/send", v.login(v.send))

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.Body = http.MaxBytesReader(w, r.Body, v.cfg.MaxContentLength)
		mux.ServeHTTP(w, r)
	})
}

// cacheByVersion: asset URLs carry ?v=<content hash>, so those can be cached for good.
func cacheByVersion(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("v") != "" {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			w.Header().Set("Cache-Control", "no-cache")
		}
		h.ServeHTTP(w, r)
	})
}

func (v *viewer) render(w http.ResponseWriter, status int, name string, data any) {
	var buf bytes.Buffer
	if err := v.tmpl.ExecuteTemplate(&buf, name, data); err != nil {
		log.Printf("render %s: %v", name, err)
		http.Error(w, "Internal Server Error", 500)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(status)
	w.Write(buf.Bytes())
}

// ---- pages ----

func (v *viewer) loginPage(w http.ResponseWriter, r *http.Request) {
	if v.cfg.AccessPassword == "" {
		http.Redirect(w, r, "/", http.StatusFound)
		return
	}
	type page struct{ Error string }
	if r.Method != http.MethodPost {
		v.render(w, 200, "login.html", page{})
		return
	}
	v.mu.Lock()
	tooMany := v.cfg.LoginRateMax > 0 && hit(v.bucket("login"), v.clientIP(r), v.cfg.LoginRateWindow, v.cfg.LoginRateMax, time.Now())
	v.mu.Unlock()
	if tooMany {
		v.render(w, 429, "login.html", page{"登录尝试过于频繁，请稍后再试"})
		return
	}
	if subtle.ConstantTimeCompare([]byte(r.PostFormValue("password")), []byte(v.cfg.AccessPassword)) != 1 {
		v.render(w, 200, "login.html", page{"密码错误"})
		return
	}
	ts := strconv.FormatInt(time.Now().Unix(), 10)
	v.setSession(w, ts+"."+v.sign(ts), 0)
	http.Redirect(w, r, "/", http.StatusFound)
}

func (v *viewer) dnsPage(w http.ResponseWriter, r *http.Request) {
	ip := strings.TrimSpace(r.URL.Query().Get("ip"))
	data := struct {
		IP, Error string
		Report    *dnsReport
	}{IP: ip}
	report, problem, err := v.api.dnsReport(ip)
	switch {
	case err != nil:
		log.Printf("dns check: %v", err)
		data.Error = "连接邮件服务失败"
	case problem != "":
		data.Error = problem
	default:
		data.Report = &report
	}
	v.render(w, 200, "dns_check.html", data)
}

// ---- proxies to services that still run on their own ----

var routerPaths = regexp.MustCompile(`^(rules(/[A-Za-z0-9_-]{1,80}(/(enabled|test))?)?|test|dry-run|status)$`)

// routerProxy gives the rules page the rules API, in-process (only rule paths, writes as JSON).
func (v *viewer) routerProxy(w http.ResponseWriter, r *http.Request) {
	path := r.PathValue("path")
	if !routerPaths.MatchString(path) {
		writeJSON(w, 404, map[string]string{"error": "not found"})
		return
	}
	if r.Method != http.MethodGet && !isJSONRequest(r) {
		writeJSON(w, 415, map[string]string{"error": "JSON body required"})
		return
	}
	r2 := r.Clone(r.Context())
	r2.URL.Path = "/router/" + path
	v.api.router.handler(false).ServeHTTP(w, r2)
}

// imapProxy serves the IMAP bridge's own UI under /imap/.
func (v *viewer) imapProxy(w http.ResponseWriter, r *http.Request) {
	// The escaped path, so %3F or %25 reach the bridge as they were sent.
	target := v.cfg.IMAPURL + "/" + strings.TrimPrefix(r.URL.EscapedPath(), "/imap/")
	if r.URL.RawQuery != "" {
		target += "?" + r.URL.RawQuery
	}
	var body io.Reader
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		body = r.Body
	}
	req, err := http.NewRequestWithContext(r.Context(), r.Method, target, body)
	if err != nil {
		writeJSON(w, 400, map[string]any{"success": false, "message": "地址不正确"})
		return
	}
	// Conditional headers too: unchanged style.css / app.js come back as 304.
	for _, h := range []string{"Accept", "Content-Type", "X-Requested-With", "If-None-Match", "If-Modified-Since"} {
		if val := r.Header.Get(h); val != "" {
			req.Header.Set(h, val)
		}
	}
	resp, err := v.upstream.Do(req)
	if err != nil {
		log.Printf("imap bridge: %v", err)
		writeJSON(w, 502, map[string]any{"success": false, "message": "连接 IMAP 服务失败"})
		return
	}
	defer resp.Body.Close()
	ct := resp.Header.Get("Content-Type")
	for _, h := range []string{"Content-Disposition", "Cache-Control", "Location", "ETag", "Last-Modified"} {
		if val := resp.Header.Get(h); val != "" {
			if h == "Location" && strings.HasPrefix(val, "/") {
				val = "/imap" + val
			}
			w.Header().Set(h, val)
		}
	}
	if ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	if !strings.Contains(ct, "text/html") {
		w.WriteHeader(resp.StatusCode)
		io.Copy(w, resp.Body)
		return
	}
	page, _ := io.ReadAll(resp.Body)
	page = bytes.ReplaceAll(page, []byte(`'/api/`), []byte(`'/imap/api/`))
	page = bytes.ReplaceAll(page, []byte(`"/api/`), []byte(`"/imap/api/`))
	w.WriteHeader(resp.StatusCode)
	w.Write(page)
}

// ---- remote images ----

// Non-public ranges, including what Python's ipaddress calls private/reserved, plus
// CGNAT 100.64/10 (Tailscale lives there).
var blockedPrefixes = func() []netip.Prefix {
	var out []netip.Prefix
	for _, s := range strings.Fields(`0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12
		192.0.0.0/24 192.0.2.0/24 192.168.0.0/16 198.18.0.0/15 198.51.100.0/24 203.0.113.0/24 224.0.0.0/4 240.0.0.0/4
		::/128 ::1/128 64:ff9b::/96 100::/64 2001::/23 2001:db8::/32 fc00::/7 fe80::/10 ff00::/8`) {
		out = append(out, netip.MustParsePrefix(s))
	}
	return out
}()

func isPublicIP(a netip.Addr) bool {
	a = a.WithZone("").Unmap() // a zoned address never matches a prefix
	if !a.IsValid() || (a.Is6() && !globalUnicast6.Contains(a)) {
		return false // like Python's ipaddress: IPv6 outside 2000::/3 is reserved
	}
	for _, p := range blockedPrefixes {
		if p.Contains(a) {
			return false
		}
	}
	return true
}

var globalUnicast6 = netip.MustParsePrefix("2000::/3")

var errBlockedHost = errors.New("blocked non-public address")

// proxyable: http(s) and every address the host resolves to is public.
func (v *viewer) proxyable(ctx context.Context, raw string) bool {
	u, err := url.Parse(normalizeRemoteURL(raw))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" {
		return false
	}
	addrs, err := v.lookupHost(ctx, u.Hostname())
	if err != nil || len(addrs) == 0 {
		return false
	}
	for _, a := range addrs {
		if !isPublicIP(a) {
			return false
		}
	}
	return true
}

// imageClient checks the address each connection actually goes to, which also stops DNS
// rebinding (public at check time, private at connect time) and redirects into the LAN.
func (v *viewer) imageClient() *http.Client {
	dialer := &net.Dialer{Timeout: 10 * time.Second, Control: func(_, address string, _ syscall.RawConn) error {
		host, _, _ := net.SplitHostPort(address)
		if a, err := netip.ParseAddr(host); err != nil || !isPublicIP(a) {
			return fmt.Errorf("%w %s", errBlockedHost, host)
		}
		return nil
	}}
	return &http.Client{
		Timeout:   30 * time.Second,
		Transport: &http.Transport{Proxy: nil, DialContext: dialer.DialContext, TLSHandshakeTimeout: 10 * time.Second, MaxIdleConns: 4, IdleConnTimeout: 30 * time.Second},
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) > 5 || !v.proxyable(req.Context(), req.URL.String()) {
				return errBlockedHost
			}
			return nil
		},
	}
}

func (v *viewer) imageProxy(w http.ResponseWriter, r *http.Request) {
	failImg := func(status int, msg string) { writeJSON(w, status, map[string]any{"success": false, "message": msg}) }
	src := normalizeRemoteURL(r.URL.Query().Get("url"))
	if !v.proxyable(r.Context(), src) {
		failImg(400, "非法图片地址")
		return
	}
	req, _ := http.NewRequestWithContext(r.Context(), "GET", src, nil)
	req.Header.Set("User-Agent", "Mozilla/5.0 mail-viewer-image-proxy")
	req.Header.Set("Accept", "image/*,*/*;q=0.8")
	resp, err := v.images.Do(req)
	if err != nil {
		log.Printf("image proxy %s: %v", src, err)
		failImg(502, "图片加载失败")
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		failImg(502, "图片加载失败")
		return
	}
	ct, _, _ := mime.ParseMediaType(resp.Header.Get("Content-Type"))
	if !strings.HasPrefix(ct, "image/") {
		failImg(415, "远程资源不是图片")
		return
	}
	limit := v.cfg.MaxImageProxyBytes
	if resp.ContentLength > limit {
		failImg(413, "图片过大")
		return
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		failImg(502, "图片加载失败")
		return
	}
	if int64(len(data)) > limit {
		failImg(413, "图片过大")
		return
	}
	w.Header().Set("Content-Type", ct)
	// Login-only content: no shared caches. The image is served from our origin, so an SVG
	// opened directly must not run script there.
	w.Header().Set("Cache-Control", "private, max-age=3600")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox")
	w.Write(data)
}

// ---- inbox ----

type listItem struct {
	msgJSON
	ExtractedCode *string `json:"extracted_code"`
}

func withCodes(rows []MsgRow) []listItem {
	out := make([]listItem, 0, len(rows))
	for i := range rows {
		out = append(out, listItem{formatMessage(&rows[i]), extractCode(rows[i].Subject, rows[i].Intro)})
	}
	return out
}

func pageArgs(b jsonBody) (offset, limit int) {
	return max(b.num("offset", 0), 0), min(max(b.num("limit", 30), 1), 100)
}

func (v *viewer) inboxQuery(w http.ResponseWriter, r *http.Request) {
	b, ok := v.body(w, r)
	if !ok {
		return
	}
	reply := func(msg string) {
		writeJSON(w, 200, map[string]any{"success": false, "message": msg, "messages": []any{}})
	}
	addr := strings.ToLower(b.str("email"))
	if addr == "" {
		reply("请输入邮箱")
		return
	}
	password := v.password(b.str("password"))
	ok, err := v.checkMailbox(addr, password)
	if err != nil {
		internalError(w, err, "messages")
		return
	}
	if !ok {
		// Unknown mailbox (or wrong password): create it when allowed.
		if !v.cfg.AutoCreateAccounts {
			reply("邮箱不存在或密码错误，自动创建已关闭")
			return
		}
		if v.sensitive(w, r, "auto_create_account") {
			return
		}
		_, _, problem, err := v.api.newAccount(addr, password)
		if err != nil {
			internalError(w, err, "messages")
			return
		}
		if problem != "" {
			reply(problem)
			return
		}
		if ok, err = v.checkMailbox(addr, password); err != nil || !ok {
			reply("登录失败")
			return
		}
	}
	offset, limit := pageArgs(b)
	rows, total, err := v.st.ListMessages(addr, false, offset, limit)
	if err != nil {
		internalError(w, err, "messages")
		return
	}
	writeJSON(w, 200, map[string]any{"success": true, "messages": withCodes(rows), "total": total, "offset": offset, "limit": limit})
}

type viewAtt struct {
	Index       int    `json:"index"`
	ID          string `json:"id"`
	Filename    string `json:"filename"`
	Size        int64  `json:"size"`
	ContentType string `json:"contentType"`
}

type detailJSON struct {
	msgJSON
	HTML          string    `json:"html"` // shadows msgJSON.HTML: sanitized
	Attachments   []viewAtt `json:"attachments"`
	ExtractedCode *string   `json:"extracted_code"`
}

func (v *viewer) inboxDetail(w http.ResponseWriter, r *http.Request) {
	b, ok := v.body(w, r)
	if !ok {
		return
	}
	addr, ok := v.mailbox(w, b, "message_id")
	if !ok {
		return
	}
	id := strings.ToLower(b.str("message_id"))
	m, atts, err := v.st.Message(addr, id)
	if err != nil {
		internalError(w, err)
		return
	}
	if m == nil {
		writeJSON(w, 200, map[string]any{"success": false, "message": "获取邮件详情失败"})
		return
	}
	if !m.Seen {
		if _, err := v.st.UpdateMessages(addr, []string{id}, "seen = 1", false); err != nil {
			log.Printf("mark seen %s: %v", id, err)
		}
	}
	d := detailJSON{msgJSON: formatMessage(m), HTML: prepareHTML(m.HTML), Attachments: []viewAtt{},
		ExtractedCode: extractCode(m.Subject, m.Intro, m.Text)}
	d.Text = &m.Text
	for i, a := range atts {
		d.Attachments = append(d.Attachments, viewAtt{i, a.ID, a.Filename, a.Size, a.ContentType})
	}
	writeJSON(w, 200, map[string]any{"success": true, "detail": d})
}

// queryMailbox authenticates email/password given as query parameters (download links).
func (v *viewer) queryMailbox(w http.ResponseWriter, r *http.Request) (string, bool) {
	q := r.URL.Query()
	addr := strings.ToLower(strings.TrimSpace(q.Get("email")))
	if addr == "" {
		writeJSON(w, 400, map[string]any{"success": false, "message": "缺少邮箱参数"})
		return "", false
	}
	ok, err := v.checkMailbox(addr, v.password(strings.TrimSpace(q.Get("password"))))
	if err != nil {
		log.Printf("viewer error: %v", err)
		writeJSON(w, 500, map[string]any{"success": false, "message": "连接邮件服务失败"})
		return "", false
	}
	if !ok {
		writeJSON(w, 401, map[string]any{"success": false, "message": "登录失败"})
	}
	return addr, ok
}

func (v *viewer) inboxAttachment(w http.ResponseWriter, r *http.Request) {
	addr, ok := v.queryMailbox(w, r)
	if !ok {
		return
	}
	name, ct, content, found, err := v.st.Attachment(addr, strings.ToLower(r.PathValue("id")), r.PathValue("att"))
	if err != nil || !found {
		if err != nil {
			log.Printf("attachment: %v", err)
		}
		writeJSON(w, 404, map[string]any{"success": false, "message": "附件下载接口不可用"})
		return
	}
	if q := r.URL.Query().Get("filename"); q != "" {
		name = q
	} else if name == "" {
		name = "attachment"
	}
	if ct == "" {
		ct = "application/octet-stream"
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Content-Disposition", "attachment; filename*=UTF-8''"+url.PathEscape(name))
	w.Header().Set("Content-Length", strconv.Itoa(len(content)))
	// The type comes from the sender and is served from our origin: never render it.
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
	w.Write(content)
}

// inboxSource: raw .eml is not stored (it never was); the page hides the button on 404.
func (v *viewer) inboxSource(w http.ResponseWriter, r *http.Request) {
	if _, ok := v.queryMailbox(w, r); ok {
		writeJSON(w, 404, map[string]any{"success": false, "message": "邮件原文接口不可用"})
	}
}

func (v *viewer) inboxBatch(w http.ResponseWriter, r *http.Request) {
	b, ok := v.body(w, r)
	if !ok {
		return
	}
	var ids []string
	if list, isList := b["message_ids"].([]any); isList {
		for _, id := range list {
			if s, isStr := id.(string); isStr {
				ids = append(ids, s)
			}
		}
	}
	if b.str("email") == "" || b.str("action") == "" || len(ids) == 0 {
		writeJSON(w, 200, map[string]any{"success": false, "message": "缺少必要参数"})
		return
	}
	if v.sensitive(w, r, "mail_mutation") {
		return
	}
	addr, ok := v.mailbox(w, b, "")
	if !ok {
		return
	}
	n, done, err := v.api.runBatch(addr, b.str("action"), ids)
	switch {
	case errors.Is(err, errNoIDs), errors.Is(err, errTooManyIDs):
		writeJSON(w, 200, map[string]any{"success": false, "message": err.Error()})
	case err != nil:
		internalError(w, err)
	case done == "":
		writeJSON(w, 200, map[string]any{"success": false, "message": "Unknown action: " + b.str("action")})
	default:
		writeJSON(w, 200, map[string]any{"success": true, "message": done, "count": n})
	}
}

func (v *viewer) inboxSearch(w http.ResponseWriter, r *http.Request) {
	b, ok := v.body(w, r)
	if !ok {
		return
	}
	addr, ok := v.mailbox(w, b, "query", "messages")
	if !ok {
		return
	}
	rows, err := v.st.SearchMessages(addr, b.str("query"))
	if err != nil {
		internalError(w, err, "messages")
		return
	}
	writeJSON(w, 200, map[string]any{"success": true, "messages": withCodes(rows)})
}

func (v *viewer) inboxDelete(w http.ResponseWriter, r *http.Request) {
	b, ok := v.body(w, r)
	if !ok {
		return
	}
	if b.str("email") == "" || b.str("message_id") == "" {
		writeJSON(w, 200, map[string]any{"success": false, "message": "缺少必要参数"})
		return
	}
	if v.sensitive(w, r, "mail_mutation") {
		return
	}
	addr, ok := v.mailbox(w, b, "message_id")
	if !ok {
		return
	}
	n, err := v.st.UpdateMessages(addr, []string{strings.ToLower(b.str("message_id"))}, "is_deleted = 1", false)
	switch {
	case err != nil:
		internalError(w, err)
	case n == 0:
		writeJSON(w, 200, map[string]any{"success": false, "message": "删除失败 (HTTP 404)"})
	default:
		writeJSON(w, 200, map[string]any{"success": true, "message": "邮件已删除"})
	}
}

func (v *viewer) trashQuery(w http.ResponseWriter, r *http.Request) {
	b, ok := v.body(w, r)
	if !ok {
		return
	}
	if b.str("email") == "" {
		writeJSON(w, 200, map[string]any{"success": false, "message": "缺少邮箱地址", "messages": []any{}})
		return
	}
	addr, ok := v.mailbox(w, b, "", "messages")
	if !ok {
		return
	}
	offset, limit := pageArgs(b)
	rows, total, err := v.st.ListMessages(addr, true, offset, limit)
	if err != nil {
		internalError(w, err, "messages")
		return
	}
	writeJSON(w, 200, map[string]any{"success": true, "messages": formatList(rows), "total": total, "offset": offset, "limit": limit})
}

// messageAction restores (set != "") or permanently deletes one message from trash.
func (v *viewer) messageAction(done, set string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if v.sensitive(w, r, "mail_mutation") {
			return
		}
		b, ok := v.body(w, r)
		if !ok {
			return
		}
		addr, ok := v.mailbox(w, b, "message_id")
		if !ok {
			return
		}
		ids := []string{strings.ToLower(b.str("message_id"))}
		var n int64
		var err error
		if set != "" {
			n, err = v.st.UpdateMessages(addr, ids, set, true)
		} else {
			n, err = v.st.PurgeMessages(addr, ids)
		}
		switch {
		case err != nil:
			internalError(w, err)
		case n == 0:
			writeJSON(w, 200, map[string]any{"success": false, "message": "Message not found"})
		default:
			writeJSON(w, 200, map[string]any{"success": true, "message": done, "id": ids[0]})
		}
	}
}

// ---- sent ----

func (v *viewer) sentDetail(w http.ResponseWriter, r *http.Request) {
	b, ok := v.body(w, r)
	if !ok {
		return
	}
	addr, ok := v.mailbox(w, b, "message_id")
	if !ok {
		return
	}
	row, err := v.st.Sent(addr, strings.ToLower(b.str("message_id")))
	if err != nil {
		internalError(w, err)
		return
	}
	if row == nil {
		writeJSON(w, 200, map[string]any{"success": false, "message": "Sent message not found"})
		return
	}
	row.HTML = prepareHTML(row.HTML)
	writeJSON(w, 200, map[string]any{"success": true, "detail": row})
}

func (v *viewer) sentQuery(w http.ResponseWriter, r *http.Request) {
	b, ok := v.body(w, r)
	if !ok {
		return
	}
	if b.str("email") == "" {
		writeJSON(w, 200, map[string]any{"success": false, "message": "缺少邮箱地址", "messages": []any{}})
		return
	}
	addr, ok := v.mailbox(w, b, "", "messages")
	if !ok {
		return
	}
	offset, limit := pageArgs(b)
	rows, total, err := v.st.ListSent(addr, offset, limit)
	if err != nil {
		internalError(w, err, "messages")
		return
	}
	for i := range rows {
		rows[i].HTML = prepareHTML(rows[i].HTML)
	}
	writeJSON(w, 200, map[string]any{"success": true, "messages": rows, "total": total, "offset": offset, "limit": limit})
}

// ---- domains ----

func (v *viewer) listDomains(w http.ResponseWriter, r *http.Request) {
	names, err := v.st.ActiveDomains()
	if err != nil {
		log.Printf("domains: %v", err)
		writeJSON(w, 502, map[string]any{"success": false, "message": "获取域名失败"})
		return
	}
	out := []map[string]any{}
	for _, d := range names {
		out = append(out, map[string]any{"domain": d, "is_active": true})
	}
	writeJSON(w, 200, map[string]any{"success": true, "domains": out})
}

func (v *viewer) addDomain(w http.ResponseWriter, r *http.Request) {
	b, ok := v.body(w, r)
	if !ok {
		return
	}
	domain := strings.ToLower(b.str("domain"))
	if domain == "" {
		writeJSON(w, 200, map[string]any{"success": false, "message": "域名不能为空"})
		return
	}
	if v.sensitive(w, r, "domain_admin") {
		return
	}
	if !strings.Contains(domain, ".") || len(domain) < 3 {
		writeJSON(w, 422, map[string]any{"success": false, "message": "Invalid domain format"})
		return
	}
	result, err := v.st.AddDomain(domain)
	switch {
	case err != nil:
		log.Printf("add domain: %v", err)
		writeJSON(w, 502, map[string]any{"success": false, "message": "添加域名失败"})
	case result == "exists":
		writeJSON(w, 409, map[string]any{"success": false, "message": fmt.Sprintf("Domain '%s' already exists", domain)})
	default:
		log.Printf("domain %s: %s", result, domain)
		writeJSON(w, 200, map[string]any{"success": true, "message": fmt.Sprintf("Domain '%s' %s", domain, result), "domain": domain})
	}
}

func (v *viewer) deleteDomain(w http.ResponseWriter, r *http.Request) {
	if v.sensitive(w, r, "domain_admin") {
		return
	}
	domain := strings.ToLower(strings.TrimSpace(r.PathValue("domain")))
	found, err := v.st.DeactivateDomain(domain)
	switch {
	case err != nil:
		log.Printf("delete domain: %v", err)
		writeJSON(w, 502, map[string]any{"success": false, "message": "删除域名失败"})
	case !found:
		writeJSON(w, 404, map[string]any{"success": false, "message": fmt.Sprintf("Domain '%s' not found", domain)})
	default:
		log.Printf("domain deactivated: %s", domain)
		writeJSON(w, 200, map[string]any{"success": true, "message": fmt.Sprintf("Domain '%s' deactivated", domain), "domain": domain})
	}
}

// ---- Resend keys per sending domain ----
// Stored encrypted with a key derived from SECRET_KEY (the same Fernet scheme as before);
// only re_…1234 is ever shown. A changed SECRET_KEY makes old keys unreadable.

var senderKeyRe = regexp.MustCompile(`^re_[A-Za-z0-9_-]{8,200}$`)

func keyHint(key string) string {
	if len(key) < 8 {
		return "…"
	}
	return key[:3] + "…" + key[len(key)-4:]
}

type storedKey struct {
	Key       string // "" when it cannot be decrypted
	Hint      string
	UpdatedAt *string
}

func (v *viewer) senderKeys() (map[string]storedKey, error) {
	rows, err := v.st.SenderKeys()
	out := map[string]storedKey{}
	for _, k := range rows {
		plain, _ := v.cipher.Decrypt(k.Ciphertext)
		out[k.Domain] = storedKey{string(plain), k.Hint, k.UpdatedAt}
	}
	return out, err
}

// resendKeyFor picks the settings key, then RESEND_API_KEY_<DOMAIN>, then RESEND_API_KEY.
func (v *viewer) resendKeyFor(domain string) (key, source string) {
	stored, err := v.senderKeys()
	if err != nil {
		log.Printf("sender keys: %v", err)
	}
	switch {
	case stored[domain].Key != "":
		return stored[domain].Key, "settings"
	case v.cfg.ResendDomainKeys[domain] != "":
		return v.cfg.ResendDomainKeys[domain], "env-domain"
	case v.cfg.ResendAPIKey != "":
		return v.cfg.ResendAPIKey, "env-default"
	}
	return "", "none"
}

func (v *viewer) listSenderKeys(w http.ResponseWriter, r *http.Request) {
	stored, err := v.senderKeys()
	active, err2 := v.st.ActiveDomains()
	if err != nil || err2 != nil {
		log.Printf("sender keys: %v %v", err, err2)
		writeJSON(w, 502, map[string]any{"success": false, "message": "连接邮件服务失败"})
		return
	}
	set := map[string]bool{}
	for _, d := range active {
		set[d] = true
	}
	for d := range stored {
		set[d] = true
	}
	for d, k := range v.cfg.ResendDomainKeys {
		if k != "" {
			set[d] = true
		}
	}
	domains := make([]string, 0, len(set))
	for d := range set {
		domains = append(domains, d)
	}
	sort.Strings(domains)
	items := []map[string]any{}
	for _, d := range domains {
		saved, has := stored[d]
		source, hint := "none", ""
		switch {
		case saved.Key != "":
			source, hint = "settings", saved.Hint
		case v.cfg.ResendDomainKeys[d] != "":
			source, hint = "env-domain", keyHint(v.cfg.ResendDomainKeys[d])
		case v.cfg.ResendAPIKey != "":
			source, hint = "env-default", keyHint(v.cfg.ResendAPIKey)
		}
		items = append(items, map[string]any{"domain": d, "source": source, "hint": hint,
			"unreadable": has && saved.Key == "", "updated_at": saved.UpdatedAt})
	}
	writeJSON(w, 200, map[string]any{"success": true, "domains": items})
}

// checkResendKey lists the account's domains once. Send-only keys may not list domains,
// which still proves the key is valid.
func (v *viewer) checkResendKey(ctx context.Context, key, domain string) (bool, string) {
	req, _ := http.NewRequestWithContext(ctx, "GET", v.resendURL+"/domains", nil)
	req.Header.Set("Authorization", "Bearer "+key)
	resp, err := v.upstream.Do(req)
	if err != nil {
		log.Printf("check resend key: %v", err)
		return false, "连接 Resend 失败，稍后再试"
	}
	defer resp.Body.Close()
	var body struct {
		Name, Message string
		Data          []struct{ Name, Status string }
	}
	json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&body)
	switch {
	case resp.StatusCode == 200:
		for _, d := range body.Data {
			if strings.ToLower(d.Name) == domain {
				if d.Status == "verified" {
					return true, "key 有效，域名已验证"
				}
				return true, "key 有效，域名在 Resend 的状态是 " + d.Status
			}
		}
		return true, "key 有效，但这个 Resend 账号里没有 " + domain + "，发信会被拒绝"
	case resp.StatusCode == 401 && body.Name == "restricted_api_key":
		return true, "key 有效（仅限发信权限，无法查看域名状态）"
	}
	msg := body.Message
	if msg == "" {
		msg = fmt.Sprintf("HTTP %d", resp.StatusCode)
	}
	return false, "Resend 拒绝了这个 key：" + msg
}

func (v *viewer) keyDomain(w http.ResponseWriter, r *http.Request) (string, bool) {
	if v.sensitive(w, r, "sender_key") {
		return "", false
	}
	d := strings.TrimSuffix(strings.ToLower(strings.TrimSpace(r.PathValue("domain"))), ".")
	if !senderDomainRe.MatchString(d) {
		writeJSON(w, 400, map[string]any{"success": false, "message": "invalid domain"})
		return "", false
	}
	return d, true
}

func (v *viewer) putSenderKey(w http.ResponseWriter, r *http.Request) {
	domain, ok := v.keyDomain(w, r)
	if !ok {
		return
	}
	b, ok := v.body(w, r)
	if !ok {
		return
	}
	key := b.str("api_key")
	if !senderKeyRe.MatchString(key) {
		writeJSON(w, 400, map[string]any{"success": false, "message": "Resend API key 应以 re_ 开头"})
		return
	}
	valid, info := v.checkResendKey(r.Context(), key, domain)
	if !valid {
		writeJSON(w, 400, map[string]any{"success": false, "message": info})
		return
	}
	if err := v.st.PutSenderKey(domain, v.cipher.Encrypt([]byte(key)), keyHint(key)); err != nil {
		log.Printf("save sender key: %v", err)
		writeJSON(w, 502, map[string]any{"success": false, "message": "保存失败"})
		return
	}
	log.Printf("sender key saved for %s", domain)
	writeJSON(w, 200, map[string]any{"success": true, "hint": keyHint(key), "message": info})
}

func (v *viewer) deleteSenderKey(w http.ResponseWriter, r *http.Request) {
	domain, ok := v.keyDomain(w, r)
	if !ok {
		return
	}
	if _, err := v.st.DeleteSenderKey(domain); err != nil {
		log.Printf("delete sender key: %v", err)
		writeJSON(w, 502, map[string]any{"success": false, "message": "删除失败"})
		return
	}
	writeJSON(w, 200, map[string]any{"success": true})
}

// ---- sending through Resend ----

type outAttachment struct {
	Filename    string `json:"filename"`
	Content     string `json:"content"`
	ContentType string `json:"content_type,omitempty"`
}

// normalizeAttachments checks the base64 attachments from the compose form.
func (v *viewer) normalizeAttachments(raw any) ([]outAttachment, string) {
	if raw == nil {
		return nil, ""
	}
	list, ok := raw.([]any)
	if !ok {
		return nil, "附件格式不正确"
	}
	if len(list) > v.cfg.MaxAttachmentCount {
		return nil, fmt.Sprintf("附件数量最多 %d 个", v.cfg.MaxAttachmentCount)
	}
	mb := func(n int64) int64 { return n / 1024 / 1024 }
	var out []outAttachment
	var total int64
	for _, item := range list {
		m, ok := item.(map[string]any)
		if !ok {
			return nil, "附件格式不正确"
		}
		filename := strings.TrimSpace(fmt.Sprint(m["filename"]))
		if m["filename"] == nil {
			filename = ""
		}
		content, _ := m["content"].(string)
		if filename == "" || content == "" {
			return nil, "附件缺少文件名或内容"
		}
		// Base name only: no path separators in Content-Disposition.
		filename = strings.ReplaceAll(filename, `\`, "/")
		filename = filename[strings.LastIndex(filename, "/")+1:]
		if r := []rune(filename); len(r) > 200 {
			filename = string(r[:200])
		}
		if filename == "" {
			return nil, "附件文件名不合法"
		}
		if strings.ContainsAny(content, "\r\n") {
			return nil, "附件 " + filename + " 编码不合法"
		}
		decoded, err := base64.StdEncoding.DecodeString(content)
		if err != nil {
			return nil, "附件 " + filename + " 编码不合法"
		}
		if int64(len(decoded)) > v.cfg.MaxAttachmentBytes {
			return nil, fmt.Sprintf("附件 %s 超过单个 %dMB 限制", filename, mb(v.cfg.MaxAttachmentBytes))
		}
		if total += int64(len(decoded)); total > v.cfg.MaxAttachmentTotalBytes {
			return nil, fmt.Sprintf("附件总大小超过 %dMB 限制", mb(v.cfg.MaxAttachmentTotalBytes))
		}
		a := outAttachment{Filename: filename, Content: content}
		if ct, _ := m["contentType"].(string); strings.TrimSpace(ct) != "" {
			a.ContentType = strings.TrimSpace(ct)
			if len(a.ContentType) > 100 {
				a.ContentType = a.ContentType[:100]
			}
		}
		out = append(out, a)
	}
	return out, ""
}

func (v *viewer) send(w http.ResponseWriter, r *http.Request) {
	if v.sensitive(w, r, "send_email") {
		return
	}
	b, ok := v.body(w, r)
	if !ok {
		return
	}
	reply := func(msg string) { writeJSON(w, 200, map[string]any{"success": false, "message": msg}) }
	from, name, to, subject := b.str("from_email"), b.str("from_name"), b.str("to"), b.str("subject")
	htmlBody, text, replyTo := b.str("html"), b.str("text"), b.str("reply_to")
	atts, problem := v.normalizeAttachments(b["attachments"])
	switch {
	case problem != "":
		reply(problem)
		return
	case from == "":
		reply("请填写发件人邮箱")
		return
	case to == "":
		reply("请填写收件人邮箱")
		return
	case subject == "":
		reply("请填写邮件主题")
		return
	case htmlBody == "" && text == "":
		reply("请填写邮件正文")
		return
	}
	domain := ""
	if i := strings.LastIndex(from, "@"); i >= 0 {
		domain = strings.ToLower(from[i+1:])
	}
	key, _ := v.resendKeyFor(domain)
	if key == "" {
		reply(fmt.Sprintf("域名 %s 未配置 Resend API Key，无法发信", domain))
		return
	}
	sender := from
	if name != "" {
		sender = name + " <" + from + ">"
	}
	toList := []string{}
	for _, a := range strings.Split(to, ",") {
		if a = strings.TrimSpace(a); a != "" {
			toList = append(toList, a)
		}
	}
	payload := map[string]any{"from": sender, "to": toList, "subject": subject}
	clean := ""
	if htmlBody != "" {
		clean = sanitizeEmailHTML(htmlBody)
		payload["html"] = clean
	}
	if text != "" {
		payload["text"] = text
	}
	if replyTo != "" {
		payload["reply_to"] = replyTo
	}
	if len(atts) > 0 {
		payload["attachments"] = atts
	}
	data, _ := json.Marshal(payload)
	req, _ := http.NewRequestWithContext(r.Context(), "POST", v.resendURL+"/emails", bytes.NewReader(data))
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Content-Type", "application/json")
	resp, err := v.upstream.Do(req)
	if err != nil {
		internalError(w, err)
		return
	}
	defer resp.Body.Close()
	var res struct{ ID, Message, Name string }
	decodeErr := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&res)
	if resp.StatusCode != 200 && resp.StatusCode != 201 {
		msg := res.Message
		if msg == "" {
			msg = res.Name
		}
		if decodeErr != nil || msg == "" {
			msg = fmt.Sprintf("发送失败 (HTTP %d)", resp.StatusCode)
		}
		reply(msg)
		return
	}
	toJSON, _ := json.Marshal(toList)
	sent := &SentRow{ID: newID(), FromAddress: strings.ToLower(from), To: toJSON, Subject: subject, Text: text,
		HTML: clean, ResendID: res.ID}
	if err := v.st.InsertSent(sent, time.Now()); err != nil {
		log.Printf("store sent message: %v", err) // the mail went out; only the record is missing
	}
	log.Printf("sent: %s -> %v | %s", from, toList, subject)
	writeJSON(w, 200, map[string]any{"success": true, "message": "邮件发送成功", "email_id": res.ID})
}
