"""SMTP envelope defences: recipient checks, blacklist, greylist and rate limits."""

import asyncio
from collections import defaultdict
from types import SimpleNamespace

import pytest

app = None  # imported in the fixture: conftest has to patch MongoClient first

EXTERNAL = "8.8.4.4"
INTERNAL = "172.18.0.4"


@pytest.fixture(autouse=True)
def smtp_state(monkeypatch):
    """Fresh limiter state, fixed domains and a controllable clock for every test."""
    global app
    import app as app_module
    app = app_module
    clock = SimpleNamespace(now=1_000_000.0)
    monkeypatch.setattr(app, "time", SimpleNamespace(time=lambda: clock.now))
    monkeypatch.setattr(app, "_smtp_rcpt_rate_store", defaultdict(list))
    monkeypatch.setattr(app, "_smtp_data_rate_store", defaultdict(list))
    monkeypatch.setattr(app, "_smtp_greylist_store", {})
    monkeypatch.setattr(app, "get_active_domains", lambda: ["test.local", "example.test"])
    return clock


def session(peer=EXTERNAL, rcpt_count=0):
    return SimpleNamespace(peer=(peer, 25000), rcpt_count=rcpt_count, mail_from="sender@remote.example")


def envelope(rcpts=None):
    return SimpleNamespace(rcpt_tos=list(rcpts or []), mail_from="sender@remote.example", content=b"")


def rcpt(address, sess=None, env=None):
    sess = sess or session()
    env = env if env is not None else envelope()
    return asyncio.run(app.MailHandler().handle_RCPT(None, sess, env, address, [])), sess, env


def test_mail_from_resets_recipient_count():
    sess, env = session(rcpt_count=5), envelope()
    assert asyncio.run(app.MailHandler().handle_MAIL(None, sess, env, "a@remote.example", [])) == "250 OK"
    assert sess.rcpt_count == 0
    assert env.mail_from == "a@remote.example"


def test_rcpt_accepts_active_domain_case_insensitively():
    result, sess, env = rcpt("User@Test.Local")
    assert result == "250 OK"
    assert env.rcpt_tos == ["user@test.local"]
    assert sess.rcpt_count == 1


@pytest.mark.parametrize("address, expected", [
    ("", "501 5.1.3 Bad recipient address syntax"),
    ("no-at-sign", "501 5.1.3 Bad recipient address syntax"),
    ("user@other.example", "550 Domain other.example not accepted here"),
    ("x" * 320 + "@test.local", "552 5.3.4 Recipient address too long"),
])
def test_rcpt_rejections(address, expected):
    assert rcpt(address)[0] == expected


def test_rcpt_duplicate_is_refused():
    assert rcpt("a@test.local", env=envelope(["a@test.local"]))[0] == "452 4.5.3 Duplicate recipient"


def test_blacklisted_ip_and_senders(monkeypatch):
    monkeypatch.setattr(app, "_SMTP_BLACKLIST_IPS", {EXTERNAL})
    assert rcpt("a@test.local")[0] == "554 5.7.1 Client blocked"

    monkeypatch.setattr(app, "_SMTP_BLACKLIST_IPS", set())
    monkeypatch.setattr(app, "_SMTP_BLACKLIST_SENDERS", {"spam.example", "bad@remote.example"})
    for sender in ("x@spam.example", "BAD@remote.example"):
        env = envelope()
        env.mail_from = sender
        assert rcpt("a@test.local", env=env)[0] == "554 5.7.1 Sender blocked"
    assert rcpt("a@test.local")[0] == "250 OK"


def test_greylist_defers_first_attempt_then_accepts_retry(monkeypatch, smtp_state):
    monkeypatch.setattr(app, "_SMTP_GREYLIST_ENABLED", True)
    monkeypatch.setattr(app, "_SMTP_GREYLIST_DELAY_SECONDS", 60)
    monkeypatch.setattr(app, "_SMTP_GREYLIST_TTL_SECONDS", 3600)
    greylisted = "451 4.7.1 Greylisted, please retry later"
    assert rcpt("a@test.local")[0] == greylisted
    smtp_state.now += 30
    assert rcpt("a@test.local")[0] == greylisted
    smtp_state.now += 31
    assert rcpt("a@test.local")[0] == "250 OK"
    # A different recipient is a new triplet.
    assert rcpt("b@test.local")[0] == greylisted
    # Internal peers (other containers) are never greylisted.
    assert rcpt("c@test.local", sess=session(INTERNAL))[0] == "250 OK"


def test_greylist_entries_expire(monkeypatch, smtp_state):
    monkeypatch.setattr(app, "_SMTP_GREYLIST_ENABLED", True)
    monkeypatch.setattr(app, "_SMTP_GREYLIST_DELAY_SECONDS", 60)
    monkeypatch.setattr(app, "_SMTP_GREYLIST_TTL_SECONDS", 3600)
    rcpt("a@test.local")
    smtp_state.now += 3601
    assert rcpt("a@test.local")[0] == "451 4.7.1 Greylisted, please retry later"
    assert len(app._smtp_greylist_store) == 1


def test_too_many_recipients_per_message(monkeypatch):
    monkeypatch.setattr(app, "_SMTP_MAX_RCPTS_PER_MESSAGE", 2)
    assert rcpt("a@test.local", sess=session(rcpt_count=1))[0] == "250 OK"
    assert rcpt("b@test.local", sess=session(rcpt_count=2))[0] == "452 4.5.3 Too many recipients"
    assert rcpt("b@test.local", sess=session(INTERNAL, rcpt_count=2))[0] == "250 OK"


def test_recipient_rate_limit_window(monkeypatch, smtp_state):
    monkeypatch.setattr(app, "_SMTP_RCPT_RATE_MAX", 3)
    monkeypatch.setattr(app, "_SMTP_RCPT_RATE_WINDOW", 60)
    for i in range(3):
        assert rcpt(f"u{i}@test.local")[0] == "250 OK"
    assert rcpt("u9@test.local")[0] == "421 4.7.0 Too many recipient commands, try again later"
    smtp_state.now += 61
    assert rcpt("u9@test.local")[0] == "250 OK"


def test_data_rate_limit_and_size_checks(monkeypatch, smtp_state):
    monkeypatch.setattr(app, "_SMTP_DATA_RATE_MAX", 2)
    monkeypatch.setattr(app, "_SMTP_DATA_RATE_WINDOW", 60)
    monkeypatch.setattr(app, "_SMTP_MAX_MESSAGE_BYTES", 100)

    def data(content, rcpts=("a@test.local",), peer=EXTERNAL):
        env = envelope(rcpts)
        env.content = content
        return asyncio.run(app.MailHandler().handle_DATA(None, session(peer), env))

    assert data(b"x" * 101) == "552 5.3.4 Message too large"
    assert data(b"Subject: hi\r\n\r\nbody", rcpts=()) == "554 5.5.1 No valid recipients"
    assert data(b"Subject: hi\r\n\r\nbody") == "421 4.7.0 Too many messages, try again later"
    assert data(b"Subject: hi\r\n\r\nbody", peer=INTERNAL) == "250 Message accepted for delivery"
    smtp_state.now += 61
    assert data(b"Subject: hi\r\n\r\nbody") == "250 Message accepted for delivery"


def test_processing_error_is_temporary_not_lost(monkeypatch, test_account):
    """A storage failure must answer 4xx so the sending server retries later."""
    def boom(*args, **kwargs):
        raise RuntimeError("mongo down")

    monkeypatch.setattr(app.db.messages, "insert_one", boom)
    env = envelope([test_account[0]])
    env.content = b"Subject: hi\r\n\r\nbody"
    sess = session()
    sess.rcpt_count = 1
    assert asyncio.run(app.MailHandler().handle_DATA(None, sess, env)).startswith("451 ")
    assert sess.rcpt_count == 0


@pytest.mark.parametrize("field, value, reason", [
    ("_SMTP_SPAM_TRASH_SENDERS", {"spam.example"}, "blocked sender: x@spam.example"),
    ("_SMTP_SPAM_TRASH_BODY_PHRASES", ("you won",), "body phrase: you won"),
    ("_SMTP_SPAM_TRASH_LINK_DOMAINS", ("evil.example",), "suspicious link domain: evil.example"),
])
def test_spam_rules(monkeypatch, field, value, reason):
    monkeypatch.setattr(app, "_SMTP_SPAM_TRASH_ENABLED", True)
    monkeypatch.setattr(app, field, value)
    assert app._detect_spam("x@spam.example", "Hello", "You   WON a prize", '<a href="https://evil.example/x">') == reason


def test_spam_rules_are_off_unless_enabled(monkeypatch):
    monkeypatch.setattr(app, "_SMTP_SPAM_TRASH_ENABLED", False)
    monkeypatch.setattr(app, "_SMTP_SPAM_TRASH_SENDERS", {"spam.example"})
    assert app._detect_spam("x@spam.example", "", "", "") == ""
