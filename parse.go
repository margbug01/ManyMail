package main

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"mime/quotedprintable"
	"net/mail"
	"net/textproto"
	"regexp"
	"strings"

	"golang.org/x/net/html/charset"
)

// Parsing mirrors mail-service handle_DATA, including its fixes: binary single-part
// mail (Google DMARC zips) becomes an attachment, attached messages are leaves and
// not flattened, and text without a declared charset is read as UTF-8.

type Attachment struct {
	ID, Filename, ContentType string
	Content                   []byte
}

type Parsed struct {
	FromAddress, FromName string
	Subject, Text, HTML   string
	Attachments           []Attachment
	AutoReply             bool
}

var wordDecoder = &mime.WordDecoder{CharsetReader: charset.NewReaderLabel}

func decodeHeader(s string) string {
	if d, err := wordDecoder.DecodeHeader(s); err == nil {
		return d
	}
	return s
}

var spaceRun = regexp.MustCompile(`\s+`)

func collapse(s string) string { return strings.TrimSpace(spaceRun.ReplaceAllString(s, " ")) }

// Intro is the first 200 characters of the plain body with whitespace collapsed.
func (p *Parsed) Intro() string {
	r := []rune(collapse(p.Text))
	if len(r) > 200 {
		r = r[:200]
	}
	return string(r)
}

func (p *Parsed) Empty() bool {
	return len(p.Attachments) == 0 && strings.TrimSpace(p.Subject) == "" &&
		strings.TrimSpace(p.Text) == "" && strings.TrimSpace(p.HTML) == ""
}

var autoReplyPrefixes = []string{"自动回复", "auto:", "automatic reply", "auto-reply", "autoreply", "out of office"}

func isAutoReply(h textproto.MIMEHeader, subject string) bool {
	if v := strings.ToLower(strings.TrimSpace(h.Get("Auto-Submitted"))); v != "" && v != "no" {
		return true
	}
	if h.Get("X-Autoreply") != "" || h.Get("X-Autorespond") != "" {
		return true
	}
	if strings.ToLower(strings.TrimSpace(h.Get("Precedence"))) == "auto_reply" {
		return true
	}
	s := strings.ToLower(strings.TrimSpace(subject))
	for _, prefix := range autoReplyPrefixes {
		if strings.HasPrefix(s, prefix) {
			return true
		}
	}
	return false
}

func parseMessage(raw []byte) *Parsed { return parseDepth(raw, 0) }

// parseDepth: an attached message is unwrapped one level only, like Python's inner.get_body;
// unwrapping recursively let nested message/rfc822 parts cost quadratic time.
func parseDepth(raw []byte, depth int) *Parsed {
	m, err := mail.ReadMessage(bytes.NewReader(raw))
	if err != nil {
		// Unparseable headers: keep the bytes readable rather than losing the mail.
		return &Parsed{Text: validUTF8(raw)}
	}
	body, _ := io.ReadAll(m.Body)
	h := textproto.MIMEHeader(m.Header)

	p := &Parsed{Subject: decodeHeader(h.Get("Subject"))}
	from := decodeHeader(h.Get("From"))
	if i := strings.LastIndex(from, "<"); i >= 0 {
		p.FromName = strings.TrimSpace(strings.Trim(strings.TrimSpace(from[:i]), `"`))
		p.FromAddress = strings.ToLower(strings.TrimSpace(strings.TrimRight(from[i+1:], ">")))
	} else {
		p.FromAddress = strings.ToLower(strings.TrimSpace(from))
	}
	p.AutoReply = isAutoReply(h, p.Subject)

	ct, params := mediaType(h)
	switch {
	case strings.HasPrefix(ct, "multipart/"):
		var leaves []leaf
		collectLeaves(h, body, 0, &leaves)
		for _, lf := range leaves {
			lct, lparams := mediaType(lf.h)
			filename := partFilename(lf.h, lparams)
			isAtt := strings.Contains(strings.ToLower(lf.h.Get("Content-Disposition")), "attachment") || filename != ""
			if !isAtt && (lct == "text/plain" || lct == "text/html") {
				// The first plain and HTML parts are the body; later unnamed body parts are dropped.
				if lct == "text/plain" && p.Text == "" {
					p.Text = partText(lparams, decodeCTE(lf.h, lf.body))
				} else if lct == "text/html" && p.HTML == "" {
					p.HTML = partText(lparams, decodeCTE(lf.h, lf.body))
				}
				continue
			}
			// Everything else is kept, attachment markers or not: DMARC reports,
			// calendar invites, attached or bounced messages, delivery status.
			payload := decodeCTE(lf.h, lf.body)
			if len(payload) > 0 || isAtt {
				if filename == "" {
					filename = defaultAttachmentName(lct, len(p.Attachments)+1)
				}
				p.Attachments = append(p.Attachments, Attachment{ID: newID(), Filename: filename, ContentType: lct, Content: payload})
			}
		}
		if p.Text == "" && p.HTML == "" && depth == 0 {
			// "Forward as attachment" with no note: show the attached message's body.
			for _, lf := range leaves {
				if lct, _ := mediaType(lf.h); lct == "message/rfc822" {
					inner := parseDepth(decodeCTE(lf.h, lf.body), 1)
					p.Text, p.HTML = inner.Text, inner.HTML
					break
				}
			}
		}
	case strings.HasPrefix(ct, "text/"):
		content := partText(params, decodeCTE(h, body))
		if ct == "text/html" {
			p.HTML = content
		} else {
			p.Text = content
		}
	default:
		if payload := decodeCTE(h, body); len(payload) > 0 {
			filename := partFilename(h, params)
			if filename == "" {
				filename = "attachment-1"
			}
			p.Attachments = append(p.Attachments, Attachment{ID: newID(), Filename: filename, ContentType: ct, Content: payload})
		}
	}
	return p
}

type leaf struct {
	h    textproto.MIMEHeader
	body []byte // still transfer-encoded
}

// collectLeaves walks multipart/* only; message/rfc822 parts stay whole.
func collectLeaves(h textproto.MIMEHeader, body []byte, depth int, out *[]leaf) {
	ct, params := mediaType(h)
	if !strings.HasPrefix(ct, "multipart/") || params["boundary"] == "" || depth > 30 {
		*out = append(*out, leaf{h, body})
		return
	}
	mr := multipart.NewReader(bytes.NewReader(body), params["boundary"])
	for {
		part, err := mr.NextRawPart() // raw: NextPart would silently undo quoted-printable
		if err != nil {
			return
		}
		b, _ := io.ReadAll(part) // a truncated last part keeps what was read
		collectLeaves(part.Header, b, depth+1, out)
	}
}

func mediaType(h textproto.MIMEHeader) (string, map[string]string) {
	v := h.Get("Content-Type")
	if v == "" {
		return "text/plain", map[string]string{}
	}
	mt, params, err := mime.ParseMediaType(v)
	if mt == "" {
		return "text/plain", map[string]string{}
	}
	if err != nil || params == nil {
		params = map[string]string{}
		if b := looseParam(v, "boundary"); b != "" {
			params["boundary"] = b
		}
		if c := looseParam(v, "charset"); c != "" {
			params["charset"] = c
		}
	}
	return mt, params
}

// looseParam reads a parameter from a header mime.ParseMediaType rejects,
// e.g. an unquoted encoded-word filename some Chinese mailers send.
func looseParam(v, key string) string {
	re := regexp.MustCompile(`(?i)(?:^|;)\s*` + regexp.QuoteMeta(key) + `\s*=\s*("([^"]*)"|[^;\s]+)`)
	m := re.FindStringSubmatch(v)
	if m == nil {
		return ""
	}
	if strings.HasPrefix(m[1], `"`) {
		return m[2]
	}
	return m[1]
}

func partFilename(h textproto.MIMEHeader, ctParams map[string]string) string {
	if cd := h.Get("Content-Disposition"); cd != "" {
		_, p, err := mime.ParseMediaType(cd)
		name := p["filename"]
		if err != nil {
			name = looseParam(cd, "filename")
		}
		if name != "" {
			return decodeHeader(name)
		}
	}
	if name := ctParams["name"]; name != "" {
		return decodeHeader(name)
	}
	if name := looseParam(h.Get("Content-Type"), "name"); name != "" {
		return decodeHeader(name)
	}
	return ""
}

func defaultAttachmentName(ct string, index int) string {
	ext := map[string]string{"message/rfc822": ".eml", "text/calendar": ".ics"}[ct]
	if ext == "" && (strings.HasPrefix(ct, "text/") || strings.HasPrefix(ct, "message/")) {
		ext = ".txt"
	}
	return fmt.Sprintf("attachment-%d%s", index, ext)
}

var notBase64 = regexp.MustCompile(`[^A-Za-z0-9+/=]`)

func decodeCTE(h textproto.MIMEHeader, body []byte) []byte {
	switch strings.ToLower(strings.TrimSpace(h.Get("Content-Transfer-Encoding"))) {
	case "base64":
		// Lenient like Python: drop line breaks, padding and stray characters.
		// Some mailers pad every line, so padding ends a chunk rather than the data.
		var out []byte
		for _, chunk := range bytes.FieldsFunc(notBase64.ReplaceAll(body, nil), func(r rune) bool { return r == '=' }) {
			if len(chunk)%4 == 1 {
				chunk = chunk[:len(chunk)-1]
			}
			buf := make([]byte, base64.RawStdEncoding.DecodedLen(len(chunk)))
			n, _ := base64.RawStdEncoding.Decode(buf, chunk)
			out = append(out, buf[:n]...)
		}
		return out
	case "quoted-printable":
		out, err := io.ReadAll(quotedprintable.NewReader(bytes.NewReader(body)))
		if err != nil && len(out) == 0 {
			return body
		}
		return out
	}
	return body
}

func partText(params map[string]string, b []byte) string {
	cs := strings.ToLower(strings.TrimSpace(params["charset"]))
	if cs == "" || cs == "utf-8" || cs == "utf8" || cs == "us-ascii" {
		return validUTF8(b)
	}
	r, err := charset.NewReaderLabel(cs, bytes.NewReader(b))
	if err != nil {
		return validUTF8(b) // unknown charset: same fallback as Python, UTF-8 with replacement
	}
	out, _ := io.ReadAll(r)
	return validUTF8(out)
}

func validUTF8(b []byte) string { return strings.ToValidUTF8(string(b), "\uFFFD") }
