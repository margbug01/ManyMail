package main

// Port of mail-service/dnscheck.py: what the internet needs to deliver mail here.
//   MX, MX host (-> this server's IP when known), web host, SPF and DMARC (advice), PTR (info).

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"sort"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

// lookupFunc returns record values; a missing name or record type is (nil, nil).
// MX values are "pref host", TXT values are joined strings, A values are IPv4 strings.
type lookupFunc func(name, rtype string) ([]string, error)

const (
	dnsOK, dnsWarn, dnsFail, dnsInfo = "ok", "warn", "fail", "info"
)

var placeholderHosts = map[string]bool{"": true, "localhost": true, "mail.yourdomain.com": true}

type dnsItem struct {
	Domain string `json:"domain"`
	Check  string `json:"check"`
	Status string `json:"status"`
	Detail string `json:"detail"`
	Fix    string `json:"fix"`
}

type dnsReport struct {
	IP      *string   `json:"ip"`
	WebHost string    `json:"web_host"`
	Items   []dnsItem `json:"items"`
	Summary struct {
		OK   int `json:"ok"`
		Warn int `json:"warn"`
		Fail int `json:"fail"`
	} `json:"summary"`
}

// publicLookup asks 1.1.1.1 and 8.8.8.8 directly, not the container's resolver.
func publicLookup(timeout time.Duration) lookupFunc {
	var turn atomic.Uint32
	servers := []string{"1.1.1.1:53", "8.8.8.8:53"}
	res := &net.Resolver{PreferGo: true, Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, network, servers[turn.Add(1)%2])
	}}
	return func(name, rtype string) ([]string, error) {
		ctx, cancel := context.WithTimeout(context.Background(), timeout)
		defer cancel()
		var out []string
		var err error
		switch rtype {
		case "MX":
			var mx []*net.MX
			mx, err = res.LookupMX(ctx, name)
			for _, r := range mx {
				out = append(out, fmt.Sprintf("%d %s", r.Pref, strings.ToLower(strings.TrimSuffix(r.Host, "."))))
			}
		case "A":
			var ips []net.IP
			ips, err = res.LookupIP(ctx, "ip4", name)
			for _, ip := range ips {
				out = append(out, ip.String())
			}
		case "TXT":
			out, err = res.LookupTXT(ctx, name)
		case "PTR":
			var names []string
			names, err = res.LookupAddr(ctx, name)
			for _, n := range names {
				out = append(out, strings.ToLower(strings.TrimSuffix(n, ".")))
			}
		default:
			return nil, fmt.Errorf("unsupported record type %s", rtype)
		}
		var dnsErr *net.DNSError
		if errors.As(err, &dnsErr) && dnsErr.IsNotFound {
			return nil, nil
		}
		return out, err
	}
}

// query retries once; public resolvers drop the odd UDP packet.
func query(lookup lookupFunc, name, rtype string) ([]string, string) {
	var err error
	for range 2 {
		var values []string
		if values, err = lookup(name, rtype); err == nil {
			return values, ""
		}
	}
	reason := err.Error()
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		reason = dnsErr.Err
	}
	return nil, fmt.Sprintf("lookup of %s %s failed: %s", rtype, name, reason)
}

func contains(list []string, v string) bool {
	for _, s := range list {
		if s == v {
			return true
		}
	}
	return false
}

func hasPrefixFold(s, prefix string) bool {
	return len(s) >= len(prefix) && strings.EqualFold(s[:len(prefix)], prefix)
}

func checkDomain(lookup lookupFunc, domain string, ip *string, mailHost string) []dnsItem {
	domain = strings.TrimSuffix(strings.ToLower(strings.TrimSpace(domain)), ".")
	mailHost = strings.ToLower(strings.TrimSpace(mailHost))
	if placeholderHosts[mailHost] {
		mailHost = "mail." + domain
	}
	item := func(check, status, detail, fix string) dnsItem { return dnsItem{domain, check, status, detail, fix} }
	var items []dnsItem

	mxValues, errMsg := query(lookup, domain, "MX")
	if errMsg != "" {
		return []dnsItem{item("MX", dnsFail, errMsg, "")}
	}
	type mx struct {
		pref int
		host string
	}
	var mxs []mx
	for _, v := range mxValues {
		pref, host, _ := strings.Cut(v, " ")
		n, _ := strconv.Atoi(pref)
		mxs = append(mxs, mx{n, host})
	}
	sort.SliceStable(mxs, func(i, j int) bool { return mxs[i].pref < mxs[j].pref })
	var hosts []string
	for _, m := range mxs {
		if m.host != "" { // a null MX (".") means "accepts no mail"
			hosts = append(hosts, m.host)
		}
	}
	if len(hosts) == 0 {
		items = append(items, item("MX", dnsFail, "no MX record, other servers cannot deliver mail for this domain",
			fmt.Sprintf("%s.  MX  10  %s.", domain, mailHost)))
	} else {
		items = append(items, item("MX", dnsOK, strings.Join(hosts, ", "), ""))
		addrs := map[string][]string{}
		for _, h := range hosts {
			addrs[h], _ = query(lookup, h, "A")
		}
		resolved := func() string {
			var parts []string
			for _, h := range hosts {
				got := strings.Join(addrs[h], ", ")
				if got == "" {
					got = "nothing"
				}
				parts = append(parts, h+" -> "+got)
			}
			return strings.Join(parts, "; ")
		}
		if ip != nil {
			hit := ""
			for _, h := range hosts {
				if contains(addrs[h], *ip) {
					hit = h
					break
				}
			}
			if hit != "" {
				items = append(items, item("MX host", dnsOK, hit+" -> "+*ip, ""))
			} else {
				items = append(items, item("MX host", dnsFail,
					fmt.Sprintf("no MX host points to this server (%s): %s", *ip, resolved()),
					fmt.Sprintf("%s.  A  %s", hosts[0], *ip)))
			}
		} else {
			var missing []string
			for _, h := range hosts {
				if len(addrs[h]) == 0 {
					missing = append(missing, h)
				}
			}
			if len(missing) > 0 {
				items = append(items, item("MX host", dnsFail, "MX host does not resolve: "+strings.Join(missing, ", "),
					missing[0]+".  A  <server ip>"))
			} else {
				items = append(items, item("MX host", dnsOK, resolved(), ""))
			}
		}
	}

	txt, errMsg := query(lookup, domain, "TXT")
	var spf []string
	for _, t := range txt {
		if hasPrefixFold(t, "v=spf1") {
			spf = append(spf, t)
		}
	}
	switch {
	case errMsg != "":
		items = append(items, item("SPF", dnsWarn, errMsg, ""))
	case len(spf) == 0:
		items = append(items, item("SPF", dnsWarn,
			"no SPF record; receiving works without one, but anyone can forge mail from this domain",
			fmt.Sprintf(`%s.  TXT  "v=spf1 -all"   (if you send through Resend, use the record Resend shows)`, domain)))
	case len(spf) > 1:
		items = append(items, item("SPF", dnsFail, fmt.Sprintf("%d SPF records; receivers treat that as an error", len(spf)),
			"merge them into one v=spf1 record"))
	default:
		items = append(items, item("SPF", dnsOK, spf[0], ""))
	}

	dmarcTXT, errMsg := query(lookup, "_dmarc."+domain, "TXT")
	var dmarc []string
	for _, t := range dmarcTXT {
		if hasPrefixFold(t, "v=dmarc1") {
			dmarc = append(dmarc, t)
		}
	}
	switch {
	case errMsg != "":
		items = append(items, item("DMARC", dnsWarn, errMsg, ""))
	case len(dmarc) == 0:
		items = append(items, item("DMARC", dnsWarn, "no DMARC policy",
			fmt.Sprintf(`_dmarc.%s.  TXT  "v=DMARC1; p=quarantine; rua=mailto:dmarc@%s"`, domain, domain)))
	default:
		items = append(items, item("DMARC", dnsOK, dmarc[0], ""))
	}
	return items
}

func checkServer(lookup lookupFunc, ip *string, webHost string) []dnsItem {
	var items []dnsItem
	webHost = strings.ToLower(strings.TrimSpace(webHost))
	if !placeholderHosts[webHost] {
		addrs, errMsg := query(lookup, webHost, "A")
		item := func(status, detail, fix string) { items = append(items, dnsItem{webHost, "web", status, detail, fix}) }
		switch {
		case errMsg != "":
			item(dnsFail, errMsg, "")
		case ip != nil && !contains(addrs, *ip):
			got := strings.Join(addrs, ", ")
			if got == "" {
				got = "nothing"
			}
			item(dnsFail, fmt.Sprintf("%s -> %s, expected %s; HTTPS certificates will fail", webHost, got, *ip),
				fmt.Sprintf("%s.  A  %s", webHost, *ip))
		case len(addrs) == 0:
			item(dnsFail, webHost+" does not resolve", webHost+".  A  <server ip>")
		default:
			item(dnsOK, webHost+" -> "+strings.Join(addrs, ", "), "")
		}
	}
	if ip != nil {
		names, errMsg := query(lookup, *ip, "PTR")
		detail := errMsg
		if detail == "" {
			detail = strings.Join(names, ", ")
			if detail == "" {
				detail = "no reverse DNS; only matters if this server sends mail itself"
			}
		}
		items = append(items, dnsItem{*ip, "PTR", dnsInfo, detail, ""})
	}
	return items
}

func runDNSCheck(lookup lookupFunc, domains []string, ip *string, webHost, mailHost string) dnsReport {
	r := dnsReport{IP: ip, WebHost: webHost, Items: checkServer(lookup, ip, webHost)}
	for _, d := range domains {
		if strings.TrimSpace(d) != "" {
			r.Items = append(r.Items, checkDomain(lookup, d, ip, mailHost)...)
		}
	}
	if r.Items == nil {
		r.Items = []dnsItem{}
	}
	for _, it := range r.Items {
		switch it.Status {
		case dnsOK:
			r.Summary.OK++
		case dnsWarn:
			r.Summary.Warn++
		case dnsFail:
			r.Summary.Fail++
		}
	}
	return r
}

func detectPublicIP() string {
	client := &http.Client{Timeout: 5 * time.Second}
	for _, u := range []string{"https://api.ipify.org", "https://ifconfig.me/ip"} {
		req, _ := http.NewRequest("GET", u, nil)
		req.Header.Set("User-Agent", "ManyMail-dnscheck")
		resp, err := client.Do(req)
		if err != nil {
			continue
		}
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 64))
		resp.Body.Close()
		if a, err := netip.ParseAddr(strings.TrimSpace(string(b))); err == nil && a.Is4() {
			return a.String()
		}
	}
	return ""
}
