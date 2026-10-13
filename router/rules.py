"""Rule validation and matching for mail-router. Pure functions, no I/O.

A rule looks like:

    {
      "_id": "...", "name": "OTP to phone", "enabled": true, "order": 10, "stop": false,
      "match": {
        "to": ["otp-*@example.com"],        # glob, any of
        "from": ["*@github.com"],           # glob, any of
        "subject": ["verification", "验证码"],  # substring, any of, case-insensitive
        "subject_regex": "code\\s*\\d+",    # Python regex, case-insensitive
        "body": ["invoice"],                # substring of the text body, any of
        "has_attachments": true,
        "include_spam": false,
        "source": ["smtp", "imap"]          # default ["smtp"]: mail received here
      },
      "actions": [
        {"type": "forward", "to": ["me@gmail.com"], "from": "Me <hi@example.com>",
         "subject_prefix": "[ManyMail]", "api_key_env": "RESEND_API_KEY"},
        {"type": "ntfy", "topic": "my-topic", "server": "https://ntfy.sh", "token_env": ""},
        {"type": "telegram", "chat_id": "123", "bot_token_env": "TELEGRAM_BOT_TOKEN"},
        {"type": "webhook", "url": "https://...", "secret_env": "ROUTER_WEBHOOK_SECRET"},
        {"type": "tag", "tags": ["otp"]},
        {"type": "mark_read"},
        {"type": "trash"}
      ]
    }

Every condition that is present must hold; inside a list any entry may match.
An empty match block matches all mail received here that is not spam. New mail in external
IMAP accounts (reported by the IMAP bridge) only matches rules whose source includes "imap",
and only the notification actions run for it.
"""

import fnmatch
import re

ACTION_TYPES = ("forward", "ntfy", "telegram", "webhook", "tag", "mark_read", "trash")
NOTIFY_TYPES = ("ntfy", "telegram", "webhook")
SOURCES = ("smtp", "imap")
MATCH_KEYS = ("to", "from", "subject", "subject_regex", "body", "has_attachments", "include_spam", "source")
_ENV_NAME = re.compile(r"^[A-Z_][A-Z0-9_]*$")


def as_list(value) -> list:
    if value is None or value == "":
        return []
    if isinstance(value, (list, tuple)):
        return [v for v in value if v not in (None, "")]
    return [value]


def _glob_any(patterns, values) -> bool:
    values = [str(v).strip().lower() for v in values if v]
    for pattern in patterns:
        pattern = str(pattern).strip().lower()
        if any(fnmatch.fnmatchcase(value, pattern) for value in values):
            return True
    return False


def _contains_any(needles, haystack: str) -> bool:
    haystack = (haystack or "").lower()
    return any(str(needle).lower() in haystack for needle in needles)


def _valid_email(value) -> bool:
    text = str(value or "")
    if "<" in text and text.endswith(">"):
        text = text.rsplit("<", 1)[1][:-1]
    return "@" in text and " " not in text.strip()


def validate_rule(rule: dict) -> list:
    """Return a list of human-readable problems; empty means the rule is usable."""
    errors = []
    if not isinstance(rule, dict):
        return ["rule must be an object"]
    if not str(rule.get("name") or "").strip():
        errors.append("name is required")

    match = rule.get("match") or {}
    if not isinstance(match, dict):
        errors.append("match must be an object")
        match = {}
    unknown = sorted(set(match) - set(MATCH_KEYS))
    if unknown:
        errors.append("unknown match keys: " + ", ".join(unknown))
    bad_sources = [s for s in as_list(match.get("source")) if s not in SOURCES]
    if bad_sources:
        errors.append("match.source must be smtp and/or imap")
    if match.get("subject_regex"):
        try:
            re.compile(str(match["subject_regex"]))
        except re.error as exc:
            errors.append(f"subject_regex is not a valid regex: {exc}")

    actions = rule.get("actions")
    if not isinstance(actions, list) or not actions:
        errors.append("actions must be a non-empty list")
        actions = []
    for index, action in enumerate(actions):
        prefix = f"actions[{index}]"
        if not isinstance(action, dict):
            errors.append(f"{prefix} must be an object")
            continue
        kind = action.get("type")
        if kind not in ACTION_TYPES:
            errors.append(f"{prefix}.type must be one of {', '.join(ACTION_TYPES)}")
            continue
        for key in ("api_key_env", "token_env", "bot_token_env", "secret_env"):
            if action.get(key) and not _ENV_NAME.match(str(action[key])):
                errors.append(f"{prefix}.{key} must be an environment variable name")
        if kind == "forward":
            targets = as_list(action.get("to"))
            if not targets or not all(_valid_email(t) for t in targets):
                errors.append(f"{prefix}.to needs one or more email addresses")
            if not _valid_email(action.get("from")):
                errors.append(f"{prefix}.from needs a sender address on a Resend-verified domain")
        elif kind == "ntfy":
            if not str(action.get("topic") or "").strip():
                errors.append(f"{prefix}.topic is required")
            server = str(action.get("server") or "https://ntfy.sh")
            if not server.startswith(("http://", "https://")):
                errors.append(f"{prefix}.server must be an http(s) URL")
        elif kind == "telegram":
            if not str(action.get("chat_id") or "").strip():
                errors.append(f"{prefix}.chat_id is required")
        elif kind == "webhook":
            if not str(action.get("url") or "").startswith(("http://", "https://")):
                errors.append(f"{prefix}.url must be an http(s) URL")
        elif kind == "tag":
            if not as_list(action.get("tags")):
                errors.append(f"{prefix}.tags needs at least one tag")
    return errors


def matches(rule: dict, message: dict) -> bool:
    if not rule.get("enabled", True):
        return False
    match = rule.get("match") or {}

    if message.get("source", "smtp") not in (as_list(match.get("source")) or ["smtp"]):
        return False

    if message.get("is_deleted"):
        # Spam is stored soft-deleted; anything else deleted before routing ran is skipped.
        if not (message.get("is_spam") and match.get("include_spam")):
            return False

    to_patterns = as_list(match.get("to"))
    if to_patterns and not _glob_any(to_patterns, message.get("to_addresses") or []):
        return False

    from_patterns = as_list(match.get("from"))
    sender = (message.get("from") or {}).get("address", "")
    if from_patterns and not _glob_any(from_patterns, [sender]):
        return False

    subject = message.get("subject") or ""
    subject_needles = as_list(match.get("subject"))
    if subject_needles and not _contains_any(subject_needles, subject):
        return False
    if match.get("subject_regex") and not re.search(str(match["subject_regex"]), subject, re.IGNORECASE):
        return False

    body_needles = as_list(match.get("body"))
    if body_needles and not _contains_any(body_needles, message.get("text") or message.get("intro") or ""):
        return False

    if "has_attachments" in match and match["has_attachments"] is not None:
        if bool(match["has_attachments"]) != bool(message.get("has_attachments") or message.get("attachments")):
            return False
    return True


def select_rules(rules: list, message: dict) -> list:
    """Rules that apply to the message, in order; a matching rule with stop=true ends the list."""
    selected = []
    for rule in sort_rules(rules):
        if matches(rule, message):
            selected.append(rule)
            if rule.get("stop"):
                break
    return selected


def sort_rules(rules: list) -> list:
    return sorted(rules, key=lambda r: (r.get("order", 100), str(r.get("_id"))))


_CODE_PATTERN = re.compile(r"\b(\d{6})\b")


def extract_code(*parts: str):
    """First 6-digit number in the given text, same heuristic as the webmail viewer."""
    text = " ".join(p for p in parts if p)
    found = _CODE_PATTERN.search(text)
    return found.group(1) if found else None
