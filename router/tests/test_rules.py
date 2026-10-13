"""Rule validation and matching."""

from rules import extract_code, matches, select_rules, validate_rule

MESSAGE = {
    "to_addresses": ["otp-github@example.com"],
    "from": {"address": "noreply@GitHub.com"},
    "subject": "[GitHub] Your verification code",
    "text": "Code: 123456. Invoice attached.",
    "has_attachments": False,
    "is_deleted": False,
    "is_spam": False,
}


def rule(match=None, **extra):
    return {"_id": extra.pop("_id", "r"), "name": "r", "match": match or {}, "actions": [{"type": "mark_read"}], **extra}


def test_empty_match_takes_all_non_spam_mail():
    assert matches(rule(), MESSAGE)
    assert not matches(rule(), {**MESSAGE, "is_spam": True, "is_deleted": True})


def test_spam_only_when_asked():
    spam = {**MESSAGE, "is_spam": True, "is_deleted": True}
    assert matches(rule({"include_spam": True}), spam)
    # A message the user already deleted is never routed, even with include_spam.
    assert not matches(rule({"include_spam": True}), {**MESSAGE, "is_deleted": True})


def test_recipient_and_sender_globs_are_case_insensitive():
    assert matches(rule({"to": ["OTP-*@example.com"]}), MESSAGE)
    assert matches(rule({"to": ["*@example.com"], "from": "*@github.com"}), MESSAGE)
    assert not matches(rule({"to": ["hello@example.com"]}), MESSAGE)
    assert not matches(rule({"from": ["*@gitlab.com"]}), MESSAGE)


def test_conditions_are_anded_and_list_entries_ored():
    assert matches(rule({"subject": ["nothing", "VERIFICATION"], "body": ["invoice"]}), MESSAGE)
    assert not matches(rule({"subject": ["verification"], "body": ["refund"]}), MESSAGE)


def test_subject_regex_and_attachments():
    assert matches(rule({"subject_regex": r"^\[github\]"}), MESSAGE)
    assert not matches(rule({"subject_regex": r"^github"}), MESSAGE)
    assert not matches(rule({"has_attachments": True}), MESSAGE)
    assert matches(rule({"has_attachments": False}), MESSAGE)


def test_disabled_rule_never_matches():
    assert not matches(rule(enabled=False), MESSAGE)


def test_select_rules_orders_and_stops():
    rules = [
        rule(_id="late", order=50),
        rule({"to": ["otp-*@example.com"]}, _id="first", order=1, stop=True),
        rule(_id="early", order=0),
    ]
    assert [r["_id"] for r in select_rules(rules, MESSAGE)] == ["early", "first"]


def test_validate_accepts_a_complete_rule():
    good = {
        "name": "all",
        "match": {"to": ["*@example.com"]},
        "actions": [
            {"type": "forward", "to": ["me@gmail.com"], "from": "Me <hi@example.com>"},
            {"type": "ntfy", "topic": "abc"},
            {"type": "telegram", "chat_id": "1", "bot_token_env": "MY_BOT"},
            {"type": "webhook", "url": "https://hooks.test/x"},
            {"type": "tag", "tags": ["otp"]},
            {"type": "trash"},
        ],
    }
    assert validate_rule(good) == []


def test_validate_reports_each_problem():
    bad = {
        "name": "",
        "match": {"subject_regex": "(", "colour": "red"},
        "actions": [
            {"type": "explode"},
            {"type": "forward", "to": ["not-an-address"]},
            {"type": "ntfy"},
            {"type": "webhook", "url": "ftp://x"},
            {"type": "telegram", "chat_id": "1", "bot_token_env": "lower-case"},
        ],
    }
    problems = " | ".join(validate_rule(bad))
    for needle in (
        "name is required",
        "unknown match keys: colour",
        "subject_regex",
        "actions[0].type",
        "actions[1].to",
        "actions[1].from",
        "actions[2].topic",
        "actions[3].url",
        "actions[4].bot_token_env",
    ):
        assert needle in problems
    assert validate_rule({"name": "x", "actions": []}) == ["actions must be a non-empty list"]


def test_extract_code():
    assert extract_code("Your code", "is 482913.") == "482913"
    assert extract_code("order 12345 or 1234567") is None
