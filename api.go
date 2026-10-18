package main

// DuckMail-compatible REST API, same paths, status codes and JSON shapes as the
// FastAPI mail-service. Errors are {"detail": ...} like FastAPI's HTTPException.

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/bcrypt"
)

type api struct {
	cfg    *Config
	st     *Store
	router *router // rules API under /router; nil in tests that do not need it

	mu   sync.Mutex
	rate map[string][]time.Time

	ipMu     sync.Mutex
	ipCached *string
	ipAt     time.Time

	lookup   lookupFunc    // swapped in tests
	detectIP func() string // swapped in tests
}

func newAPI(cfg *Config, st *Store) *api {
	return &api{cfg: cfg, st: st, rate: map[string][]time.Time{},
		lookup: publicLookup(4 * time.Second), detectIP: detectPublicIP}
}

// msgID reads a message id from the path; ids are lowercase hex, as ObjectId normalises them.
func msgID(r *http.Request) string { return strings.ToLower(r.PathValue("id")) }

func iso(msec int64) string {
	return time.UnixMilli(msec).UTC().Format("2006-01-02T15:04:05.000000Z")
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	enc.Encode(v)
}

func fail(w http.ResponseWriter, status int, detail any) {
	writeJSON(w, status, map[string]any{"detail": detail})
}

func serverError(w http.ResponseWriter, err error) {
	log.Printf("api error: %v", err)
	fail(w, 500, "Internal Server Error")
}

func readJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<20)).Decode(v); err != nil {
		fail(w, 400, "body must be JSON")
		return false
	}
	return true
}

func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// ---- JWT (HS256, compatible with tokens issued by PyJWT in the Python service) ----

var b64 = base64.RawURLEncoding

func (a *api) createToken(accountID, address string) string {
	header := b64.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))
	payload, _ := json.Marshal(map[string]any{
		"account_id": accountID, "address": address, "exp": time.Now().Add(24 * time.Hour).Unix(),
	})
	signing := header + "." + b64.EncodeToString(payload)
	return signing + "." + b64.EncodeToString(a.sign(signing))
}

func (a *api) sign(s string) []byte {
	mac := hmac.New(sha256.New, []byte(a.cfg.JWTSecret))
	mac.Write([]byte(s))
	return mac.Sum(nil)
}

var errExpired = errors.New("Token expired")

// decodeToken returns the address the token was issued for.
func (a *api) decodeToken(token string) (string, error) {
	invalid := errors.New("Invalid token")
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return "", invalid
	}
	var header struct{ Alg string }
	hb, err := b64.DecodeString(parts[0])
	if err != nil || json.Unmarshal(hb, &header) != nil || header.Alg != "HS256" {
		return "", invalid
	}
	sig, err := b64.DecodeString(parts[2])
	if err != nil || !hmac.Equal(sig, a.sign(parts[0]+"."+parts[1])) {
		return "", invalid
	}
	var claims struct {
		Address string   `json:"address"`
		Exp     *float64 `json:"exp"`
	}
	pb, err := b64.DecodeString(parts[1])
	if err != nil || json.Unmarshal(pb, &claims) != nil || claims.Address == "" {
		return "", invalid
	}
	if claims.Exp != nil && *claims.Exp <= float64(time.Now().Unix()) {
		return "", errExpired
	}
	return claims.Address, nil
}

// user wraps a handler that needs a mailbox login (Bearer JWT).
func (a *api) user(h func(w http.ResponseWriter, r *http.Request, addr string)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		if !strings.HasPrefix(auth, "Bearer ") {
			fail(w, 401, "Missing or invalid token")
			return
		}
		addr, err := a.decodeToken(auth[7:])
		if err != nil {
			fail(w, 401, err.Error())
			return
		}
		h(w, r, addr)
	}
}

// admin wraps a handler that needs API_KEY (Bearer or X-API-Key).
func (a *api) admin(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		key := ""
		if auth := r.Header.Get("Authorization"); strings.HasPrefix(auth, "Bearer ") {
			key = strings.TrimSpace(auth[7:])
		}
		if key == "" {
			key = strings.TrimSpace(r.Header.Get("X-API-Key"))
		}
		if a.cfg.APIKey == "" || subtle.ConstantTimeCompare([]byte(key), []byte(a.cfg.APIKey)) != 1 {
			fail(w, 403, "Invalid or missing API key")
			return
		}
		h(w, r)
	}
}

// limited applies RATE_LIMIT_MAX per client IP; container/private sources are skipped
// because the web UI proxies every user through one internal address.
func (a *api) limited(w http.ResponseWriter, r *http.Request) bool {
	ip := clientIP(r)
	if a.cfg.RateLimitMax <= 0 || isInternal(ip) {
		return false
	}
	a.mu.Lock()
	hitLimit := hit(a.rate, ip, a.cfg.RateLimitWindow, a.cfg.RateLimitMax, time.Now())
	a.mu.Unlock()
	if hitLimit {
		fail(w, 429, "Too many requests, please try again later")
	}
	return hitLimit
}

// page reads offset/limit; limit is capped at 100.
func page(w http.ResponseWriter, r *http.Request, defLimit int) (int, int, bool) {
	get := func(name string, def int) (int, bool) {
		v := r.URL.Query().Get(name)
		if v == "" {
			return def, true
		}
		n, err := strconv.Atoi(v)
		if err != nil {
			fail(w, 422, name+" must be an integer")
			return 0, false
		}
		return n, true
	}
	offset, ok1 := get("offset", 0)
	if !ok1 {
		return 0, 0, false
	}
	limit, ok2 := get("limit", defLimit)
	if !ok2 {
		return 0, 0, false
	}
	return max(offset, 0), min(max(limit, 1), 100), true
}

var objectID = regexp.MustCompile(`^[0-9a-fA-F]{24}$`)

func (a *api) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", a.health)
	mux.HandleFunc("GET /domains", a.domains)
	mux.HandleFunc("POST /accounts", a.createAccount)
	mux.HandleFunc("POST /token", a.login)

	mux.HandleFunc("GET /admin/domains", a.admin(a.adminDomains))
	mux.HandleFunc("POST /admin/domains", a.admin(a.adminAddDomain))
	mux.HandleFunc("DELETE /admin/domains/{domain}", a.admin(a.adminDeleteDomain))
	mux.HandleFunc("GET /admin/sender-keys", a.admin(a.listSenderKeys))
	mux.HandleFunc("PUT /admin/sender-keys/{domain}", a.admin(a.putSenderKey))
	mux.HandleFunc("DELETE /admin/sender-keys/{domain}", a.admin(a.deleteSenderKey))
	mux.HandleFunc("GET /admin/dns-check", a.admin(a.dnsCheck))
	mux.HandleFunc("POST /admin/sent", a.admin(a.storeSent))

	mux.HandleFunc("GET /messages", a.user(a.listMessages(false)))
	mux.HandleFunc("GET /messages/trash", a.user(a.listMessages(true)))
	mux.HandleFunc("GET /messages/search", a.user(a.search))
	mux.HandleFunc("GET /messages/{id}", a.user(a.getMessage))
	mux.HandleFunc("GET /messages/{id}/attachments/{att}", a.user(a.attachment))
	mux.HandleFunc("POST /messages/{id}/restore", a.user(a.restore))
	mux.HandleFunc("DELETE /messages/{id}/permanent", a.user(a.purge))
	mux.HandleFunc("DELETE /messages/{id}", a.user(a.trash))
	mux.HandleFunc("POST /messages/batch", a.user(a.batch))
	mux.HandleFunc("GET /sent", a.user(a.listSent))
	mux.HandleFunc("GET /sent/{id}", a.user(a.getSent))
	if a.router != nil {
		mux.Handle("/router/", a.router.handler(true)) // IMAP bridge: ROUTER_URL=http://<host>:8080/router
	}
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) { fail(w, 404, "Not Found") })
	return a.cors(mux)
}

// cors mirrors Starlette's CORSMiddleware with allow_methods/allow_headers "*".
func (a *api) cors(next http.Handler) http.Handler {
	allowAll := false
	allowed := map[string]bool{}
	for _, o := range a.cfg.CORSOrigins {
		allowed[o] = true
		allowAll = allowAll || o == "*"
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin == "" {
			next.ServeHTTP(w, r)
			return
		}
		ok := allowAll || allowed[origin]
		if ok {
			if allowAll {
				w.Header().Set("Access-Control-Allow-Origin", "*")
			} else {
				w.Header().Set("Access-Control-Allow-Origin", origin)
				w.Header().Add("Vary", "Origin")
			}
		}
		if r.Method == http.MethodOptions && r.Header.Get("Access-Control-Request-Method") != "" {
			if !ok {
				http.Error(w, "Disallowed CORS origin", 400)
				return
			}
			w.Header().Set("Access-Control-Allow-Methods", "DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT")
			if h := r.Header.Get("Access-Control-Request-Headers"); h != "" {
				w.Header().Set("Access-Control-Allow-Headers", h)
			}
			w.Header().Set("Access-Control-Max-Age", "600")
			w.WriteHeader(200)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// ---- public ----

func (a *api) health(w http.ResponseWriter, r *http.Request) {
	out := map[string]any{"status": "ok"}
	if a.cfg.HealthDetails {
		domains, err := a.st.ActiveDomains()
		if err != nil {
			serverError(w, err)
			return
		}
		out["domains"] = domains
	}
	writeJSON(w, 200, out)
}

func (a *api) domains(w http.ResponseWriter, r *http.Request) {
	names, err := a.st.ActiveDomains()
	if err != nil {
		serverError(w, err)
		return
	}
	members := []map[string]any{}
	for _, d := range names {
		members = append(members, map[string]any{
			"@id": "/domains/" + d, "@type": "Domain", "domain": d, "isActive": true, "isPrivate": false,
		})
	}
	writeJSON(w, 200, map[string]any{"hydra:member": members})
}

type credentials struct {
	Address  string `json:"address"`
	Password string `json:"password"`
}

const addressUsed = "This address is already used."

// newAccount validates and creates a mailbox. problem is the user-facing reason
// (DuckMail's hydra:description) when it is refused; err is an internal failure.
func (a *api) newAccount(addr, password string) (id string, now time.Time, problem string, err error) {
	if addr == "" || password == "" {
		return "", now, "Address and password are required", nil
	}
	at := strings.Index(addr, "@")
	if at < 0 {
		return "", now, "Invalid email address format", nil
	}
	domain := addr[at+1:]
	if ok, err := a.st.DomainActive(domain); err != nil || !ok {
		return "", now, fmt.Sprintf("Domain '%s' is not available", domain), err
	}
	if exists, err := a.st.AccountExists(addr); err != nil || exists {
		return "", now, addressUsed, err
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if errors.Is(err, bcrypt.ErrPasswordTooLong) {
		return "", now, "Password must be at most 72 bytes", nil
	} else if err != nil {
		return "", now, "", err
	}
	id, now = newID(), time.Now().UTC()
	if err := a.st.CreateAccount(id, addr, string(hash), now); errors.Is(err, errExists) {
		return "", now, addressUsed, nil
	} else if err != nil {
		return "", now, "", err
	}
	log.Printf("account created: %s", addr)
	return id, now, "", nil
}

func (a *api) createAccount(w http.ResponseWriter, r *http.Request) {
	if a.limited(w, r) {
		return
	}
	var c credentials
	if !readJSON(w, r, &c) {
		return
	}
	addr := strings.ToLower(strings.TrimSpace(c.Address))
	id, now, problem, err := a.newAccount(addr, c.Password)
	switch {
	case err != nil:
		serverError(w, err)
	case problem == addressUsed:
		fail(w, 422, map[string]any{"hydra:description": problem, "violations": []map[string]string{{"message": problem}}})
	case problem != "":
		fail(w, 422, map[string]any{"hydra:description": problem})
	default:
		ts := iso(ms(now))
		writeJSON(w, 201, map[string]any{"id": id, "address": addr, "isActive": true, "isSilenced": false,
			"createdAt": ts, "updatedAt": ts})
	}
}

func (a *api) login(w http.ResponseWriter, r *http.Request) {
	if a.limited(w, r) {
		return
	}
	var c credentials
	if !readJSON(w, r, &c) {
		return
	}
	addr := strings.ToLower(strings.TrimSpace(c.Address))
	id, hash, found, err := a.st.Account(addr)
	if err != nil {
		serverError(w, err)
		return
	}
	if !found || bcrypt.CompareHashAndPassword([]byte(hash), []byte(c.Password)) != nil {
		fail(w, 401, "Invalid credentials")
		return
	}
	writeJSON(w, 200, map[string]string{"token": a.createToken(id, addr)})
}

// ---- admin ----

func (a *api) adminDomains(w http.ResponseWriter, r *http.Request) {
	rows, err := a.st.Domains(false)
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"domains": rows})
}

func (a *api) adminAddDomain(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Domain string `json:"domain"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	domain := strings.ToLower(strings.TrimSpace(body.Domain))
	if domain == "" {
		fail(w, 422, "Domain is required")
		return
	}
	if !strings.Contains(domain, ".") || len(domain) < 3 {
		fail(w, 422, "Invalid domain format")
		return
	}
	result, err := a.st.AddDomain(domain)
	switch {
	case err != nil:
		serverError(w, err)
	case result == "exists":
		fail(w, 409, fmt.Sprintf("Domain '%s' already exists", domain))
	case result == "reactivated":
		writeJSON(w, 200, map[string]string{"message": fmt.Sprintf("Domain '%s' reactivated", domain), "domain": domain})
	default:
		log.Printf("domain added: %s", domain)
		writeJSON(w, 201, map[string]string{"message": fmt.Sprintf("Domain '%s' added", domain), "domain": domain})
	}
}

func (a *api) adminDeleteDomain(w http.ResponseWriter, r *http.Request) {
	domain := strings.ToLower(strings.TrimSpace(r.PathValue("domain")))
	found, err := a.st.DeactivateDomain(domain)
	if err != nil {
		serverError(w, err)
		return
	}
	if !found {
		fail(w, 404, fmt.Sprintf("Domain '%s' not found", domain))
		return
	}
	log.Printf("domain deactivated: %s", domain)
	writeJSON(w, 200, map[string]string{"message": fmt.Sprintf("Domain '%s' deactivated", domain), "domain": domain})
}

var senderDomainRe = regexp.MustCompile(`^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$`)

func senderDomain(w http.ResponseWriter, r *http.Request) (string, bool) {
	d := strings.TrimSuffix(strings.ToLower(strings.TrimSpace(r.PathValue("domain"))), ".")
	if !senderDomainRe.MatchString(d) {
		fail(w, 400, "invalid domain")
		return "", false
	}
	return d, true
}

func (a *api) listSenderKeys(w http.ResponseWriter, r *http.Request) {
	keys, err := a.st.SenderKeys()
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"keys": keys})
}

func (a *api) putSenderKey(w http.ResponseWriter, r *http.Request) {
	domain, ok := senderDomain(w, r)
	if !ok {
		return
	}
	var body struct {
		Ciphertext string `json:"ciphertext"`
		Hint       string `json:"hint"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if body.Ciphertext == "" || len(body.Ciphertext) > 4096 {
		fail(w, 400, "ciphertext is required")
		return
	}
	hint := []rune(body.Hint)
	if len(hint) > 40 {
		hint = hint[:40]
	}
	if err := a.st.PutSenderKey(domain, body.Ciphertext, string(hint)); err != nil {
		serverError(w, err)
		return
	}
	log.Printf("sender key saved for %s", domain)
	writeJSON(w, 200, map[string]string{"domain": domain})
}

func (a *api) deleteSenderKey(w http.ResponseWriter, r *http.Request) {
	domain, ok := senderDomain(w, r)
	if !ok {
		return
	}
	found, err := a.st.DeleteSenderKey(domain)
	if err != nil {
		serverError(w, err)
		return
	}
	if !found {
		fail(w, 404, "no key for this domain")
		return
	}
	log.Printf("sender key removed for %s", domain)
	writeJSON(w, 200, map[string]string{"domain": domain})
}

// dnsReport runs the DNS self-check; problem is set when ipParam is not an IP.
func (a *api) dnsReport(ipParam string) (report dnsReport, problem string, err error) {
	ip := strings.TrimSpace(ipParam)
	if ip == "" {
		ip = a.cfg.PublicIP
	}
	var ipPtr *string
	if ip != "" {
		if _, err := netip.ParseAddr(ip); err != nil {
			return report, "ip is not a valid IP address", nil
		}
		ipPtr = &ip
	} else {
		a.ipMu.Lock()
		if a.ipCached == nil || time.Since(a.ipAt) > time.Hour {
			if v := a.detectIP(); v != "" {
				a.ipCached = &v
			} else {
				a.ipCached = nil
			}
			a.ipAt = time.Now()
		}
		ipPtr = a.ipCached
		a.ipMu.Unlock()
	}
	active, err := a.st.ActiveDomains()
	if err != nil {
		return report, "", err
	}
	set := map[string]bool{}
	for _, d := range append(active, a.cfg.Domains...) {
		set[d] = true
	}
	domains := make([]string, 0, len(set))
	for d := range set {
		domains = append(domains, d)
	}
	sort.Strings(domains)
	return runDNSCheck(a.lookup, domains, ipPtr, a.cfg.WebHost, a.cfg.Hostname), "", nil
}

func (a *api) dnsCheck(w http.ResponseWriter, r *http.Request) {
	report, problem, err := a.dnsReport(r.URL.Query().Get("ip"))
	switch {
	case err != nil:
		serverError(w, err)
	case problem != "":
		fail(w, 400, problem)
	default:
		writeJSON(w, 200, report)
	}
}

func (a *api) storeSent(w http.ResponseWriter, r *http.Request) {
	var body struct {
		FromAddress string `json:"from_address"`
		To          any    `json:"to"`
		Subject     string `json:"subject"`
		Text        string `json:"text"`
		HTML        string `json:"html"`
		ResendID    string `json:"resend_id"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	from := strings.ToLower(strings.TrimSpace(body.FromAddress))
	to, isList := body.To.([]any)
	empty := body.To == nil || body.To == "" || (isList && len(to) == 0)
	if from == "" || empty {
		fail(w, 422, "from_address and to are required")
		return
	}
	if !isList {
		to = []any{body.To}
	}
	toJSON, _ := json.Marshal(to)
	row := &SentRow{ID: newID(), FromAddress: from, To: toJSON, Subject: body.Subject, Text: body.Text,
		HTML: body.HTML, ResendID: body.ResendID}
	if err := a.st.InsertSent(row, time.Now()); err != nil {
		serverError(w, err)
		return
	}
	log.Printf("sent message stored: %s -> %s", from, toJSON)
	writeJSON(w, 201, map[string]string{"id": row.ID, "message": "Stored"})
}

// ---- mailbox ----

type addrJSON struct {
	Address string `json:"address"`
	Name    string `json:"name"`
}

type attJSON struct {
	ID           string `json:"id"`
	Filename     string `json:"filename"`
	ContentType  string `json:"contentType"`
	ContentType2 string `json:"content_type"`
	Size         int64  `json:"size"`
	DownloadURL  string `json:"downloadUrl"`
}

type msgJSON struct {
	Context        string     `json:"@context"`
	AtID           string     `json:"@id"`
	Type           string     `json:"@type"`
	ID             string     `json:"id"`
	MsgID          string     `json:"msgid"`
	From           addrJSON   `json:"from"`
	To             []addrJSON `json:"to"`
	Subject        string     `json:"subject"`
	Intro          string     `json:"intro"`
	HasAttachments bool       `json:"hasAttachments"`
	Seen           bool       `json:"seen"`
	IsDeleted      bool       `json:"isDeleted"`
	Size           int64      `json:"size"`
	CreatedAt      string     `json:"createdAt"`
	UpdatedAt      string     `json:"updatedAt"`
	Text           *string    `json:"text,omitempty"`
	HTML           *string    `json:"html,omitempty"`
	Attachments    *[]attJSON `json:"attachments,omitempty"`
}

func formatMessage(m *MsgRow) msgJSON {
	to := []addrJSON{}
	for _, a := range m.To {
		to = append(to, addrJSON{Address: a})
	}
	return msgJSON{Context: "/contexts/Message", AtID: "/messages/" + m.ID, Type: "Message", ID: m.ID, MsgID: m.ID,
		From: addrJSON{m.FromAddress, m.FromName}, To: to, Subject: m.Subject, Intro: m.Intro,
		HasAttachments: m.HasAtt, Seen: m.Seen, IsDeleted: m.Deleted, Size: m.Size,
		CreatedAt: iso(m.Created), UpdatedAt: iso(m.Updated)}
}

func formatList(rows []MsgRow) []msgJSON {
	out := make([]msgJSON, 0, len(rows))
	for i := range rows {
		out = append(out, formatMessage(&rows[i]))
	}
	return out
}

func (a *api) listMessages(trash bool) func(http.ResponseWriter, *http.Request, string) {
	return func(w http.ResponseWriter, r *http.Request, addr string) {
		offset, limit, ok := page(w, r, 30)
		if !ok {
			return
		}
		rows, total, err := a.st.ListMessages(addr, trash, offset, limit)
		if err != nil {
			serverError(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"hydra:member": formatList(rows), "hydra:totalItems": total,
			"offset": offset, "limit": limit})
	}
}

func (a *api) search(w http.ResponseWriter, r *http.Request, addr string) {
	q := r.URL.Query().Get("q")
	if strings.TrimSpace(q) == "" {
		writeJSON(w, 200, map[string]any{"hydra:member": []any{}})
		return
	}
	rows, err := a.st.SearchMessages(addr, q)
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"hydra:member": formatList(rows)})
}

func (a *api) getMessage(w http.ResponseWriter, r *http.Request, addr string) {
	id := msgID(r)
	m, atts, err := a.st.Message(addr, id)
	if err != nil {
		serverError(w, err)
		return
	}
	if m == nil {
		fail(w, 404, "Message not found")
		return
	}
	if !m.Seen {
		if _, err := a.st.UpdateMessages(addr, []string{id}, "seen = 1", false); err != nil {
			log.Printf("mark seen %s: %v", id, err)
		}
	}
	out := formatMessage(m) // seen/updatedAt as they were before this read, like the Python service
	list := []attJSON{}
	for _, at := range atts {
		list = append(list, attJSON{ID: at.ID, Filename: at.Filename, ContentType: at.ContentType, ContentType2: at.ContentType,
			Size: at.Size, DownloadURL: "/messages/" + id + "/attachments/" + at.ID})
	}
	out.Text, out.HTML, out.Attachments = &m.Text, &m.HTML, &list
	writeJSON(w, 200, out)
}

func (a *api) attachment(w http.ResponseWriter, r *http.Request, addr string) {
	name, ct, content, found, err := a.st.Attachment(addr, msgID(r), r.PathValue("att"))
	if err != nil {
		serverError(w, err)
		return
	}
	if !found {
		// Same two messages as before, decided without leaking which one exists.
		if m, _, _ := a.st.Message(addr, msgID(r)); m == nil {
			fail(w, 404, "Message not found")
		} else {
			fail(w, 404, "Attachment not found")
		}
		return
	}
	if name == "" {
		name = "attachment"
	}
	if ct == "" {
		ct = "application/octet-stream"
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Content-Disposition", "attachment; filename*=UTF-8''"+url.PathEscape(name))
	w.Header().Set("Content-Length", strconv.Itoa(len(content)))
	w.Write(content)
}

func (a *api) restore(w http.ResponseWriter, r *http.Request, addr string) {
	a.single(w, r, addr, "Restored", func(ids []string) (int64, error) {
		return a.st.UpdateMessages(addr, ids, "is_deleted = 0", true)
	})
}

func (a *api) trash(w http.ResponseWriter, r *http.Request, addr string) {
	a.single(w, r, addr, "Deleted", func(ids []string) (int64, error) {
		return a.st.UpdateMessages(addr, ids, "is_deleted = 1", false)
	})
}

func (a *api) purge(w http.ResponseWriter, r *http.Request, addr string) {
	a.single(w, r, addr, "Permanently deleted", func(ids []string) (int64, error) {
		return a.st.PurgeMessages(addr, ids)
	})
}

func (a *api) single(w http.ResponseWriter, r *http.Request, addr, done string, op func([]string) (int64, error)) {
	id := msgID(r)
	n, err := op([]string{id})
	if err != nil {
		serverError(w, err)
		return
	}
	if n == 0 {
		fail(w, 404, "Message not found")
		return
	}
	log.Printf("message %s: %s by %s", strings.ToLower(done), id, addr)
	writeJSON(w, 200, map[string]string{"message": done, "id": id})
}

// runBatch applies a batch action to addr's messages; done is "" for an unknown action.
func (a *api) runBatch(addr, action string, given []string) (n int64, done string, err error) {
	ids := []string{}
	for _, id := range given {
		if objectID.MatchString(id) {
			ids = append(ids, strings.ToLower(id))
		}
	}
	if len(ids) == 0 {
		return 0, "", errNoIDs
	}
	if len(ids) > maxBatch { // SQLite caps the number of bound values per statement
		return 0, "", errTooManyIDs
	}
	switch action {
	case "delete":
		n, err = a.st.UpdateMessages(addr, ids, "is_deleted = 1", false)
		done = "Deleted %d messages"
	case "mark_read":
		n, err = a.st.UpdateMessages(addr, ids, "seen = 1", false)
		done = "Marked %d as read"
	case "restore":
		n, err = a.st.UpdateMessages(addr, ids, "is_deleted = 0", true)
		done = "Restored %d messages"
	case "permanent_delete", "delete_permanent":
		n, err = a.st.PurgeMessages(addr, ids)
		done = "Permanently deleted %d messages"
	default:
		return 0, "", nil
	}
	if err == nil {
		log.Printf("batch %s: %d messages by %s", action, n, addr)
	}
	return n, fmt.Sprintf(done, n), err
}

var errNoIDs = errors.New("No valid message IDs")

const maxBatch = 1000

var errTooManyIDs = fmt.Errorf("At most %d message IDs per request", maxBatch)

func (a *api) batch(w http.ResponseWriter, r *http.Request, addr string) {
	var body struct {
		Action     string   `json:"action"`
		MessageIDs []string `json:"message_ids"`
		IDs        []string `json:"ids"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	given := body.MessageIDs
	if given == nil {
		given = body.IDs
	}
	if len(given) == 0 {
		fail(w, 422, "message_ids is required")
		return
	}
	n, done, err := a.runBatch(addr, body.Action, given)
	switch {
	case errors.Is(err, errNoIDs), errors.Is(err, errTooManyIDs):
		fail(w, 422, err.Error())
	case err != nil:
		serverError(w, err)
	case done == "":
		fail(w, 422, "Unknown action: "+body.Action)
	default:
		writeJSON(w, 200, map[string]any{"message": done, "count": n})
	}
}

func (a *api) listSent(w http.ResponseWriter, r *http.Request, addr string) {
	offset, limit, ok := page(w, r, 100)
	if !ok {
		return
	}
	rows, total, err := a.st.ListSent(addr, offset, limit)
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"hydra:member": rows, "hydra:totalItems": total, "offset": offset, "limit": limit})
}

func (a *api) getSent(w http.ResponseWriter, r *http.Request, addr string) {
	row, err := a.st.Sent(addr, msgID(r))
	if err != nil {
		serverError(w, err)
		return
	}
	if row == nil {
		fail(w, 404, "Sent message not found")
		return
	}
	writeJSON(w, 200, row)
}
