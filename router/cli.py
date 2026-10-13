"""Manage routing rules from the command line (the webmail has a /rules page for the same).

    docker compose exec -T mail-router python cli.py list
    docker compose exec -T mail-router python cli.py add - < rule.json
    docker compose exec -T mail-router python cli.py dry-run - 50 < rule.json
    docker compose exec -T mail-router python cli.py test <rule id>
    docker compose exec -T mail-router python cli.py enable|disable|remove <rule id>
    docker compose exec -T mail-router python cli.py status [N]
"""

import json
import sys

import store
from app import VIEWER_URL, db


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


def _describe(rule: dict) -> str:
    state = "on " if rule.get("enabled", True) else "off"
    kinds = ",".join(a.get("type", "?") for a in rule.get("actions") or [])
    managed = " (from .env)" if rule.get("managed_by") == "env" else ""
    match = json.dumps(rule.get("match") or {}, ensure_ascii=False)
    return f"[{state}] {rule['_id']}  order={rule.get('order', 100)}  {rule.get('name', '')}{managed}\n      match {match}\n      do    {kinds}"


def cmd_list(_args):
    rules = store.list_rules(db)
    if not rules:
        print("no rules")
    for rule in rules:
        print(_describe(rule))
        if rule["problems"]:
            print("      !! " + "; ".join(rule["problems"]))


def cmd_add(args):
    rule, created = store.save_rule(db, _read_rule(args[0]))
    print(("added " if created else "updated ") + _describe(rule))


def cmd_remove(args):
    store.delete_rule(db, args[0])
    print(f"removed {args[0]}")


def _set_enabled(rule_id: str, enabled: bool):
    store.set_enabled(db, rule_id, enabled)
    print(f"{rule_id} {'enabled' if enabled else 'disabled'}")


def cmd_dry_run(args):
    limit = int(args[1]) if len(args) > 1 else 50
    result = store.dry_run(db, _read_rule(args[0]), limit)
    for hit in result["matched"]:
        stamp = (hit["created_at"] or "?")[5:16].replace("T", " ")
        print(f"  {stamp}  [{hit['source']}] {hit['from']} -> {','.join(hit['to'])}  {hit['subject'][:60]}")
    print(f"{len(result['matched'])} of the last {result['checked']} messages match")


def cmd_test(args):
    results = store.test_notifications(db, store.get_rule(db, args[0]), VIEWER_URL)
    for item in results:
        print(f"{item['type']}: {'' if item['ok'] else 'FAILED '}{item['detail']}")
    if not results:
        print("rule has no ntfy / telegram / webhook actions to test")


def cmd_status(args):
    for row in store.recent_status(db, int(args[0]) if args else 20):
        print(f"{row['status'] or '?':7} [{row['source']}] {row['subject'][:50]:50}  {', '.join(row['rules']) or '-'}")
        for line in row["errors"]:
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
    try:
        COMMANDS[argv[0]](argv[1:])
    except store.RuleError as exc:
        sys.exit("\n  ".join([str(exc), *exc.problems]))


if __name__ == "__main__":
    main(sys.argv[1:])
