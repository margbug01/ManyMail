package main

import (
	"net"
	netsmtp "net/smtp"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestSMTPEndToEnd(t *testing.T) {
	st, err := openStore(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	if err := st.SeedDomains([]string{"test.local"}); err != nil {
		t.Fatal(err)
	}
	cfg := &Config{Hostname: "mx.test.local", MaxMessageBytes: 1 << 20, MaxAddrLen: 320,
		Loopback: map[string]bool{"me@gmail.com": true}}
	srv := newSMTPServer(cfg, st, nil)
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go srv.Serve(l)
	defer srv.Close()
	addr := l.Addr().String()

	msg := multi([]string{"From: 张三 <zs@example.cn>", "To: a@test.local", "Subject: =?UTF-8?B?5L2g5aW9?="}, "mixed",
		mpart{[]string{"Content-Type: text/plain; charset=utf-8"}, "验证码 123456"},
		mpart{[]string{"Content-Type: application/pdf", "Content-Disposition: attachment; filename=a.pdf"}, "pdf"})
	if err := netsmtp.SendMail(addr, nil, "zs@example.cn", []string{"A@test.local", "b@test.local"}, msg); err != nil {
		t.Fatalf("send: %v", err)
	}

	var subject, intro string
	var hasAtt bool
	if err := st.db.QueryRow(`SELECT subject, intro, has_attachments FROM messages`).Scan(&subject, &intro, &hasAtt); err != nil {
		t.Fatal(err)
	}
	var rcpts, atts int
	st.db.QueryRow(`SELECT count(*) FROM message_to`).Scan(&rcpts)
	st.db.QueryRow(`SELECT count(*) FROM attachments WHERE filename = 'a.pdf' AND content = CAST('pdf' AS BLOB)`).Scan(&atts)
	if subject != "你好" || intro != "验证码 123456" || !hasAtt || rcpts != 2 || atts != 1 {
		t.Errorf("stored subject=%q intro=%q att=%v rcpts=%d atts=%d", subject, intro, hasAtt, rcpts, atts)
	}

	// Foreign domain is refused at RCPT.
	err = netsmtp.SendMail(addr, nil, "x@example.cn", []string{"a@other.com"}, raw(basic, "hi"))
	if err == nil || !strings.Contains(err.Error(), "550") {
		t.Errorf("foreign domain: %v", err)
	}
	// Auto-reply from a forward target is accepted but not stored.
	if err := netsmtp.SendMail(addr, nil, "me@gmail.com", []string{"a@test.local"},
		raw([]string{"From: me@gmail.com", "Subject: 自动回复: hi"}, "away")); err != nil {
		t.Errorf("loopback: %v", err)
	}
	// Empty mail is refused.
	if err := netsmtp.SendMail(addr, nil, "x@example.cn", []string{"a@test.local"}, raw(basic, "")); err == nil ||
		!strings.Contains(err.Error(), "554") {
		t.Errorf("empty: %v", err)
	}
	var total int
	st.db.QueryRow(`SELECT count(*) FROM messages`).Scan(&total)
	if total != 1 {
		t.Errorf("want 1 stored message, got %d", total)
	}

	// TTL cleanup cascades to recipients and attachments.
	if n, _ := st.DeleteOlderThan(time.Now().Add(time.Hour)); n != 1 {
		t.Errorf("cleanup deleted %d", n)
	}
	st.db.QueryRow(`SELECT (SELECT count(*) FROM message_to) + (SELECT count(*) FROM attachments)`).Scan(&total)
	if total != 0 {
		t.Errorf("cascade left %d rows", total)
	}
}

func TestRateWindow(t *testing.T) {
	store, now := map[string][]time.Time{}, time.Now()
	for i := 0; i < 3; i++ {
		if hit(store, "ip", time.Minute, 3, now) {
			t.Fatalf("limited at %d", i)
		}
	}
	if !hit(store, "ip", time.Minute, 3, now) {
		t.Error("4th should be limited")
	}
	if hit(store, "ip", time.Minute, 3, now.Add(2*time.Minute)) {
		t.Error("window should have expired")
	}
}
