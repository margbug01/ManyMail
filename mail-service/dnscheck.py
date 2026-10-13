"""DNS self-check for ManyMail domains.

Checks what the rest of the internet needs in order to deliver mail here:

    MX        the domain has MX records
    MX host   an MX host resolves, and to this server's public IP when that is known
    web       the web host resolves to this server (when MAIL_WEB_HOST is set)
    SPF       at most one v=spf1 record (advice only: receiving works without one)
    DMARC     a _dmarc record exists (advice only)
    PTR       reverse DNS of the server IP (shown for reference)

ManyMail does not sign outgoing mail itself, so there is no DKIM check. If you send
through Resend, publish the DKIM record Resend shows for your domain.

    python dnscheck.py [--ip 1.2.3.4] [--web-host mail.example.com] [--json] [domain ...]

Domains default to $DOMAINS, the IP to $PUBLIC_IP or what api.ipify.org reports.
"""

import argparse
import ipaddress
import json
import os
import sys
import urllib.request

PUBLIC_RESOLVERS = ("1.1.1.1", "8.8.8.8")
OK, WARN, FAIL, INFO = "ok", "warn", "fail", "info"
PLACEHOLDER_HOSTS = {"", "localhost", "mail.yourdomain.com"}


class Lookup:
    """dnspython wrapper. Returns [] when the name or record type does not exist."""

    def __init__(self, nameservers=PUBLIC_RESOLVERS, timeout: float = 4.0):
        import dns.resolver

        self._resolver = dns.resolver.Resolver(configure=not nameservers)
        if nameservers:
            self._resolver.nameservers = list(nameservers)
        self._resolver.lifetime = timeout

    def __call__(self, name: str, rtype: str) -> list:
        import dns.resolver
        import dns.reversename

        query = dns.reversename.from_address(name) if rtype == "PTR" else name
        try:
            answer = self._resolver.resolve(query, rtype)
        except (dns.resolver.NXDOMAIN, dns.resolver.NoAnswer):
            return []
        values = []
        for record in answer:
            if rtype == "MX":
                values.append(f"{record.preference} {str(record.exchange).rstrip('.').lower()}")
            elif rtype == "TXT":
                values.append(b"".join(record.strings).decode("utf-8", errors="replace"))
            else:
                values.append(str(record).rstrip(".").lower())
        return values


def _item(domain, check, status, detail, fix=""):
    return {"domain": domain, "check": check, "status": status, "detail": detail, "fix": fix}


def _query(lookup, name, rtype):
    """(values, error message); one retry, public resolvers drop the odd UDP packet."""
    error = None
    for _ in range(2):
        try:
            return lookup(name, rtype), ""
        except Exception as exc:  # timeouts, SERVFAIL, refused
            error = exc
    return [], f"lookup of {rtype} {name} failed: {error.__class__.__name__}"


def check_domain(domain: str, lookup, ip: str | None = None, mail_host: str | None = None) -> list:
    domain = domain.strip().lower().rstrip(".")
    mail_host = (mail_host or "").strip().lower()
    if mail_host in PLACEHOLDER_HOSTS:
        mail_host = f"mail.{domain}"
    items = []

    mx_values, error = _query(lookup, domain, "MX")
    if error:
        return [_item(domain, "MX", FAIL, error)]
    mx_hosts = [v.split(" ", 1)[1] for v in sorted(mx_values, key=lambda v: int(v.split(" ", 1)[0]))]
    mx_hosts = [h for h in mx_hosts if h]  # a null MX (".") means "accepts no mail"
    if not mx_hosts:
        items.append(_item(domain, "MX", FAIL, "no MX record, other servers cannot deliver mail for this domain",
                           f"{domain}.  MX  10  {mail_host}."))
    else:
        items.append(_item(domain, "MX", OK, ", ".join(mx_hosts)))
        addresses = {}
        for host in mx_hosts:
            addresses[host], error = _query(lookup, host, "A")
            if error:
                addresses[host] = []
        if ip:
            hits = [h for h in mx_hosts if ip in addresses[h]]
            if hits:
                items.append(_item(domain, "MX host", OK, f"{hits[0]} -> {ip}"))
            else:
                seen = "; ".join(f"{h} -> {', '.join(addresses[h]) or 'nothing'}" for h in mx_hosts)
                items.append(_item(domain, "MX host", FAIL, f"no MX host points to this server ({ip}): {seen}",
                                   f"{mx_hosts[0]}.  A  {ip}"))
        else:
            missing = [h for h in mx_hosts if not addresses[h]]
            if missing:
                items.append(_item(domain, "MX host", FAIL, "MX host does not resolve: " + ", ".join(missing),
                                   f"{missing[0]}.  A  <server ip>"))
            else:
                items.append(_item(domain, "MX host", OK,
                                   "; ".join(f"{h} -> {', '.join(addresses[h])}" for h in mx_hosts)))

    txt, error = _query(lookup, domain, "TXT")
    spf = [t for t in txt if t.lower().startswith("v=spf1")]
    if error:
        items.append(_item(domain, "SPF", WARN, error))
    elif not spf:
        items.append(_item(domain, "SPF", WARN,
                           "no SPF record; receiving works without one, but anyone can forge mail from this domain",
                           f'{domain}.  TXT  "v=spf1 -all"   (if you send through Resend, use the record Resend shows)'))
    elif len(spf) > 1:
        items.append(_item(domain, "SPF", FAIL, f"{len(spf)} SPF records; receivers treat that as an error",
                           "merge them into one v=spf1 record"))
    else:
        items.append(_item(domain, "SPF", OK, spf[0]))

    dmarc_txt, error = _query(lookup, f"_dmarc.{domain}", "TXT")
    dmarc = [t for t in dmarc_txt if t.lower().startswith("v=dmarc1")]
    if error:
        items.append(_item(domain, "DMARC", WARN, error))
    elif not dmarc:
        items.append(_item(domain, "DMARC", WARN, "no DMARC policy",
                           f'_dmarc.{domain}.  TXT  "v=DMARC1; p=quarantine; rua=mailto:dmarc@{domain}"'))
    else:
        items.append(_item(domain, "DMARC", OK, dmarc[0]))
    return items


def check_server(lookup, ip: str | None, web_host: str | None) -> list:
    items = []
    web_host = (web_host or "").strip().lower()
    if web_host and web_host not in PLACEHOLDER_HOSTS:
        addresses, error = _query(lookup, web_host, "A")
        if error:
            items.append(_item(web_host, "web", FAIL, error))
        elif ip and ip not in addresses:
            items.append(_item(web_host, "web", FAIL,
                               f"{web_host} -> {', '.join(addresses) or 'nothing'}, expected {ip}; HTTPS certificates will fail",
                               f"{web_host}.  A  {ip}"))
        elif not addresses:
            items.append(_item(web_host, "web", FAIL, f"{web_host} does not resolve", f"{web_host}.  A  <server ip>"))
        else:
            items.append(_item(web_host, "web", OK, f"{web_host} -> {', '.join(addresses)}"))
    if ip:
        names, error = _query(lookup, ip, "PTR")
        detail = error or (", ".join(names) if names else "no reverse DNS; only matters if this server sends mail itself")
        items.append(_item(ip, "PTR", INFO, detail))
    return items


def run(domains, ip=None, web_host=None, mail_host=None, lookup=None) -> dict:
    lookup = lookup or Lookup()
    items = check_server(lookup, ip, web_host)
    for domain in domains:
        if domain.strip():
            items.extend(check_domain(domain, lookup, ip=ip, mail_host=mail_host))
    return {
        "ip": ip,
        "web_host": web_host,
        "items": items,
        "summary": {status: sum(1 for i in items if i["status"] == status) for status in (OK, WARN, FAIL)},
    }


def detect_public_ip(timeout: float = 5.0):
    for url in ("https://api.ipify.org", "https://ifconfig.me/ip"):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "ManyMail-dnscheck"})
            with urllib.request.urlopen(request, timeout=timeout) as response:
                value = response.read(64).decode("ascii", errors="replace").strip()
            if ipaddress.ip_address(value).version == 4:
                return value
        except Exception:
            continue
    return None


def env_domains() -> list:
    return [d.strip().lower() for d in os.getenv("DOMAINS", "").split(",") if d.strip()]


def format_report(report: dict) -> str:
    marks = {OK: " OK ", WARN: "WARN", FAIL: "FAIL", INFO: "INFO"}
    lines = [f"Server IP: {report['ip'] or 'unknown (pass --ip)'}"]
    for item in report["items"]:
        lines.append(f"[{marks[item['status']]}] {item['domain']:<28} {item['check']:<8} {item['detail']}")
        if item["fix"] and item["status"] in (WARN, FAIL):
            lines.append(f"       add: {item['fix']}")
    summary = report["summary"]
    lines.append(f"{summary[FAIL]} problem(s), {summary[WARN]} warning(s)")
    return "\n".join(lines)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Check the DNS records ManyMail needs.")
    parser.add_argument("domains", nargs="*", help="domains to check (default: $DOMAINS)")
    parser.add_argument("--ip", help="this server's public IPv4 (default: $PUBLIC_IP or auto-detect)")
    parser.add_argument("--web-host", default=os.getenv("MAIL_WEB_HOST", ""), help="web UI host name")
    parser.add_argument("--mail-host", default=os.getenv("SMTP_HOSTNAME", ""), help="host name MX should point to")
    parser.add_argument("--json", action="store_true", help="print JSON")
    args = parser.parse_args(argv)

    domains = args.domains or env_domains()
    if not domains:
        parser.error("no domains given and $DOMAINS is empty")
    ip = args.ip or os.getenv("PUBLIC_IP", "").strip() or detect_public_ip()
    report = run(domains, ip=ip, web_host=args.web_host, mail_host=args.mail_host)
    print(json.dumps(report, indent=2) if args.json else format_report(report))
    return 1 if report["summary"][FAIL] else 0


if __name__ == "__main__":
    sys.exit(main())
