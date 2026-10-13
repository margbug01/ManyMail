"""Manage routing rules from the command line.

    docker compose exec -T mail-router python cli.py list
    docker compose exec -T mail-router python cli.py add - < rule.json
    docker compose exec -T mail-router python cli.py dry-run - 50 < rule.json
    docker compose exec -T mail-router python cli.py test <rule id>
    docker compose exec -T mail-router python cli.py enable|disable|remove <rule id>
    docker compose exec -T mail-router python cli.py status [N]
"""

import json
import re
import sys
from datetime import datetime, timezone

import actions
from app import VIEWER_URL, db, load_rules, now_utc
from rules import matches, validate_rule

NOTIFY_TYPES = {"ntfy", "telegram", "webhook"}


def _read_rule(source: str) -> dict:
    if source == "-":
        return json.load(sys.stdin)
    if source.lstrip().startswith("{"):
        return json.loads(source)
    existing = db.routing_rules.find_one({"_id": source})
    if existing:
        return existing
    with open(source, encoding="utf-8") as handle:
        return json.load(handle)


def _slug(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return slug[:40] or "rule"


def _describe(rule: dict) -> str:
    state = "on " if rule.get("enabled", True) else "off"
    kinds = ",".join(a.get("type", "?") for a in rule.get("actions") or [])
    managed = " (from .env)" if rule.get("managed_by") == "env" else ""
    match = json.dumps(rule.get("match") or {}, ensure_ascii=False)
    return f"[{state}] {rule['_id']}  order={rule.get('order', 100)}  {rule.get('name', '')}{managed}\n      match {match}\n      do    {kinds}"


def cmd_list(_args):
    rules = list(db.routing_rules.find({}).sort([("order", 1), ("_id", 1)]))
    if not rules:
        print("no rules")
    for rule in rules:
        print(_describe(rule))
        problems = validate_rule(rule)
        if problems:
            print("      !! " + "; ".join(problems))


def cmd_add(args):
    rule = _read_rule(args[0])
    rule.setdefault("enabled", True)
    rule.setdefault("order", 100)
    rule["_id"] = str(rule.get("_id") or _slug(rule.get("name", "")))
    problems = validate_rule(rule)
    if problems:
        sys.exit("invalid rule:\n  " + "\n  ".join(problems))
    current = db.routing_rules.find_one({"_id": rule["_id"]})
    if current and current.get("managed_by") == "env":
        sys.exit(f"{rule['_id']} comes from .env; change the FORWARD_* variables instead")
    rule.pop("managed_by", None)
    rule["updated_at"] = now_utc()
    db.routing_rules.replace_one({"_id": rule["_id"]}, rule, upsert=True)
    print(("updated " if current else "added ") + _describe(rule))


def _set_enabled(rule_id: str, enabled: bool):
    result = db.routing_rules.update_one({"_id": rule_id}, {"$set": {"enabled": enabled, "updated_at": now_utc()}})
    if not result.matched_count:
        sys.exit(f"no rule {rule_id}")
    print(f"{rule_id} {'enabled' if enabled else 'disabled'}")


def cmd_remove(args):
    rule = db.routing_rules.find_one({"_id": args[0]})
    if not rule:
        sys.exit(f"no rule {args[0]}")
    if rule.get("managed_by") == "env":
        sys.exit(f"{args[0]} comes from .env; clear its FORWARD_* variables instead")
    db.routing_rules.delete_one({"_id": args[0]})
    print(f"removed {args[0]}")


def cmd_dry_run(args):
    rule = _read_rule(args[0])
    rule = {**rule, "enabled": True}
    limit = int(args[1]) if len(args) > 1 else 50
    hits = 0
    for message in db.messages.find({}, {"html": 0, "attachments.content": 0}).sort("created_at", -1).limit(limit):
        if matches(rule, message):
            hits += 1
            sender = (message.get("from") or {}).get("address", "")
            when = message.get("created_at")
            stamp = when.strftime("%m-%d %H:%M") if isinstance(when, datetime) else "?"
            print(f"  {stamp}  {sender} -> {','.join(message.get('to_addresses') or [])}  {message.get('subject', '')[:60]}")
    print(f"{hits} of the last {limit} messages match")


def cmd_test(args):
    rule = db.routing_rules.find_one({"_id": args[0]})
    if not rule:
        sys.exit(f"no rule {args[0]}")
    sample = {
        "_id": "test",
        "from": {"address": "sender@example.com", "name": "ManyMail test"},
        "to_addresses": ["you@example.com"],
        "subject": "ManyMail router test",
        "intro": "If you can read this, the notification channel works. Code 123456.",
        "created_at": datetime.now(timezone.utc),
    }
    sent = 0
    for index, action in enumerate(rule.get("actions") or []):
        if action.get("type") not in NOTIFY_TYPES:
            continue
        ctx = {"db": db, "rule": rule, "action_key": f"test:{index}", "viewer_url": VIEWER_URL}
        try:
            print(f"{action['type']}: {actions.run_action(action, sample, ctx)}")
            sent += 1
        except Exception as exc:  # noqa: BLE001
            print(f"{action['type']}: FAILED {exc}")
    if not sent:
        print("rule has no ntfy / telegram / webhook actions to test")


def cmd_status(args):
    limit = int(args[0]) if args else 20
    rules = {str(r["_id"]): r for r in load_rules()}
    cursor = db.messages.find({"routing": {"$exists": True}}, {"subject": 1, "routing": 1, "created_at": 1})
    for message in cursor.sort("created_at", -1).limit(limit):
        routing = message["routing"]
        names = [rules.get(rid, {}).get("name", rid) for rid in routing.get("matched") or []]
        errors = [f"{k}: {v.get('error', '')[:80]}" for k, v in (routing.get("results") or {}).items() if v.get("status") != "done"]
        print(f"{routing.get('status', '?'):7} {(message.get('subject') or '')[:50]:50}  {', '.join(names) or '-'}")
        for line in errors:
            print(f"          {line}")


COMMANDS = {
    "list": cmd_list,
    "add": cmd_add,
    "remove": cmd_remove,
    "enable": lambda a: _set_enabled(a[0], True),
    "disable": lambda a: _set_enabled(a[0], False),
    "dry-run": cmd_dry_run,
    "test": cmd_test,
    "status": cmd_status,
}


def main(argv):
    if not argv or argv[0] not in COMMANDS:
        sys.exit(__doc__)
    COMMANDS[argv[0]](argv[1:])


if __name__ == "__main__":
    main(sys.argv[1:])
