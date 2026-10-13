"""Router loop: legacy env rules, cut-over, per-action retry, and each action type."""

import hashlib
import hmac
import json
from datetime import datetime, timedelta, timezone

import pytest
from conftest import actions, make_message
from conftest import router_app as app

FORWARD_RULE = {
    "_id": "fwd",
    "name": "forward hello",
    "match": {"to": ["hello@example.com"]},
    "actions": [{"type": "forward", "to": ["me@gmail.com"], "from": "Me <hello@example.com>", "subject_prefix": "[MM]"}],
}


@pytest.fixture(autouse=True)
def resend_key(monkeypatch):
    monkeypatch.setenv("RESEND_API_KEY", "re_test")


def run_once(db, rules):
    message = app.claim_next_message(app.start_time())
    if message is None:
        return None
    return app.process_message(message, rules)


# ---- legacy FORWARD_* variables ---------------------------------------------------------


def test_legacy_variables_become_rules(db, monkeypatch):
    monkeypatch.setenv("FORWARD_SOURCE_ADDRESS", "Hello@Example.com")
    monkeypatch.setenv("FORWARD_TO_ADDRESS", "me@gmail.com")
    monkeypatch.setenv("FORWARD_FROM", "Shop <hello@example.com>")
    monkeypatch.setenv("FORWARD_SUBJECT_PREFIX", "[Shop]")
    monkeypatch.setenv("PAYPAL_FORWARD_SOURCE_ADDRESS", "paypal@example.com")
    app.seed_legacy_rules()

    rule = db.routing_rules.find_one({"_id": "env-forward"})
    assert rule["managed_by"] == "env"
    assert rule["match"] == {"to": ["hello@example.com"]}
    action = rule["actions"][0]
    assert action["to"] == ["me@gmail.com"]
    assert action["subject_prefix"] == "[Shop]"
    assert action["api_key_env"] == "FORWARD_RESEND_API_KEY"
    # Incomplete PayPal settings create nothing.
    assert db.routing_rules.find_one({"_id": "env-paypal-forward"}) is None

    monkeypatch.delenv("FORWARD_TO_ADDRESS")
    app.seed_legacy_rules()
    assert db.routing_rules.find_one({"_id": "env-forward"}) is None


def test_clearing_env_does_not_delete_a_user_rule_with_the_same_id(db):
    db.routing_rules.insert_one({**FORWARD_RULE, "_id": "env-forward"})
    app.seed_legacy_rules()
    assert db.routing_rules.find_one({"_id": "env-forward"}) is not None


def test_legacy_key_variable_is_used(db, monkeypatch, http):
    monkeypatch.delenv("RESEND_API_KEY")
    monkeypatch.setenv("FORWARD_RESEND_API_KEY", "re_legacy")
    rule = app.legacy_rule("env-forward", "") or {}
    assert rule == {}
    monkeypatch.setenv("FORWARD_SOURCE_ADDRESS", "hello@example.com")
    monkeypatch.setenv("FORWARD_TO_ADDRESS", "me@gmail.com")
    monkeypatch.setenv("FORWARD_FROM", "hello@example.com")
    rule = app.legacy_rule("env-forward", "")
    message = make_message(db)
    actions.forward(rule["actions"][0], message, {"action_key": "env-forward:0"})
    assert http.calls[0]["headers"]["Authorization"] == "Bearer re_legacy"
    assert "[" not in http.calls[0]["payload"]["subject"]  # no prefix unless configured


# ---- cut-over and claiming ------------------------------------------------------------


def test_first_start_routes_only_new_mail(db, http):
    make_message(db, created_at=datetime.now(timezone.utc) - timedelta(days=3))
    assert app.start_time() is not None
    assert run_once(db, [FORWARD_RULE]) is None
    assert http.calls == []

    make_message(db, subject="fresh")
    assert run_once(db, [FORWARD_RULE]) == "done"
    assert http.calls[0]["payload"]["subject"] == "[MM] fresh"
    assert run_once(db, [FORWARD_RULE]) is None


def test_start_time_is_remembered(db, since):
    assert abs((app.start_time() - since).total_seconds()) < 1


def test_unmatched_mail_is_marked_done(db, since, http):
    message = make_message(db, to_addresses=["other@example.com"])
    assert run_once(db, [FORWARD_RULE]) == "done"
    routing = db.messages.find_one({"_id": message["_id"]})["routing"]
    assert routing["matched"] == []
    assert http.calls == []


# ---- retry ----------------------------------------------------------------------------


def test_failed_action_retries_alone(db, since, http, monkeypatch):
    rule = {**FORWARD_RULE, "actions": FORWARD_RULE["actions"] + [{"type": "ntfy", "topic": "t"}]}
    message = make_message(db)
    http.fail = None

    calls = []
    real_ntfy = actions.HANDLERS["ntfy"]

    def flaky_ntfy(action, msg, ctx):
        calls.append(1)
        if len(calls) == 1:
            raise RuntimeError("ntfy down")
        return real_ntfy(action, msg, ctx)

    monkeypatch.setitem(actions.HANDLERS, "ntfy", flaky_ntfy)
    assert run_once(db, [rule]) == "retry"
    stored = db.messages.find_one({"_id": message["_id"]})["routing"]
    assert stored["results"]["fwd:0"]["status"] == "done"
    assert stored["results"]["fwd:1"]["error"] == "ntfy down"

    db.messages.update_one({"_id": message["_id"]}, {"$set": {"routing.next_attempt_at": datetime.now(timezone.utc)}})
    assert run_once(db, [rule]) == "done"
    forwards = [c for c in http.calls if "resend" in c["url"]]
    assert len(forwards) == 1  # the forward that already worked was not repeated
    assert len(calls) == 2


def test_retry_waits_for_backoff(db, since, http):
    make_message(db)
    http.fail = "Resend HTTP 500"
    assert run_once(db, [FORWARD_RULE]) == "retry"
    assert run_once(db, [FORWARD_RULE]) is None


def test_gives_up_after_max_attempts(db, since, http, monkeypatch):
    monkeypatch.setattr(app, "MAX_ATTEMPTS", 2)
    message = make_message(db)
    http.fail = "Resend HTTP 500"
    assert run_once(db, [FORWARD_RULE]) == "retry"
    db.messages.update_one({"_id": message["_id"]}, {"$set": {"routing.next_attempt_at": datetime.now(timezone.utc)}})
    assert run_once(db, [FORWARD_RULE]) == "failed"
    assert run_once(db, [FORWARD_RULE]) is None


def test_matched_rules_are_fixed_at_first_sight(db, since, http):
    message = make_message(db)
    trash_first = {"_id": "bin", "name": "bin", "order": 0, "match": {}, "actions": [{"type": "trash"}]}
    http.fail = "Resend HTTP 500"
    assert run_once(db, [trash_first, FORWARD_RULE]) == "retry"
    # The message is now in the trash, but the forward still owes a retry.
    http.fail = None
    db.messages.update_one({"_id": message["_id"]}, {"$set": {"routing.next_attempt_at": datetime.now(timezone.utc)}})
    assert run_once(db, [trash_first, FORWARD_RULE]) == "done"
    assert sum("resend" in c["url"] for c in http.calls) == 2


# ---- legacy forwarder running alongside ------------------------------------------------


def test_skips_mail_the_legacy_forwarder_already_sent(db, since, http):
    make_message(db, forwarding={"status": "forwarded", "target": "me@gmail.com", "resend_id": "abc"})
    assert run_once(db, [FORWARD_RULE]) == "done"
    assert http.calls == []


def test_waits_while_the_legacy_forwarder_is_sending(db, since, http):
    message = make_message(db, forwarding={"status": "sending", "target": "me@gmail.com"})
    assert run_once(db, [FORWARD_RULE]) == "retry"
    stored = db.messages.find_one({"_id": message["_id"]})["routing"]
    assert stored["results"]["fwd:0"]["status"] == "waiting"
    assert http.calls == []


# ---- actions --------------------------------------------------------------------------


def test_forward_payload(db, http):
    message = make_message(
        db,
        subject="",
        text="",
        html="<p>hi</p>",
        attachments=[{"filename": "a.pdf", "content": b"%PDF"}, {"filename": "lost", "content": None}],
    )
    actions.forward(FORWARD_RULE["actions"][0], message, {"action_key": "fwd:0"})
    call = http.calls[0]
    assert call["url"] == "https://api.resend.com/emails"
    assert call["headers"]["Authorization"] == "Bearer re_test"
    assert call["headers"]["Idempotency-Key"] == f"manymail-route-{message['_id']}-fwd:0"
    payload = call["payload"]
    assert payload["subject"] == "[MM] (no subject)"
    assert payload["reply_to"] == "alice@sender.test"
    assert payload["html"] == "<p>hi</p>" and "text" not in payload
    assert payload["attachments"] == [{"filename": "a.pdf", "content": "JVBERg=="}]


def test_forward_without_key_fails(db, http, monkeypatch):
    monkeypatch.delenv("RESEND_API_KEY")
    with pytest.raises(RuntimeError, match="no Resend API key"):
        actions.forward(FORWARD_RULE["actions"][0], make_message(db), {"action_key": "fwd:0"})


def test_ntfy_notification(db, http, monkeypatch):
    monkeypatch.setenv("NTFY_TOKEN", "tk")
    message = make_message(db, subject="Login code")
    action = {"type": "ntfy", "topic": "mine", "server": "https://ntfy.example/", "token_env": "NTFY_TOKEN", "priority": 4}
    actions.ntfy(action, message, {"viewer_url": "https://mail.example"})
    call = http.calls[0]
    assert call["url"] == "https://ntfy.example"
    assert call["headers"] == {"Authorization": "Bearer tk"}
    payload = call["payload"]
    assert payload["topic"] == "mine" and payload["title"] == "Login code" and payload["priority"] == 4
    assert "From: Alice <alice@sender.test>" in payload["message"]
    assert "Code: 482913" in payload["message"]
    assert payload["click"] == "https://mail.example"


def test_telegram_needs_a_token(db, http, monkeypatch):
    message = make_message(db)
    with pytest.raises(RuntimeError, match="Telegram bot token"):
        actions.telegram({"type": "telegram", "chat_id": "1"}, message, {})
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "123:abc")
    actions.telegram({"type": "telegram", "chat_id": 42}, message, {})
    assert http.calls[0]["url"] == "https://api.telegram.org/bot123:abc/sendMessage"
    assert http.calls[0]["payload"]["chat_id"] == "42"


def test_webhook_is_signed(db, http, monkeypatch):
    monkeypatch.setenv("HOOK_SECRET", "s3cret")
    message = make_message(db)
    rule = {"_id": "hook", "name": "Hook"}
    actions.webhook({"type": "webhook", "url": "https://hooks.test/in", "secret_env": "HOOK_SECRET"}, message, {"rule": rule})
    call = http.calls[0]
    body = json.dumps(call["payload"]).encode("utf-8")
    expected = hmac.new(b"s3cret", body, hashlib.sha256).hexdigest()
    assert call["headers"]["X-ManyMail-Signature"] == f"sha256={expected}"
    assert call["payload"]["rule"] == {"id": "hook", "name": "Hook"}
    assert call["payload"]["message"]["code"] == "482913"


def test_mailbox_actions(db, since, http):
    message = make_message(db)
    rule = {
        "_id": "otp",
        "name": "otp",
        "match": {},
        "actions": [{"type": "tag", "tags": ["otp", "otp", " "]}, {"type": "mark_read"}, {"type": "trash"}],
    }
    assert run_once(db, [rule]) == "done"
    stored = db.messages.find_one({"_id": message["_id"]})
    assert stored["tags"] == ["otp"]
    assert stored["seen"] is True
    assert stored["is_deleted"] is True
