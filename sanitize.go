package main

// Port of mail-viewer's _sanitize_email_html / _rewrite_html_images (bleach + own CSS rules).
// Output is rebuilt from scratch: only whitelisted tag and attribute names are written,
// every text node and attribute value is escaped, so nothing from the input reaches
// the page unescaped.

import (
	"html"
	"io"
	"net/url"
	"regexp"
	"strings"

	xhtml "golang.org/x/net/html"
)

var allowedTags = toSet(strings.Fields(`a abbr b blockquote br code div em font h1 h2 h3 h4 h5 h6 hr i img li ol
	p pre span strong table tbody td th thead tr u ul`))

// class/id carry no URL or script; without them the kept <style> rules match nothing.
var globalAttrs = toSet([]string{"align", "valign", "class", "id"})

var tagAttrs = map[string]map[string]bool{
	"a":     toSet([]string{"href", "title", "target", "style"}), // rel is always written by cleanHTML
	"div":   toSet([]string{"style"}),
	"font":  toSet([]string{"color", "size", "face"}),
	"img":   toSet([]string{"src", "alt", "title", "width", "height", "style"}),
	"p":     toSet([]string{"style"}),
	"span":  toSet([]string{"style"}),
	"table": toSet([]string{"border", "cellpadding", "cellspacing", "width", "style"}),
	"tbody": toSet([]string{"style"}),
	"thead": toSet([]string{"style"}),
	"tr":    toSet([]string{"style"}),
	"td":    toSet([]string{"colspan", "rowspan", "width", "height", "style"}),
	"th":    toSet([]string{"colspan", "rowspan", "width", "height", "style"}),
}

var voidTags = toSet([]string{"br", "hr", "img"})

var allowedSchemes = toSet([]string{"http", "https", "mailto", "cid", "data"})

var allowedCSS = toSet(strings.Fields(`background background-color border border-bottom border-collapse
	border-left border-radius border-right border-spacing border-top clear color display float font font-family
	font-size font-style font-weight height letter-spacing line-height list-style margin margin-bottom margin-left
	margin-right margin-top max-height max-width min-height min-width opacity overflow padding padding-bottom
	padding-left padding-right padding-top text-align text-decoration text-transform vertical-align visibility
	white-space width word-break`))

var (
	// url() lets CSS fetch things (tracking pixels, fonts); the rest is script execution surface.
	cssForbidden = regexp.MustCompile(`(?i)url\s*\(|image-set\s*\(|expression\s*\(|javascript\s*:|vbscript\s*:|behavior\s*:|-moz-binding`)
	cssComment   = regexp.MustCompile(`(?s)/\*.*?\*/`)
	cssAtName    = regexp.MustCompile(`^@([a-zA-Z-]+)`)
	styleElement = regexp.MustCompile(`(?is)<style\b[^>]*>(.*?)</style\s*>`)
	bodyElement  = regexp.MustCompile(`(?is)<body[^>]*>(.*)</body>`)
	// Go regexp has no backreferences, so each raw-text element gets its own pattern.
	rawTextElements = []*regexp.Regexp{
		regexp.MustCompile(`(?is)<script\b[^>]*>.*?</script\s*>`),
		regexp.MustCompile(`(?is)<title\b[^>]*>.*?</title\s*>`),
	}
	// Unclosed: everything after it is that element's raw text.
	unclosedRawText = []*regexp.Regexp{
		regexp.MustCompile(`(?is)<style\b[^>]*>.*$`),
		regexp.MustCompile(`(?is)<script\b[^>]*>.*$`),
	}
	imgSrc      = regexp.MustCompile(`(?i)(<img\b[^>]*?\bsrc=["'])([^"']+)(["'])`)
	rasterImage = regexp.MustCompile(`(?i)^data:image/(?:png|gif|jpeg|webp);base64,`)
)

var cssAllowedAtRules = toSet([]string{"media", "supports"})

const maxStylesheetBytes = 200 * 1024

func sanitizeCSSDeclarations(body string) string {
	var kept []string
	for _, decl := range strings.Split(body, ";") {
		prop, value, ok := strings.Cut(decl, ":")
		if !ok {
			continue
		}
		prop, value = strings.ToLower(strings.TrimSpace(prop)), strings.TrimSpace(value)
		if prop == "" || value == "" || !allowedCSS[prop] {
			continue
		}
		if cssForbidden.MatchString(value) || strings.ContainsAny(value, `<\{}`) || strings.Contains(value, "/*") {
			continue
		}
		kept = append(kept, prop+":"+value)
	}
	return strings.Join(kept, ";")
}

// sanitizeStylesheet rewrites <style> CSS by whitelist: selectors and @media/@supports
// stay, external fetches and unknown properties go.
func sanitizeStylesheet(css string, depth int) string {
	if depth > 4 {
		return ""
	}
	css = cssComment.ReplaceAllString(css, "")
	var rules, prelude strings.Builder
	for i := 0; i < len(css); {
		switch css[i] {
		case '{':
			level, j := 1, i+1
			for ; j < len(css) && level > 0; j++ {
				if css[j] == '{' {
					level++
				} else if css[j] == '}' {
					level--
				}
			}
			block := css[i+1 : max(j-1, i+1)]
			if level > 0 { // unterminated block runs to the end
				block = css[i+1 : j]
			}
			selector := strings.TrimSpace(prelude.String())
			prelude.Reset()
			i = j
			// "<" in a selector means someone is building </style> to leave raw text.
			if selector == "" || strings.Contains(selector, "<") || cssForbidden.MatchString(selector) {
				continue
			}
			if strings.HasPrefix(selector, "@") {
				m := cssAtName.FindStringSubmatch(selector)
				if m == nil || !cssAllowedAtRules[strings.ToLower(m[1])] {
					continue
				}
				if inner := sanitizeStylesheet(block, depth+1); inner != "" {
					rules.WriteString(selector + "{" + inner + "}")
				}
			} else if decls := sanitizeCSSDeclarations(block); decls != "" {
				rules.WriteString(selector + "{" + decls + "}")
			}
		case ';':
			// Block-less at-rules (@import/@charset/@namespace) and stray semicolons.
			prelude.Reset()
			i++
		default:
			prelude.WriteByte(css[i])
			i++
		}
	}
	return rules.String()
}

// safeURL reports whether an href/src value may stay: relative, or one of the allowed schemes.
func safeURL(v string) bool {
	// Browsers ignore whitespace and control characters inside the scheme ("java\tscript:").
	clean := strings.ToLower(strings.Map(func(r rune) rune {
		if r <= ' ' || r == 0x7f {
			return -1
		}
		return r
	}, v))
	colon := strings.IndexByte(clean, ':')
	if colon < 0 || strings.ContainsAny(clean[:colon], "/?#") {
		return true // relative
	}
	return allowedSchemes[clean[:colon]]
}

// cleanHTML is the bleach.clean(strip=True) part: disallowed tags vanish, their text stays.
func cleanHTML(src string) string {
	var out strings.Builder
	z := xhtml.NewTokenizer(strings.NewReader(src))
	skip := 0 // inside script/style/title that slipped through: drop the text
	for {
		tt := z.Next()
		switch tt {
		case xhtml.ErrorToken:
			if z.Err() != io.EOF {
				return out.String()
			}
			return strings.TrimSpace(out.String())
		case xhtml.TextToken:
			if skip == 0 {
				out.WriteString(html.EscapeString(string(z.Text())))
			}
		case xhtml.StartTagToken, xhtml.SelfClosingTagToken, xhtml.EndTagToken:
			tok := z.Token()
			name := tok.Data
			if name == "script" || name == "style" || name == "title" {
				if tt == xhtml.StartTagToken {
					skip++
				} else if tt == xhtml.EndTagToken && skip > 0 {
					skip--
				}
				continue
			}
			if !allowedTags[name] {
				continue
			}
			if tt == xhtml.EndTagToken {
				if !voidTags[name] {
					out.WriteString("</" + name + ">")
				}
				continue
			}
			out.WriteString("<" + name)
			for _, a := range tok.Attr {
				if a.Namespace != "" || !(globalAttrs[a.Key] || tagAttrs[name][a.Key]) {
					continue
				}
				val := a.Val
				switch a.Key {
				case "href", "src":
					val = strings.TrimSpace(val)
					if !safeURL(val) {
						continue
					}
				case "style":
					if val = sanitizeCSSDeclarations(val); val == "" {
						continue
					}
				}
				out.WriteString(" " + a.Key + `="` + html.EscapeString(val) + `"`)
			}
			if name == "a" { // a link opened from the mail must not get window.opener
				out.WriteString(` rel="noopener noreferrer"`)
			}
			out.WriteString(">")
			if tt == xhtml.SelfClosingTagToken && !voidTags[name] {
				out.WriteString("</" + name + ">")
			}
		}
		// Comments and doctypes are dropped.
	}
}

func dropRawText(s string) string {
	for prev := ""; prev != s; {
		prev = s
		for _, re := range rawTextElements {
			s = re.ReplaceAllString(s, "")
		}
	}
	for _, re := range unclosedRawText {
		s = re.ReplaceAllString(s, "")
	}
	return s
}

func sanitizeEmailHTML(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	// Style sheets first: they may sit in <head>, which is cut off below.
	var sheets []string
	s = styleElement.ReplaceAllStringFunc(s, func(m string) string {
		sheets = append(sheets, styleElement.FindStringSubmatch(m)[1])
		return ""
	})
	stylesheet := ""
	if len(sheets) > 0 {
		raw := strings.Join(sheets, "\n")
		if len(raw) > maxStylesheetBytes {
			raw = raw[:maxStylesheetBytes]
		}
		stylesheet = sanitizeStylesheet(raw, 0)
	}
	if m := bodyElement.FindStringSubmatch(s); m != nil {
		s = m[1]
	}
	cleaned := cleanHTML(dropRawText(s))
	if stylesheet != "" {
		cleaned = "<style>" + stylesheet + "</style>" + cleaned
	}
	return cleaned
}

func normalizeRemoteURL(u string) string {
	u = strings.TrimSpace(u)
	if strings.HasPrefix(u, "//") {
		return "https:" + u
	}
	return u
}

// rewriteImages turns remote images into data-remote-src (the page loads them on request,
// through the image proxy) and drops every other source except inline raster images.
// No DNS here: rendering must not tell a tracker that the mail was opened.
func rewriteImages(s string) string {
	if !strings.Contains(strings.ToLower(s), "<img") {
		return s
	}
	return imgSrc.ReplaceAllStringFunc(s, func(m string) string {
		g := imgSrc.FindStringSubmatch(m)
		prefix, src, suffix := g[1], g[2], g[3]
		bare := prefix[:len(prefix)-5] // without src="
		normalized := normalizeRemoteURL(html.UnescapeString(src))
		if p, err := url.Parse(normalized); err == nil && (p.Scheme == "http" || p.Scheme == "https") && p.Hostname() != "" {
			return bare + "data-remote-src=" + prefix[len(prefix)-1:] + html.EscapeString(normalized) + suffix
		}
		if rasterImage.MatchString(normalized) {
			return m
		}
		return bare
	})
}

func prepareHTML(s string) string { return rewriteImages(sanitizeEmailHTML(s)) }
