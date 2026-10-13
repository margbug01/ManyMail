"""Rule storage operations shared by the CLI and the HTTP API."""

import re
from datetime import datetime, timezone

import actions
from rules import NOTIFY_TYPES, matches, validate_rule


class RuleError(Exception):
    def __init__(self, message, problems=None, status=400):
        super().__init__(message)
        self.problems = problems or []
        self.status = status


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def slug(name: str) -> str:
    value = re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-")
    return value[:40] or "rule"


def list_rules(db) -> list:
    rules = []
    for rule in db.routing_rules.find({}).sort([("order", 1), ("_id", 1)]):
        rule["problems"] = validate_rule(rule)
        rules.append(rule)
    return rules


def get_rule(db, rule_id: str) -> dict:
    rule = db.routing_rules.find_one({"_id": rule_id})
    if not rule:
        raise RuleError(f"no rule {rule_id}", status=404)
    return rule


def save_rule(db, rule: dict, rule_id: str | None = None) -> tuple:
    """Insert or replace a rule. Returns (rule, created)."""
    if not isinstance(rule, dict):
        raise RuleError("rule must be an object")
    rule = {k: v for k, v in rule.items() if k not in ("managed_by", "problems", "updated_at")}
    rule.setdefault("enabled", True)
    rule.setdefault("order", 100)
    rule["_id"] = str(rule_id or rule.get("_id") or slug(rule.get("name", "")))
    problems = validate_rule(rule)
    if problems:
        raise RuleError("invalid rule", problems)
    current = db.routing_rules.find_one({"_id": rule["_id"]})
    if current and current.get("managed_by") == "env":
        raise RuleError(f"{rule['_id']} comes from .env; change the FORWARD_* variables instead", status=409)
    rule["updated_at"] = now_utc()
    db.routing_rules.replace_one({"_id": rule["_id"]}, rule, upsert=True)
    return rule, current is None


def delete_rule(db, rule_id: str) -> None:
    rule = get_rule(db, rule_id)
    if rule.get("managed_by") == "env":
        raise RuleError(f"{rule_id} comes from .env; clear its FORWARD_* variables instead", status=409)
    db.routing_rules.delete_one({"_id": rule_id})


def set_enabled(db, rule_id: str, enabled: bool) -> None:
    get_rule(db, rule_id)
    db.routing_rules.update_one({"_id": rule_id}, {"$set": {"enabled": bool(enabled), "updated_at": now_utc()}})


def _brief(message: dict) -> dict:
    when = message.get("created_at")
    return {
        "id": str(message.get("_id")),
        "source": message.get("source", "smtp"),
        "from": (message.get("from") or {}).get("address", ""),
        "to": list(message.get("to_addresses") or []),
        "subject": (message.get("subject") or "")[:200],
        "created_at": when.isoformat() if isinstance(when, datetime) else None,
    }


def dry_run(db, rule: dict, limit: int = 50) -> dict:
    """Which of the latest stored messages (and IMAP events) the rule would match."""
    limit = max(1, min(int(limit or 50), 500))
    rule = {**rule, "enabled": True}
    candidates = list(db.messages.find({}, {"html": 0, "attachments.content": 0}).sort("created_at", -1).limit(limit))
    candidates += list(db.routing_events.find({}).sort("created_at", -1).limit(limit))
    candidates.sort(key=lambda m: m.get("created_at") or datetime.min, reverse=True)
    candidates = candidates[:limit]
    hits = [_brief(m) for m in candidates if matches(rule, m)]
    return {"checked": len(candidates), "matched": hits}


SAMPLE = {
    "_id": "test",
    "from": {"address": "sender@example.com", "name": "ManyMail test"},
    "to_addresses": ["you@example.com"],
    "subject": "ManyMail router test",
    "intro": "If you can read this, the notification channel works. Code 123456.",
}


def test_notifications(db, rule: dict, viewer_url: str = "") -> list:
    """Send a sample message through the rule's ntfy / telegram / webhook actions."""
    results = []
    sample = {**SAMPLE, "created_at": now_utc()}
    for index, action in enumerate(rule.get("actions") or []):
        if action.get("type") not in NOTIFY_TYPES:
            continue
        ctx = {"db": db, "rule": rule, "action_key": f"test:{index}", "viewer_url": viewer_url}
        try:
            results.append({"type": action["type"], "ok": True, "detail": actions.run_action(action, sample, ctx)})
        except Exception as exc:  # noqa: BLE001 - reported back to the caller
            results.append({"type": action["type"], "ok": False, "detail": str(exc)[:300]})
    return results


def recent_status(db, limit: int = 20) -> list:
    limit = max(1, min(int(limit or 20), 200))
    names = {str(r["_id"]): r.get("name", r["_id"]) for r in db.routing_rules.find({}, {"name": 1})}
    rows = []
    for collection in (db.messages, db.routing_events):
        cursor = collection.find({"routing": {"$exists": True}}, {"subject": 1, "routing": 1, "created_at": 1,
                                                                  "from": 1, "to_addresses": 1, "source": 1})
        for message in cursor.sort("created_at", -1).limit(limit):
            routing = message["routing"]
            results = routing.get("results") or {}
            rows.append({
                **_brief(message),
                "status": routing.get("status"),
                "rules": [names.get(rid, rid) for rid in routing.get("matched") or []],
                "errors": [f"{k}: {v.get('error', '')[:120]}" for k, v in results.items() if v.get("status") not in ("done",)],
            })
    rows.sort(key=lambda r: r["created_at"] or "", reverse=True)
    return rows[:limit]
