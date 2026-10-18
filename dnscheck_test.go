package main

// Ported from mail-service/tests/test_dnscheck.py.

import (
	"errors"
	"strings"
	"testing"
)

const testIP = "203.0.113.7"

type rec struct{ name, rtype string }

func fake(records map[rec][]string, broken ...rec) lookupFunc {
	return func(name, rtype string) ([]string, error) {
		for _, b := range broken {
			if b == (rec{name, rtype}) {
				return nil, errors.New("timed out")
			}
		}
		return records[rec{name, rtype}], nil
	}
}

func good() map[rec][]string {
	return map[rec][]string{
		{"example.com", "MX"}:         {"20 backup.example.com", "10 mail.example.com"},
		{"mail.example.com", "A"}:     {testIP},
		{"backup.example.com", "A"}:   {"198.51.100.1"},
		{"example.com", "TXT"}:        {"google-site-verification=x", "v=spf1 -all"},
		{"_dmarc.example.com", "TXT"}: {"v=DMARC1; p=reject"},
		{testIP, "PTR"}:               {"mail.example.com"},
	}
}

func byCheck(items []dnsItem) map[[2]string]dnsItem {
	out := map[[2]string]dnsItem{}
	for _, it := range items {
		out[[2]string{it.Domain, it.Check}] = it
	}
	return out
}

func ip(s string) *string { return &s }

func TestDNSHealthyDomain(t *testing.T) {
	r := runDNSCheck(fake(good()), []string{"Example.com."}, ip(testIP), "mail.example.com", "")
	items := byCheck(r.Items)
	if items[[2]string{"example.com", "MX"}].Detail != "mail.example.com, backup.example.com" ||
		items[[2]string{"example.com", "MX host"}].Status != dnsOK ||
		items[[2]string{"example.com", "SPF"}].Detail != "v=spf1 -all" ||
		items[[2]string{"example.com", "DMARC"}].Status != dnsOK ||
		items[[2]string{"mail.example.com", "web"}].Status != dnsOK {
		t.Errorf("%+v", r.Items)
	}
	if p := items[[2]string{testIP, "PTR"}]; p.Status != dnsInfo || p.Detail != "mail.example.com" {
		t.Errorf("ptr %+v", p)
	}
	if r.Summary.OK != 5 || r.Summary.Warn != 0 || r.Summary.Fail != 0 {
		t.Errorf("summary %+v", r.Summary)
	}
}

func TestDNSMissingMX(t *testing.T) {
	items := byCheck(checkDomain(fake(nil), "example.com", ip(testIP), "mx.example.net"))
	mx := items[[2]string{"example.com", "MX"}]
	if mx.Status != dnsFail || mx.Fix != "example.com.  MX  10  mx.example.net." {
		t.Errorf("%+v", mx)
	}
	if _, ok := items[[2]string{"example.com", "MX host"}]; ok {
		t.Error("MX host checked without MX")
	}
	items = byCheck(checkDomain(fake(nil), "example.com", nil, "mail.yourdomain.com"))
	if items[[2]string{"example.com", "MX"}].Fix != "example.com.  MX  10  mail.example.com." {
		t.Error("placeholder mail host not replaced")
	}
}

func TestDNSMXElsewhereAndUnresolved(t *testing.T) {
	r := good()
	r[rec{"mail.example.com", "A"}] = []string{"198.51.100.9"}
	it := byCheck(checkDomain(fake(r), "example.com", ip(testIP), ""))[[2]string{"example.com", "MX host"}]
	if it.Status != dnsFail || !strings.Contains(it.Detail, "mail.example.com -> 198.51.100.9") || it.Fix != "mail.example.com.  A  "+testIP {
		t.Errorf("%+v", it)
	}
	r = good()
	r[rec{"backup.example.com", "A"}] = nil
	it = byCheck(checkDomain(fake(r), "example.com", nil, ""))[[2]string{"example.com", "MX host"}]
	if it.Status != dnsFail || !strings.Contains(it.Detail, "backup.example.com") {
		t.Errorf("%+v", it)
	}
}

func TestDNSSPFAndDMARCAdvice(t *testing.T) {
	r := good()
	r[rec{"example.com", "TXT"}], r[rec{"_dmarc.example.com", "TXT"}] = nil, nil
	items := byCheck(checkDomain(fake(r), "example.com", ip(testIP), ""))
	spf, dmarc := items[[2]string{"example.com", "SPF"}], items[[2]string{"example.com", "DMARC"}]
	if spf.Status != dnsWarn || !strings.Contains(spf.Fix, `"v=spf1 -all"`) || !strings.HasPrefix(dmarc.Fix, `_dmarc.example.com.  TXT  "v=DMARC1;`) {
		t.Errorf("%+v %+v", spf, dmarc)
	}
	r[rec{"example.com", "TXT"}] = []string{"v=spf1 -all", "v=spf1 include:amazonses.com ~all"}
	if s := byCheck(checkDomain(fake(r), "example.com", ip(testIP), ""))[[2]string{"example.com", "SPF"}]; s.Status != dnsFail {
		t.Errorf("two SPF records: %+v", s)
	}
}

func TestDNSErrorsAndRetry(t *testing.T) {
	items := checkDomain(fake(good(), rec{"example.com", "MX"}), "example.com", nil, "")
	if len(items) != 1 || items[0].Status != dnsFail || items[0].Detail != "lookup of MX example.com failed: timed out" {
		t.Errorf("%+v", items)
	}
	calls := 0
	flaky := func(string, string) ([]string, error) {
		calls++
		if calls == 1 {
			return nil, errors.New("timeout")
		}
		return []string{"v=DMARC1; p=none"}, nil
	}
	if v, e := query(flaky, "_dmarc.example.com", "TXT"); e != "" || len(v) != 1 {
		t.Errorf("retry: %v %q", v, e)
	}
}

func TestDNSWebHost(t *testing.T) {
	items := checkServer(fake(map[rec][]string{{"mail.example.com", "A"}: {"198.51.100.9"}}), ip(testIP), "mail.example.com")
	if items[0].Status != dnsFail || items[0].Fix != "mail.example.com.  A  "+testIP {
		t.Errorf("%+v", items)
	}
	if got := checkServer(fake(nil), nil, "localhost"); len(got) != 0 {
		t.Errorf("placeholder checked: %+v", got)
	}
}

func TestFormatReport(t *testing.T) {
	r := runDNSCheck(fake(nil), []string{"example.com"}, ip(testIP), "", "mail.example.com")
	out := formatReport(r)
	for _, want := range []string{"Server IP: " + testIP, "[FAIL] example.com", "add: example.com.  MX  10  mail.example.com.", "problem(s)"} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in: %s", want, out)
		}
	}
}
