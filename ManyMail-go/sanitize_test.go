package main

// Ported from mail-viewer/tests/test_app.py (sanitize / render tests), plus bypass attempts.

import (
	"strings"
	"testing"
)

func TestSanitizeRemovesScriptAndHandlers(t *testing.T) {
	out := sanitizeEmailHTML(`<div onclick="alert(1)"><script>alert(1)</script><b>ok</b></div>`)
	if strings.Contains(strings.ToLower(out), "script") || strings.Contains(out, "onclick") || !strings.Contains(out, "<b>ok</b>") {
		t.Errorf("%q", out)
	}
}

func TestSanitizeStyleBlocks(t *testing.T) {
	out := sanitizeEmailHTML(`<style>.a{color:red}</style><p class="a">one</p><STYLE type="text/css">.b{color:blue}</STYLE><p class="b">two</p>`)
	if strings.Count(out, "<style>") != 1 || !strings.HasPrefix(out, "<style>") ||
		!strings.Contains(out, ".a{color:red}") || !strings.Contains(out, ".b{color:blue}") ||
		!strings.Contains(out, "one") || !strings.Contains(out, "two") {
		t.Errorf("%q", out)
	}
	if out := sanitizeStylesheet("@media (prefers-color-scheme: dark) { .dark-img { display: block !important; } }", 0); !strings.Contains(out, "@media (prefers-color-scheme: dark)") || !strings.Contains(out, "display:block !important") {
		t.Errorf("media: %q", out)
	}
	out = sanitizeStylesheet(`@import url("https://evil.test/x.css");@font-face { font-family: X; src: url(https://evil.test/f.woff); }`+
		`.tracker { background: url(https://evil.test/pixel.png); color: red; }.ok { color: green; }`, 0)
	if strings.Contains(out, "evil.test") || strings.Contains(out, "@import") || strings.Contains(out, "@font-face") ||
		!strings.Contains(out, "color:red") || !strings.Contains(out, ".ok{color:green}") {
		t.Errorf("external: %q", out)
	}
	out = sanitizeStylesheet(`.a { width: expression(alert(1)); behavior: url(#x); position: fixed; color: red; }`, 0)
	if strings.Contains(out, "expression") || strings.Contains(out, "behavior") || strings.Contains(out, "position") || !strings.Contains(out, "color:red") {
		t.Errorf("scripting: %q", out)
	}
}

func TestSanitizeRawTextEscapes(t *testing.T) {
	out := sanitizeEmailHTML(`<style>a{color:red}</style x>{color:red}</style><p>body</p>`)
	block := strings.SplitN(out, "</style>", 2)[0]
	if strings.Contains(out, "<img") || strings.Contains(out, "</style x>") || strings.Contains(block[len("<style>"):], "<") {
		t.Errorf("style escape: %q", out)
	}
	out = sanitizeEmailHTML(`<title>t</title><script>var leak = 1;</script><p>three</p><style>.c{color:green}`)
	if strings.Contains(out, "var leak") || strings.Contains(out, ">t<") || strings.Contains(out, "color:green") || !strings.Contains(out, "three") {
		t.Errorf("script/title: %q", out)
	}
}

func TestSanitizeKeepsWhatLayoutNeeds(t *testing.T) {
	out := sanitizeEmailHTML(`<style>.hide{display:none}</style><div class="hide" id="pre">preheader</div>`)
	if !strings.Contains(out, `class="hide"`) || !strings.Contains(out, `id="pre"`) || !strings.Contains(out, ".hide{display:none}") {
		t.Errorf("%q", out)
	}
	if out := sanitizeEmailHTML(`<p style="color: red;">kept</p>`); out != `<p style="color:red">kept</p>` {
		t.Errorf("inline style: %q", out)
	}
	// The whole page is not kept, only the body.
	if out := sanitizeEmailHTML(`<html><head><meta charset="x"></head><body><p>hi</p></body></html>`); out != "<p>hi</p>" {
		t.Errorf("body: %q", out)
	}
}

func TestSanitizeBypassAttempts(t *testing.T) {
	for _, in := range []string{
		`<a href="javascript:alert(1)">x</a>`,
		`<a href="&#106;avascript:alert(1)">x</a>`,
		"<a href=\"java\tscript:alert(1)\">x</a>",
		`<a href=" JAVASCRIPT:alert(1)">x</a>`,
		`<a href="vbscript:x">x</a>`,
		`<img src=x onerror=alert(1)>`,
		`<svg><script>alert(1)</script></svg>`,
		`<iframe src="https://evil.test"></iframe>`,
		`<p style="background:url(javascript:alert(1))">x</p>`,
		`<p title="&quot;><script>alert(1)</script>">x</p>`,
		`<!--<script>alert(1)</script>-->`,
		`<scr<script>ipt>alert(1)</script>`,
		`<form action="https://evil.test"><input name=x></form>`,
	} {
		out := sanitizeEmailHTML(in)
		low := strings.ToLower(out)
		for _, bad := range []string{"javascript", "vbscript", "onerror", "<script", "<iframe", "<form", "<input", "<svg"} {
			if strings.Contains(low, bad) {
				t.Errorf("%q -> %q contains %s", in, out, bad)
			}
		}
	}
	// Attribute values are escaped, text stays text.
	if out := sanitizeEmailHTML(`<p title='a"b'>1 &lt; 2 &amp; <b>x</b></p>`); out != `<p>1 &lt; 2 &amp; <b>x</b></p>` {
		t.Errorf("escape: %q", out)
	}
	if out := sanitizeEmailHTML(`<a href="https://x.test/?a=1&b=2" title='say "hi"'>x</a>`); out != `<a href="https://x.test/?a=1&amp;b=2" title="say &#34;hi&#34;" rel="noopener noreferrer">x</a>` {
		t.Errorf("attr escape: %q", out)
	}
}

func TestRenderImages(t *testing.T) {
	// No DNS during rendering (lookupHost is not even reachable from here).
	for _, src := range []string{"https://tracker.test/pixel", "//tracker.test/pixel", "http://127.0.0.1/pixel"} {
		out := prepareHTML(`<img src="` + src + `" srcset="https://tracker.test/other 2x">`)
		if !strings.Contains(out, `data-remote-src="`) || strings.Contains(out, "<img src=") || strings.Contains(out, "srcset=") {
			t.Errorf("%s: %q", src, out)
		}
	}
	if out := prepareHTML(`<img src="//tracker.test/p?a=1&b=2">`); out != `<img data-remote-src="https://tracker.test/p?a=1&amp;b=2">` {
		t.Errorf("normalised: %q", out)
	}
	for _, src := range []string{"/api/image-proxy?url=https://tracker.test/pixel", "javascript:alert(1)", "data:image/svg+xml;base64,PHN2Zz4=", "file:///secret", "cid:logo"} {
		if out := prepareHTML(`<img src="` + src + `">`); strings.Contains(out, src) {
			t.Errorf("%s kept: %q", src, out)
		}
	}
	if src := "data:image/png;base64,aGVsbG8="; !strings.Contains(prepareHTML(`<img src="`+src+`">`), src) {
		t.Error("inline raster image dropped")
	}
	if out := prepareHTML(`<p style="background:url(https://tracker.test/pixel);color:red">hello</p>`); strings.Contains(out, "tracker.test") || !strings.Contains(out, "color:red") {
		t.Errorf("inline css tracking: %q", out)
	}
}

func TestExtractCode(t *testing.T) {
	for in, want := range map[string]string{"您的验证码是 123456，5 分钟内有效": "123456", "code: 987654": "987654", "验证码654321": "654321"} {
		if got := extractCode("Subject", in); got == nil || *got != want {
			t.Errorf("%q: %v", in, got)
		}
	}
	if extractCode("no digits here") != nil || extractCode("order 1234567 shipped") != nil || extractCode() != nil {
		t.Error("false positive")
	}
}
