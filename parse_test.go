package main

// Ported from mail-service/tests/test_smtp_parsing.py, plus the DMARC zip case.

import (
	"bytes"
	"strings"
	"testing"

	"golang.org/x/text/encoding/simplifiedchinese"
)

const rcpt = "testuser@test.local"

var basic = []string{"From: Sender <sender@example.test>", "To: " + rcpt}

func raw(headers []string, body string) []byte {
	return []byte(strings.Join(headers, "\r\n") + "\r\n\r\n" + body)
}

type mpart struct {
	h    []string
	body string
}

func multi(headers []string, subtype string, parts ...mpart) []byte {
	var b strings.Builder
	for _, p := range parts {
		b.WriteString("--B\r\n" + string(raw(p.h, p.body)) + "\r\n")
	}
	b.WriteString("--B--\r\n")
	h := append(append([]string{}, headers...), "MIME-Version: 1.0", `Content-Type: multipart/`+subtype+`; boundary="B"`)
	return raw(h, b.String())
}

func with(extra ...string) []string { return append(append([]string{}, basic...), extra...) }

func gbk(s string) string {
	out, _ := simplifiedchinese.GBK.NewEncoder().String(s)
	return out
}

func TestCorpusDoesNotFail(t *testing.T) {
	corpus := map[string][]byte{
		"raw utf-8 headers": raw([]string{"From: 张三 <zs@example.cn>", "To: " + rcpt, "Subject: 你好",
			"Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 8bit"}, "正文"),
		"unknown charset":  raw(with("Subject: odd", "Content-Type: text/plain; charset=x-no-such-charset"), "caf\xe9"),
		"missing boundary": raw(with("Subject: broken", "MIME-Version: 1.0", "Content-Type: multipart/mixed"), "just text"),
		"missing From":     raw([]string{"To: " + rcpt, "Subject: no from"}, "x"),
		"bad base64 attachment": multi(with("Subject: bad b64"), "mixed",
			mpart{[]string{"Content-Type: text/plain"}, "body"},
			mpart{[]string{"Content-Type: application/octet-stream; name=x.bin", "Content-Transfer-Encoding: base64"}, "!!!not*base64###"}),
		"8bit headers inside attached mail": multi(with("Subject: Fwd raw"), "mixed",
			mpart{[]string{"Content-Type: text/plain"}, "see attached"},
			mpart{[]string{"Content-Type: message/rfc822"}, string(raw([]string{"From: 张 <a@b.c>", "Subject: 你"}, "inner"))}),
		"no headers at all": []byte("garbage line without colon\r\nmore"),
	}
	for name, msg := range corpus {
		p := parseMessage(msg)
		if p.Empty() {
			t.Errorf("%s: parsed as empty", name)
		}
	}
}

func TestHeaders(t *testing.T) {
	for _, msg := range [][]byte{
		raw([]string{"From: 张三 <zs@example.cn>", "To: " + rcpt, "Subject: 你好"}, "正文"),
		raw([]string{"From: =?UTF-8?B?5byg5LiJ?= <ZS@Example.CN>", "To: " + rcpt, "Subject: =?UTF-8?B?5L2g5aW9?="}, "hi"),
		raw([]string{"From: =?gbk?B?1cXI/Q==?= <zs@example.cn>", "Subject: =?gb2312?B?xOO6ww==?="}, "hi"),
	} {
		p := parseMessage(msg)
		if p.FromAddress != "zs@example.cn" || p.FromName != "张三" || p.Subject != "你好" {
			t.Errorf("got from=%q name=%q subject=%q", p.FromAddress, p.FromName, p.Subject)
		}
	}
}

func TestBodies(t *testing.T) {
	cases := []struct {
		name, text, html string
		msg              []byte
	}{
		{"utf-8 without charset", "正文", "", raw(with("Subject: x", "Content-Transfer-Encoding: 8bit"), "正文")},
		{"declared gbk", "国标编码", "", raw(with("Content-Type: text/plain; charset=gbk", "Content-Transfer-Encoding: 8bit"), gbk("国标编码"))},
		{"quoted-printable", "café", "", raw(with("Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: quoted-printable"), "caf=C3=A9")},
		{"html only", "", "<p>Hello</p>", raw(with("Content-Type: text/html; charset=utf-8"), "<p>Hello</p>")},
		{"alternative", "plain version", "<b>html version</b>", multi(with("Subject: alt"), "alternative",
			mpart{[]string{"Content-Type: text/plain; charset=utf-8"}, "plain version"},
			mpart{[]string{"Content-Type: text/html; charset=utf-8"}, "<b>html version</b>"})},
	}
	for _, c := range cases {
		p := parseMessage(c.msg)
		if p.Text != c.text || p.HTML != c.html || len(p.Attachments) != 0 {
			t.Errorf("%s: text=%q html=%q attachments=%d", c.name, p.Text, p.HTML, len(p.Attachments))
		}
	}
}

func TestEmpty(t *testing.T) {
	if !parseMessage(raw(basic, "")).Empty() {
		t.Error("truly empty mail should be empty")
	}
	p := parseMessage(multi(basic, "mixed", mpart{[]string{"Content-Type: application/pdf",
		"Content-Disposition: attachment; filename=scan.pdf", "Content-Transfer-Encoding: base64"}, "JVBERi0xLjQ="}))
	if p.Empty() || p.Attachments[0].Filename != "scan.pdf" || string(p.Attachments[0].Content) != "%PDF-1.4" {
		t.Errorf("attachment-only mail: %+v", p.Attachments)
	}
}

func TestDMARCZipIsAttachment(t *testing.T) {
	p := parseMessage(raw(with("Subject: Report domain: example.com", "Content-Type: application/zip; name=\"google.com!example.com.zip\"",
		"Content-Transfer-Encoding: base64"), "UEsDBBQAAAAIAA=="))
	if p.Text != "" || len(p.Attachments) != 1 || p.Attachments[0].Filename != "google.com!example.com.zip" ||
		!bytes.HasPrefix(p.Attachments[0].Content, []byte("PK")) {
		t.Errorf("text=%q attachments=%+v", p.Text, p.Attachments)
	}
}

func TestAttachments(t *testing.T) {
	type want struct{ name, ct, contains string }
	cases := []struct {
		name, text, html string
		want             []want
		msg              []byte
	}{
		{"inline image", "", `<img src="cid:logo">`, []want{{"attachment-1", "image/png", "\x89PNG"}},
			multi(with("Subject: newsletter"), "related",
				mpart{[]string{"Content-Type: text/html"}, `<img src="cid:logo">`},
				mpart{[]string{"Content-Type: image/png", "Content-ID: <logo>", "Content-Transfer-Encoding: base64"}, "iVBORw0KGgo="})},
		{"calendar", "Join us", "", []want{{"attachment-1.ics", "text/calendar", "BEGIN:VCALENDAR"}},
			multi(with("Subject: Meeting"), "alternative",
				mpart{[]string{"Content-Type: text/plain"}, "Join us"},
				mpart{[]string{"Content-Type: text/calendar; method=REQUEST"}, "BEGIN:VCALENDAR\r\nEND:VCALENDAR"})},
		{"forwarded", "see attached", "", []want{{"attachment-1.eml", "message/rfc822", "inner subject"}},
			multi(with("Subject: Fwd"), "mixed",
				mpart{[]string{"Content-Type: text/plain"}, "see attached"},
				mpart{[]string{"Content-Type: message/rfc822", "Content-Disposition: attachment"},
					string(raw([]string{"From: original@example.org", "Subject: inner subject", "Content-Type: text/html"}, "<b>INNER</b>"))})},
		{"empty wrapper", "原文", "<p>original</p>", []want{{"attachment-1.eml", "message/rfc822", "Subject: inner"}},
			multi(with("Subject: Fwd: inner"), "mixed", mpart{[]string{"Content-Type: message/rfc822"},
				string(multi([]string{"From: original@example.org", "Subject: inner"}, "alternative",
					mpart{[]string{"Content-Type: text/plain; charset=utf-8"}, "原文"},
					mpart{[]string{"Content-Type: text/html; charset=utf-8"}, "<p>original</p>"}))})},
		{"bounce", "Your message could not be delivered.", "", []want{
			{"attachment-1.txt", "message/delivery-status", "Status: 5.1.1"},
			{"attachment-2.eml", "message/rfc822", "my original"}},
			multi([]string{"From: MAILER-DAEMON@mx.example.org", "To: " + rcpt, "Subject: Undelivered Mail"}, "report; report-type=delivery-status",
				mpart{[]string{"Content-Type: text/plain"}, "Your message could not be delivered."},
				mpart{[]string{"Content-Type: message/delivery-status"}, "Reporting-MTA: dns; mx.example.org\r\n\r\nFinal-Recipient: rfc822; nobody@example.org\r\nStatus: 5.1.1\r\n"},
				mpart{[]string{"Content-Type: message/rfc822"}, string(raw([]string{"From: testuser@test.local", "Subject: my original", "Content-Type: text/html"}, "<p>original</p>"))})},
		{"named text attachment", "see log", "", []want{{"app.log", "text/plain", "ERROR 1"}},
			multi(with("Subject: log"), "mixed",
				mpart{[]string{"Content-Type: text/plain"}, "see log"},
				mpart{[]string{"Content-Type: text/plain", "Content-Disposition: attachment; filename=app.log"}, "ERROR 1"})},
		{"rfc2231 filename", "x", "", []want{{"合同.pdf", "application/pdf", "pdf"}},
			multi(with("Subject: cn file"), "mixed",
				mpart{[]string{"Content-Type: text/plain"}, "x"},
				mpart{[]string{"Content-Type: application/pdf", "Content-Disposition: attachment; filename*=UTF-8''%E5%90%88%E5%90%8C.pdf"}, "pdf"})},
		{"unquoted gbk encoded-word filename", "x", "", []want{{"合同.pdf", "application/pdf", "pdf"}},
			multi(with("Subject: cn file"), "mixed",
				mpart{[]string{"Content-Type: text/plain"}, "x"},
				mpart{[]string{"Content-Type: application/pdf", "Content-Disposition: attachment; filename==?gbk?B?us/NrC5wZGY=?="}, "pdf"})},
	}
	for _, c := range cases {
		p := parseMessage(c.msg)
		if p.Text != c.text || p.HTML != c.html {
			t.Errorf("%s: text=%q html=%q", c.name, p.Text, p.HTML)
		}
		if len(p.Attachments) != len(c.want) {
			t.Errorf("%s: %d attachments, want %d", c.name, len(p.Attachments), len(c.want))
			continue
		}
		for i, w := range c.want {
			a := p.Attachments[i]
			if a.Filename != w.name || a.ContentType != w.ct || !strings.Contains(string(a.Content), w.contains) {
				t.Errorf("%s[%d]: name=%q ct=%q content=%q", c.name, i, a.Filename, a.ContentType, a.Content)
			}
		}
	}
}

func TestIntroAndAutoReply(t *testing.T) {
	p := parseMessage(raw(with("Subject: long"), "a  \r\n\r\n b "+strings.Repeat("x", 500)))
	if intro := p.Intro(); !strings.HasPrefix(intro, "a b x") || len([]rune(intro)) != 200 {
		t.Errorf("intro %q", intro)
	}
	if !parseMessage(raw(with("Subject: 自动回复: hi"), "x")).AutoReply ||
		!parseMessage(raw(with("Auto-Submitted: auto-replied", "Subject: hi"), "x")).AutoReply ||
		parseMessage(raw(with("Auto-Submitted: no", "Subject: hi"), "x")).AutoReply {
		t.Error("auto-reply detection")
	}
}
