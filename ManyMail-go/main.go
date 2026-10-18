// ManyMail in one process: SMTP receiver, SQLite store and the DuckMail-compatible HTTP API.
package main

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// Config keeps the same environment variable names as the Python mail-service,
// so the existing .env works unchanged. DB_PATH is new.
type Config struct {
	DBPath, Hostname, SMTPAddr string
	TLSCert, TLSKey            string
	Domains                    []string
	TTL                        time.Duration // 0 = keep forever

	MaxMessageBytes int64
	MaxAddrLen      int
	MaxRcpts        int
	RcptRateMax     int
	RcptRateWindow  time.Duration
	DataRateMax     int
	DataRateWindow  time.Duration

	BlacklistIPs, BlacklistSenders map[string]bool

	SpamEnabled                      bool
	SpamSenders                      map[string]bool
	SpamSubject, SpamBody, SpamLinks []string

	GreyEnabled        bool
	GreyDelay, GreyTTL time.Duration

	Loopback map[string]bool

	// HTTP API
	APIAddr, JWTSecret, APIKey string
	RouterAddr                 string // old mail-router port, for the IMAP bridge; "" = off
	Production, HealthDetails  bool
	CORSOrigins                []string
	RateLimitMax               int
	RateLimitWindow            time.Duration
	PublicIP, WebHost          string

	// Web UI (was mail-viewer); same variable names.
	ViewerAddr, SecretKey, AccessPassword, UnifiedPassword string
	AutoCreateAccounts                                     bool
	LoginRateMax, SensitiveRateMax                         int
	LoginRateWindow, SensitiveRateWindow                   time.Duration
	ResendAPIKey                                           string
	ResendDomainKeys                                       map[string]string
	MaxImageProxyBytes, MaxContentLength                   int64
	MaxAttachmentBytes, MaxAttachmentTotalBytes            int64
	MaxAttachmentCount                                     int
	IMAPURL                                                string

	// Rules engine (was mail-router).
	RouterPoll, RouterRetry time.Duration
	RouterMaxAttempts       int
	ViewerPublicURL         string // link in push notifications
}

const (
	defaultJWTSecret = "change-this-in-production"
	defaultSecretKey = "mail-viewer-secret-key-change-me"
)

// check enforces the same production requirements as the Python service.
func (c *Config) check() error {
	if !c.Production {
		return nil
	}
	switch {
	case c.JWTSecret == "" || c.JWTSecret == defaultJWTSecret:
		return errors.New("JWT_SECRET must be configured for production")
	case c.APIKey == "":
		return errors.New("API_KEY must be configured for production")
	case len(c.CORSOrigins) == 0:
		return errors.New("CORS_ORIGINS must be configured for production")
	case c.SecretKey == "" || c.SecretKey == defaultSecretKey:
		return errors.New("SECRET_KEY must be configured for production")
	case c.AccessPassword == "":
		return errors.New("ACCESS_PASSWORD must be configured for production")
	case c.UnifiedPassword == "":
		return errors.New("UNIFIED_PASSWORD must be configured for production")
	}
	return nil
}

func env(name, def string) string {
	if v, ok := os.LookupEnv(name); ok {
		return strings.TrimSpace(v)
	}
	return def
}

func envInt(name string, def int) int {
	v := env(name, "")
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		log.Fatalf("%s must be an integer, got %q", name, v)
	}
	return n
}

func envFlag(name string, def bool) bool {
	v, ok := os.LookupEnv(name)
	if !ok {
		return def
	}
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}

func envList(name, sep string) []string {
	var out []string
	for _, item := range strings.Split(env(name, ""), sep) {
		if item = strings.ToLower(strings.TrimSpace(item)); item != "" {
			out = append(out, item)
		}
	}
	return out
}

func toSet(items []string) map[string]bool {
	set := map[string]bool{}
	for _, item := range items {
		set[item] = true
	}
	return set
}

func parseTTLDays(v string) (time.Duration, bool) {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "0", "none", "never", "infinite", "forever", "off", "disabled":
		return 0, true
	}
	days, err := strconv.Atoi(strings.TrimSpace(v))
	if err != nil {
		return 0, false
	}
	if days <= 0 {
		return 0, true
	}
	return time.Duration(days) * 24 * time.Hour, true
}

// routerAddr: ROUTER_API_PORT (default 8090), 0 turns the extra listener off.
func routerAddr() string {
	if port := envInt("ROUTER_API_PORT", 8090); port > 0 {
		return ":" + strconv.Itoa(port)
	}
	return ""
}

func loadConfig() *Config {
	ttl, ok := parseTTLDays(env("MESSAGE_TTL_DAYS", "3"))
	if !ok {
		log.Fatal("MESSAGE_TTL_DAYS must be a positive integer, or 0/forever to disable cleanup")
	}
	sec := func(name string, def int) time.Duration { return time.Duration(envInt(name, def)) * time.Second }

	// IP blacklist entries are kept as written (not lowercased), like the Python version.
	ips := map[string]bool{}
	for _, item := range strings.Split(env("SMTP_BLACKLIST_IPS", ""), ",") {
		if item = strings.TrimSpace(item); item != "" {
			ips[item] = true
		}
	}
	loop := map[string]bool{}
	for _, a := range append(envList("FORWARD_TO_ADDRESS", ","), envList("PAYPAL_FORWARD_TO_ADDRESS", ",")...) {
		if strings.Contains(a, "@") {
			loop[a] = true
		}
	}

	production := strings.ToLower(env("ENVIRONMENT", "development")) == "production"
	var cors []string
	for _, o := range strings.Split(env("CORS_ORIGINS", ""), ",") {
		if o = strings.TrimSpace(o); o != "" {
			cors = append(cors, o)
		}
	}
	if len(cors) == 0 && !production {
		cors = []string{"*"}
	}
	attMax := envInt("MAX_ATTACHMENT_BYTES", 5<<20) // before base64
	attTotal := envInt("MAX_ATTACHMENT_TOTAL_BYTES", 10<<20)

	return &Config{
		DBPath:   env("DB_PATH", "data/manymail.db"),
		Hostname: env("SMTP_HOSTNAME", "mail.example.com"),
		SMTPAddr: ":" + strconv.Itoa(envInt("SMTP_PORT", 25)),
		TLSCert:  env("SMTP_TLS_CERT", ""),
		TLSKey:   env("SMTP_TLS_KEY", ""),
		Domains:  envList("DOMAINS", ","),
		TTL:      ttl,

		MaxMessageBytes: int64(envInt("SMTP_MAX_MESSAGE_BYTES", 10*1024*1024)),
		MaxAddrLen:      envInt("SMTP_MAX_ADDRESS_LENGTH", 320),
		MaxRcpts:        envInt("SMTP_MAX_RCPTS_PER_MESSAGE", 20),
		RcptRateMax:     envInt("SMTP_RCPT_RATE_MAX", 100),
		RcptRateWindow:  sec("SMTP_RCPT_RATE_WINDOW", 60),
		DataRateMax:     envInt("SMTP_DATA_RATE_MAX", 20),
		DataRateWindow:  sec("SMTP_DATA_RATE_WINDOW", 60),

		BlacklistIPs:     ips,
		BlacklistSenders: toSet(envList("SMTP_BLACKLIST_SENDERS", ",")),

		SpamEnabled: envFlag("SMTP_SPAM_TRASH_ENABLED", false),
		SpamSenders: toSet(envList("SMTP_SPAM_TRASH_SENDERS", "|")),
		SpamSubject: envList("SMTP_SPAM_TRASH_SUBJECT_PHRASES", "|"),
		SpamBody:    envList("SMTP_SPAM_TRASH_BODY_PHRASES", "|"),
		SpamLinks:   envList("SMTP_SPAM_TRASH_LINK_DOMAINS", "|"),

		GreyEnabled: envFlag("SMTP_GREYLIST_ENABLED", false),
		GreyDelay:   sec("SMTP_GREYLIST_DELAY_SECONDS", 60),
		GreyTTL:     sec("SMTP_GREYLIST_TTL_SECONDS", 3600),

		Loopback: loop,

		APIAddr:         ":" + strconv.Itoa(envInt("API_PORT", 8080)),
		RouterAddr:      routerAddr(),
		JWTSecret:       env("JWT_SECRET", defaultJWTSecret),
		APIKey:          env("API_KEY", ""),
		Production:      production,
		HealthDetails:   envFlag("EXPOSE_HEALTH_DETAILS", !production),
		CORSOrigins:     cors,
		RateLimitMax:    envInt("RATE_LIMIT_MAX", 60),
		RateLimitWindow: sec("RATE_LIMIT_WINDOW", 60),
		PublicIP:        env("PUBLIC_IP", ""),
		WebHost:         env("MAIL_WEB_HOST", ""),

		ViewerAddr:              ":" + strconv.Itoa(envInt("VIEWER_PORT", 5000)),
		SecretKey:               env("SECRET_KEY", defaultSecretKey),
		AccessPassword:          env("ACCESS_PASSWORD", ""),
		UnifiedPassword:         env("UNIFIED_PASSWORD", "openai123456"),
		AutoCreateAccounts:      envFlag("AUTO_CREATE_ACCOUNTS", !production),
		LoginRateMax:            envInt("LOGIN_RATE_LIMIT_MAX", 10),
		LoginRateWindow:         sec("LOGIN_RATE_LIMIT_WINDOW", 300),
		SensitiveRateMax:        envInt("SENSITIVE_RATE_LIMIT_MAX", 20),
		SensitiveRateWindow:     sec("SENSITIVE_RATE_LIMIT_WINDOW", 60),
		ResendAPIKey:            env("RESEND_API_KEY", ""),
		ResendDomainKeys:        map[string]string{"cnhealthtourism.com": env("RESEND_API_KEY_CNHEALTHTOURISM", "")},
		MaxImageProxyBytes:      int64(envInt("MAX_IMAGE_PROXY_BYTES", 5<<20)),
		MaxAttachmentBytes:      int64(attMax),
		MaxAttachmentTotalBytes: int64(attTotal),
		MaxAttachmentCount:      envInt("MAX_ATTACHMENT_COUNT", 10),
		// base64 grows by 4/3, plus room for the body and other fields
		MaxContentLength: int64(envInt("MAX_CONTENT_LENGTH", attTotal*4/3+2<<20)),
		IMAPURL:          strings.TrimRight(env("IMAP_MAIL_BASE_URL", "http://imap-mail:3939"), "/"),
		// Old FORWARD_* names still work as fallbacks.
		RouterPoll:        time.Duration(max(2, envInt("ROUTER_POLL_SECONDS", envInt("FORWARD_POLL_SECONDS", 5)))) * time.Second,
		RouterRetry:       time.Duration(max(15, envInt("ROUTER_RETRY_SECONDS", envInt("FORWARD_RETRY_SECONDS", 60)))) * time.Second,
		RouterMaxAttempts: max(1, envInt("ROUTER_MAX_ATTEMPTS", 12)),
		ViewerPublicURL:   env("VIEWER_PUBLIC_URL", ""),
	}
}

// newID returns a 24-hex id in ObjectId layout (4-byte timestamp + 8 random bytes),
// so ids imported from MongoDB and new ones look and sort the same.
func newID() string {
	var b [12]byte
	binary.BigEndian.PutUint32(b[:4], uint32(time.Now().Unix()))
	rand.Read(b[4:])
	return hex.EncodeToString(b[:])
}

func main() {
	log.SetFlags(log.LstdFlags | log.Lmsgprefix)
	if len(os.Args) > 1 && os.Args[1] == "import" { // manymail import <mongoexport dir>
		if len(os.Args) != 3 {
			log.Fatal("usage: manymail import <directory with <collection>.json files>")
		}
		if err := runImport(env("DB_PATH", "data/manymail.db"), os.Args[2]); err != nil {
			log.Fatalf("import: %v", err)
		}
		return
	}
	cfg := loadConfig()
	if err := cfg.check(); err != nil {
		log.Fatal(err)
	}
	if cfg.JWTSecret == defaultJWTSecret {
		log.Print("WARNING: JWT_SECRET is using the default value, change it in production")
	}

	st, err := openStore(cfg.DBPath)
	if err != nil {
		log.Fatalf("open store: %v", err)
	}
	defer st.Close()
	if err := st.SeedDomains(cfg.Domains); err != nil {
		log.Fatalf("seed domains: %v", err)
	}
	if cfg.TTL > 0 {
		go st.CleanupLoop(cfg.TTL, 10*time.Minute)
	}

	rt := newRouter(cfg, st)
	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	if err := rt.Start(ctx); err != nil {
		log.Fatalf("router: %v", err)
	}

	srv := newSMTPServer(cfg, st, rt)
	if cfg.TLSCert != "" && cfg.TLSKey != "" {
		cert, err := tls.LoadX509KeyPair(cfg.TLSCert, cfg.TLSKey)
		if err != nil {
			log.Fatalf("load TLS cert: %v", err)
		}
		srv.TLSConfig = &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12}
	}
	go func() {
		log.Printf("SMTP listening on %s (STARTTLS %v), message TTL %v", cfg.SMTPAddr, srv.TLSConfig != nil, cfg.TTL)
		if err := srv.ListenAndServe(); err != nil {
			log.Fatalf("smtp: %v", err)
		}
	}()

	a := newAPI(cfg, st)
	a.router = rt
	// Two listeners: the web UI is public behind Caddy, the API stays where it was.
	servers := []*http.Server{
		{Addr: cfg.APIAddr, Handler: a.routes(), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 2 * time.Minute},
		{Addr: cfg.ViewerAddr, Handler: newViewer(cfg, st, a).routes(), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 2 * time.Minute},
	}
	if cfg.RouterAddr != "" { // same API as /router/* on the API port, at the old mail-router address
		servers = append(servers, &http.Server{Addr: cfg.RouterAddr, Handler: rt.handler(true), ReadHeaderTimeout: 10 * time.Second})
	}
	if cfg.AccessPassword == "" {
		log.Print("WARNING: ACCESS_PASSWORD is empty, the web UI has no login")
	}
	for _, s := range servers {
		go func() {
			log.Printf("HTTP listening on %s", s.Addr)
			if err := s.ListenAndServe(); err != nil && err != http.ErrServerClosed {
				log.Fatalf("http %s: %v", s.Addr, err)
			}
		}()
	}

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
	shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	srv.Shutdown(shutdown) // let sessions in DATA finish, so no stored mail goes unacknowledged
	for _, s := range servers {
		s.Shutdown(shutdown)
	}
	stop()
	rt.Wait() // before the deferred st.Close
}
