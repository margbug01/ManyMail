package main

import (
	"io"
	"log"
	"net"
	"net/netip"
	"strings"
	"sync"
	"time"

	"github.com/emersion/go-smtp"
)

// Same checks and reply codes as mail-service MailHandler.

func smtpErr(code int, enhanced smtp.EnhancedCode, msg string) *smtp.SMTPError {
	return &smtp.SMTPError{Code: code, EnhancedCode: enhanced, Message: msg}
}

type greyKey struct{ ip, from, to string }

type backend struct {
	cfg *Config
	st  *Store
	rt  *router // nil in tests that only store

	mu       sync.Mutex
	rcptRate map[string][]time.Time
	dataRate map[string][]time.Time
	grey     map[greyKey]time.Time
}

func newSMTPServer(cfg *Config, st *Store, rt *router) *smtp.Server {
	be := &backend{cfg: cfg, st: st, rt: rt,
		rcptRate: map[string][]time.Time{}, dataRate: map[string][]time.Time{}, grey: map[greyKey]time.Time{}}
	s := smtp.NewServer(be)
	s.Addr = cfg.SMTPAddr
	s.Domain = cfg.Hostname
	s.MaxMessageBytes = cfg.MaxMessageBytes
	s.ReadTimeout = 5 * time.Minute
	s.WriteTimeout = time.Minute
	return s
}

func (b *backend) NewSession(c *smtp.Conn) (smtp.Session, error) {
	ip := ""
	if host, _, err := net.SplitHostPort(c.Conn().RemoteAddr().String()); err == nil {
		ip = host
	}
	return &session{b: b, ip: ip}, nil
}

func isInternal(ip string) bool {
	a, err := netip.ParseAddr(ip)
	return err == nil && (a.IsPrivate() || a.IsLoopback())
}

// hit records one event in a sliding window and reports whether the limit was already reached.
func hit(store map[string][]time.Time, key string, window time.Duration, max int, now time.Time) bool {
	if len(store) > 1024 { // drop clients whose window has passed, or the table only grows
		for k, ts := range store {
			if len(ts) == 0 || now.Sub(ts[len(ts)-1]) >= window {
				delete(store, k)
			}
		}
	}
	kept := store[key][:0]
	for _, t := range store[key] {
		if now.Sub(t) < window {
			kept = append(kept, t)
		}
	}
	if len(kept) >= max {
		store[key] = kept
		return true
	}
	store[key] = append(kept, now)
	return false
}

func (b *backend) blacklisted(ip, from string) *smtp.SMTPError {
	if ip != "" && b.cfg.BlacklistIPs[ip] {
		return smtpErr(554, smtp.EnhancedCode{5, 7, 1}, "Client blocked")
	}
	sender := strings.ToLower(strings.TrimSpace(from))
	if sender != "" {
		domain := sender
		if i := strings.Index(sender, "@"); i >= 0 {
			domain = sender[i+1:]
		}
		if b.cfg.BlacklistSenders[sender] || b.cfg.BlacklistSenders[domain] {
			return smtpErr(554, smtp.EnhancedCode{5, 7, 1}, "Sender blocked")
		}
	}
	return nil
}

func (b *backend) greylisted(ip, from, to string) bool {
	if !b.cfg.GreyEnabled || ip == "" || isInternal(ip) {
		return false
	}
	from, to = strings.ToLower(strings.TrimSpace(from)), strings.ToLower(strings.TrimSpace(to))
	if from == "" || to == "" {
		return false
	}
	now := time.Now()
	b.mu.Lock()
	defer b.mu.Unlock()
	for k, first := range b.grey {
		if now.Sub(first) > b.cfg.GreyTTL {
			delete(b.grey, k)
		}
	}
	key := greyKey{ip, from, to}
	first, seen := b.grey[key]
	if !seen {
		b.grey[key] = now
		return true
	}
	return now.Sub(first) < b.cfg.GreyDelay
}

func (b *backend) spamReason(p *Parsed) string {
	if !b.cfg.SpamEnabled {
		return ""
	}
	sender := strings.ToLower(strings.TrimSpace(p.FromAddress))
	domain := sender
	if i := strings.Index(sender, "@"); i >= 0 {
		domain = sender[i+1:]
	}
	if b.cfg.SpamSenders[sender] || b.cfg.SpamSenders[domain] {
		if sender == "" {
			sender = "(empty)"
		}
		return "blocked sender: " + sender
	}
	subject := strings.ToLower(collapse(p.Subject))
	body := strings.ToLower(collapse(p.Text + " " + p.HTML))
	for _, phrase := range b.cfg.SpamSubject {
		if strings.Contains(subject, phrase) {
			return "subject phrase: " + phrase
		}
	}
	for _, phrase := range b.cfg.SpamBody {
		if strings.Contains(body, phrase) {
			return "body phrase: " + phrase
		}
	}
	for _, d := range b.cfg.SpamLinks {
		if strings.Contains(body, d) {
			return "suspicious link domain: " + d
		}
	}
	return ""
}

type session struct {
	b     *backend
	ip    string
	from  string
	rcpts []string
}

func (s *session) Reset()        { s.from, s.rcpts = "", nil }
func (s *session) Logout() error { return nil }

func (s *session) Mail(from string, _ *smtp.MailOptions) error {
	s.from, s.rcpts = from, nil
	return nil
}

func (s *session) Rcpt(to string, _ *smtp.RcptOptions) error {
	b, cfg := s.b, s.b.cfg
	addr := strings.ToLower(strings.TrimSpace(to))
	if addr == "" || !strings.Contains(addr, "@") {
		return smtpErr(501, smtp.EnhancedCode{5, 1, 3}, "Bad recipient address syntax")
	}
	if len(addr) > cfg.MaxAddrLen {
		return smtpErr(552, smtp.EnhancedCode{5, 3, 4}, "Recipient address too long")
	}
	for _, r := range s.rcpts {
		if r == addr {
			return smtpErr(452, smtp.EnhancedCode{4, 5, 3}, "Duplicate recipient")
		}
	}
	if err := b.blacklisted(s.ip, s.from); err != nil {
		return err
	}
	if b.greylisted(s.ip, s.from, addr) {
		return smtpErr(451, smtp.EnhancedCode{4, 7, 1}, "Greylisted, please retry later")
	}
	if s.ip != "" && !isInternal(s.ip) {
		if cfg.MaxRcpts > 0 && len(s.rcpts) >= cfg.MaxRcpts {
			return smtpErr(452, smtp.EnhancedCode{4, 5, 3}, "Too many recipients")
		}
		if cfg.RcptRateMax > 0 {
			b.mu.Lock()
			limited := hit(b.rcptRate, s.ip, cfg.RcptRateWindow, cfg.RcptRateMax, time.Now())
			b.mu.Unlock()
			if limited {
				return smtpErr(421, smtp.EnhancedCode{4, 7, 0}, "Too many recipient commands, try again later")
			}
		}
	}
	domain := addr[strings.Index(addr, "@")+1:]
	ok, err := b.st.DomainActive(domain)
	if err != nil {
		log.Printf("domain lookup %s: %v", domain, err)
		return smtpErr(451, smtp.EnhancedCode{4, 3, 0}, "Temporary lookup failure")
	}
	if !ok {
		return smtpErr(550, smtp.EnhancedCode{5, 1, 2}, "Domain "+domain+" not accepted here")
	}
	s.rcpts = append(s.rcpts, addr)
	return nil
}

func (s *session) Data(r io.Reader) error {
	b, cfg := s.b, s.b.cfg
	if s.ip != "" && !isInternal(s.ip) && cfg.DataRateMax > 0 {
		b.mu.Lock()
		limited := hit(b.dataRate, s.ip, cfg.DataRateWindow, cfg.DataRateMax, time.Now())
		b.mu.Unlock()
		if limited {
			io.Copy(io.Discard, r)
			return smtpErr(421, smtp.EnhancedCode{4, 7, 0}, "Too many messages, try again later")
		}
	}
	raw, err := io.ReadAll(r) // go-smtp enforces MaxMessageBytes and answers 552 itself
	if err != nil {
		return err
	}
	if len(s.rcpts) == 0 {
		return smtpErr(554, smtp.EnhancedCode{5, 5, 1}, "No valid recipients")
	}

	p := parseMessage(raw)
	// Loop guard: drop auto-replies coming back from our own forward targets
	// (.env targets plus every forward rule); mail those people write is kept.
	if p.AutoReply && b.isForwardTarget(p.FromAddress) {
		log.Printf("loop-back auto-reply dropped: %s -> %v", p.FromAddress, s.rcpts)
		return nil
	}
	if p.Empty() {
		return smtpErr(554, smtp.EnhancedCode{5, 6, 0}, "Empty message rejected")
	}

	reason := b.spamReason(p)
	m := &Message{ID: newID(), To: s.rcpts, Mail: p, IsSpam: reason != "", SpamReason: reason,
		Size: len(raw), CreatedAt: time.Now().UTC()}
	if err := b.st.InsertMessage(m); err != nil {
		log.Printf("store failed: %s -> %v: %v", p.FromAddress, s.rcpts, err)
		return smtpErr(451, smtp.EnhancedCode{4, 3, 0}, "Requested action aborted: error in processing")
	}
	if b.rt != nil {
		b.rt.Notify()
	}
	subj := []rune(p.Subject)
	if len(subj) > 50 {
		subj = subj[:50]
	}
	if reason != "" {
		log.Printf("moved to trash: %s -> %v | %s | %s", p.FromAddress, s.rcpts, string(subj), reason)
	} else {
		log.Printf("stored: %s -> %v | %s", p.FromAddress, s.rcpts, string(subj))
	}
	return nil
}

func (b *backend) isForwardTarget(addr string) bool {
	if b.cfg.Loopback[addr] {
		return true
	}
	targets, err := b.st.ForwardTargets()
	if err != nil { // without the rules only the .env targets count; delivery goes on
		log.Printf("forward targets: %v", err)
	}
	return targets[addr]
}
