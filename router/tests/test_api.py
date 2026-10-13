"""HTTP API used by the webmail rules page and the IMAP bridge."""

import json
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

import pytest
from conftest import make_message
from conftest import router_app as app

import api

KEY = "k-123"
NTFY_RULE = {"name": "Push OTP", "match": {"to": ["*@example.com"]}, "actions": [{"type": "ntfy", "topic": "t1"}]}


@pytest.fixture
def server(db):
    app.ensure_indexes()  # main() does this before the API starts; dedup relies on it
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), api.make_handler(db, KEY, "https://mail.example.com"))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}"
    httpd.shutdown()


def call(base, method, path, body=None, key=KEY):
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(base + path, data=data, method=method,
                                     headers={"Content-Type": "application/json", **({"X-API-Key": key} if key else {})})
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read())


def test_health_and_auth(server, db):
    assert call(server, "GET", "/health", key=None) == (200, {"ok": True})
    assert call(server, "GET", "/rules", key=None)[0] == 401
    assert call(server, "GET", "/rules", key="wrong")[0] == 401
    assert call(server, "GET", "/nope")[0] == 404


def test_empty_key_refuses_everything(db):
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), api.make_handler(db, "", ""))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        base = f"http://127.0.0.1:{httpd.server_address[1]}"
        assert call(base, "GET", "/rules", key="")[0] == 503
        assert call(base, "GET", "/health", key=None)[0] == 200
    finally:
        httpd.shutdown()


def test_rule_crud(server, db):
    status, body = call(server, "POST", "/rules", NTFY_RULE)
    assert status == 201 and body["rule"]["_id"] == "push-otp" and body["created"]
    rules = call(server, "GET", "/rules")[1]["rules"]
    assert [r["_id"] for r in rules] == ["push-otp"] and rules[0]["problems"] == []

    changed = {**NTFY_RULE, "name": "Push OTP 2", "order": 5}
    assert call(server, "PUT", "/rules/push-otp", changed)[1]["rule"]["order"] == 5
    assert call(server, "POST", "/rules/push-otp/enabled", {"enabled": False})[0] == 200
    assert db.routing_rules.find_one({"_id": "push-otp"})["enabled"] is False

    status, body = call(server, "PUT", "/rules/push-otp", {"name": "x", "actions": [{"type": "explode"}]})
    assert status == 400 and body["problems"]

    assert call(server, "DELETE", "/rules/push-otp") == (200, {"deleted": "push-otp"})
    assert call(server, "DELETE", "/rules/push-otp")[0] == 404


def test_env_rules_are_read_only(server, db):
    db.routing_rules.insert_one({**NTFY_RULE, "_id": "env-forward", "managed_by": "env"})
    assert call(server, "PUT", "/rules/env-forward", NTFY_RULE)[0] == 409
    assert call(server, "DELETE", "/rules/env-forward")[0] == 409
    # managed_by cannot be smuggled in through the body either
    status, body = call(server, "POST", "/rules", {**NTFY_RULE, "_id": "mine", "managed_by": "env"})
    assert status == 201 and "managed_by" not in db.routing_rules.find_one({"_id": "mine"})


def test_dry_run_and_test(server, db, http):
    make_message(db, to_addresses=["a@example.com"], subject="hit")
    make_message(db, to_addresses=["a@other.test"], subject="miss")
    body = call(server, "POST", "/dry-run", {"rule": NTFY_RULE, "limit": 10})[1]
    assert body["checked"] == 2 and [m["subject"] for m in body["matched"]] == ["hit"]

    results = call(server, "POST", "/test", {"rule": NTFY_RULE})[1]["results"]
    assert results == [{"type": "ntfy", "ok": True, "detail": "ntfy id-1"}]
    assert http.calls[0]["payload"]["click"] == "https://mail.example.com"
    assert call(server, "POST", "/dry-run", {"rule": "x"})[0] == 400


def test_imap_events_notify_only(server, db, http, since):
    db.routing_rules.insert_one({
        "_id": "ext", "name": "external", "match": {"source": ["imap"], "from": ["*@bank.test"]},
        "actions": [{"type": "ntfy", "topic": "t1"}, {"type": "forward", "to": ["me@gmail.com"], "from": "a@b.test"},
                    {"type": "trash"}],
    })
    db.routing_rules.insert_one({**NTFY_RULE, "_id": "smtp-only", "match": {}})
    event = {"account": "Me@Gmail.com", "uidvalidity": 7, "messages": [
        {"uid": 41, "from": {"address": "alerts@bank.test", "name": "Bank"}, "subject": "Login code 551234"},
        {"uid": 42, "from": {"address": "news@shop.test"}, "subject": "Sale"},
        {"uid": "bad"},
    ]}
    assert call(server, "POST", "/events/imap", event) == (202, {"accepted": 2})
    assert call(server, "POST", "/events/imap", event) == (202, {"accepted": 0})  # duplicates ignored
    assert call(server, "POST", "/events/imap", {"account": "nobody", "messages": [{"uid": 1}]})[0] == 400

    assert app.run_once(app.start_time()) and app.run_once(app.start_time())
    assert not app.run_once(app.start_time())

    bank = db.routing_events.find_one({"uid": 41})
    results = bank["routing"]["results"]
    assert bank["routing"]["status"] == "done" and bank["to_addresses"] == ["me@gmail.com"]
    assert results["ext:0"]["detail"] == "ntfy id-1"
    assert results["ext:1"]["detail"] == results["ext:2"]["detail"] == "skipped for IMAP mail"
    assert db.routing_events.find_one({"uid": 42})["routing"]["matched"] == []  # smtp-only rule ignores IMAP
    assert len(http.calls) == 1 and "Code: 551234" in http.calls[0]["payload"]["message"]

    rows = call(server, "GET", "/status?limit=5")[1]["messages"]
    assert {r["subject"] for r in rows} == {"Login code 551234", "Sale"}
    assert all(r["source"] == "imap" for r in rows)
