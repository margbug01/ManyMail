"""DNS self-check with a fake resolver."""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import dnscheck  # noqa: E402

IP = "203.0.113.7"


def fake(records, broken=()):
    def lookup(name, rtype):
        if (name, rtype) in broken:
            raise TimeoutError("timed out")
        return list(records.get((name, rtype), []))

    return lookup


GOOD = {
    ("example.com", "MX"): ["20 backup.example.com", "10 mail.example.com"],
    ("mail.example.com", "A"): [IP],
    ("backup.example.com", "A"): ["198.51.100.1"],
    ("example.com", "TXT"): ["google-site-verification=x", "v=spf1 -all"],
    ("_dmarc.example.com", "TXT"): ["v=DMARC1; p=reject"],
    (IP, "PTR"): ["mail.example.com"],
}


def by_check(items):
    return {(i["domain"], i["check"]): i for i in items}


def test_healthy_domain():
    report = dnscheck.run(["Example.com."], ip=IP, web_host="mail.example.com", lookup=fake(GOOD))
    items = by_check(report["items"])
    assert items[("example.com", "MX")]["detail"] == "mail.example.com, backup.example.com"
    assert items[("example.com", "MX host")]["status"] == "ok"
    assert items[("example.com", "SPF")]["detail"] == "v=spf1 -all"
    assert items[("example.com", "DMARC")]["status"] == "ok"
    assert items[("mail.example.com", "web")]["status"] == "ok"
    assert (items[(IP, "PTR")]["status"], items[(IP, "PTR")]["detail"]) == ("info", "mail.example.com")
    assert report["summary"] == {"ok": 5, "warn": 0, "fail": 0}


def test_missing_mx_suggests_the_mail_host():
    items = by_check(dnscheck.check_domain("example.com", fake({}), ip=IP, mail_host="mx.example.net"))
    assert items[("example.com", "MX")]["status"] == "fail"
    assert items[("example.com", "MX")]["fix"] == "example.com.  MX  10  mx.example.net."
    assert ("example.com", "MX host") not in items
    # Placeholder host names from .env.example fall back to mail.<domain>.
    items = by_check(dnscheck.check_domain("example.com", fake({}), mail_host="mail.yourdomain.com"))
    assert items[("example.com", "MX")]["fix"] == "example.com.  MX  10  mail.example.com."


def test_mx_pointing_elsewhere_fails():
    records = {**GOOD, ("mail.example.com", "A"): ["198.51.100.9"]}
    item = by_check(dnscheck.check_domain("example.com", fake(records), ip=IP))[("example.com", "MX host")]
    assert item["status"] == "fail"
    assert "mail.example.com -> 198.51.100.9" in item["detail"]
    assert item["fix"] == f"mail.example.com.  A  {IP}"


def test_without_ip_only_resolution_is_checked():
    records = {**GOOD, ("backup.example.com", "A"): []}
    item = by_check(dnscheck.check_domain("example.com", fake(records)))[("example.com", "MX host")]
    assert item["status"] == "fail" and "backup.example.com" in item["detail"]


def test_spf_and_dmarc_advice():
    records = {**GOOD, ("example.com", "TXT"): [], ("_dmarc.example.com", "TXT"): []}
    items = by_check(dnscheck.check_domain("example.com", fake(records), ip=IP))
    assert items[("example.com", "SPF")]["status"] == "warn"
    assert '"v=spf1 -all"' in items[("example.com", "SPF")]["fix"]
    assert items[("example.com", "DMARC")]["fix"].startswith('_dmarc.example.com.  TXT  "v=DMARC1;')

    records[("example.com", "TXT")] = ["v=spf1 -all", "v=spf1 include:amazonses.com ~all"]
    items = by_check(dnscheck.check_domain("example.com", fake(records), ip=IP))
    assert items[("example.com", "SPF")]["status"] == "fail"


def test_lookup_errors_are_reported_not_raised():
    item = dnscheck.check_domain("example.com", fake(GOOD, broken={("example.com", "MX")}))
    assert item == [dnscheck._item("example.com", "MX", "fail", "lookup of MX example.com failed: TimeoutError")]


def test_one_retry_on_timeout():
    calls = []

    def flaky(name, rtype):
        calls.append(1)
        if len(calls) == 1:
            raise TimeoutError
        return ["v=DMARC1; p=none"]

    assert dnscheck._query(flaky, "_dmarc.example.com", "TXT") == (["v=DMARC1; p=none"], "")


def test_web_host_mismatch_and_placeholder():
    items = dnscheck.check_server(fake({("mail.example.com", "A"): ["198.51.100.9"]}), IP, "mail.example.com")
    assert items[0]["status"] == "fail" and items[0]["fix"] == f"mail.example.com.  A  {IP}"
    assert dnscheck.check_server(fake({}), None, "localhost") == []


def test_cli_exit_code(capsys, monkeypatch):
    monkeypatch.setattr(dnscheck, "Lookup", lambda: fake({}))
    monkeypatch.setenv("DOMAINS", "example.com")
    assert dnscheck.main(["--ip", IP, "--mail-host", "mail.example.com"]) == 1
    out = capsys.readouterr().out
    assert "[FAIL] example.com" in out and "add: example.com.  MX  10  mail.example.com." in out


def test_admin_endpoint(client, monkeypatch):
    import app

    seen = {}

    def fake_run(domains, ip=None, web_host=None, mail_host=None):
        seen.update(domains=domains, ip=ip)
        return {"ip": ip, "items": [], "summary": {"ok": 0, "warn": 0, "fail": 0}}

    monkeypatch.setattr(app.dnscheck, "run", fake_run)
    assert client.get("/admin/dns-check?ip=203.0.113.7").status_code in (401, 403)
    headers = {"X-API-Key": "test-api-key"}
    assert client.get("/admin/dns-check?ip=nope", headers=headers).status_code == 400
    resp = client.get("/admin/dns-check?ip=203.0.113.7", headers=headers)
    assert resp.status_code == 200 and resp.json()["ip"] == "203.0.113.7"
    assert {"test.local", "example.test"} <= set(seen["domains"])
