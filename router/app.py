"""mail-router: run forwarding / notification rules against incoming mail.

Replaces the single-address forwarder. Rules live in the `routing_rules` collection;
the old FORWARD_* and PAYPAL_FORWARD_* variables are turned into rules on startup so
existing deployments keep working without touching .env.

Per message, routing state is kept under `routing`:
    status       running | retry | done | failed
    matched      ids of the rules that matched when the message was first seen
    results      {"<rule id>:<action index>": {"status": "done" | "error", ...}}
Only actions that have not succeeded are run again on retry.

New mail in external IMAP accounts arrives as `routing_events` documents (posted by the
IMAP bridge to the HTTP API in api.py) and goes through the same loop, notification
actions only.
"""

import logging
import os
import time
from datetime import datetime, timedelta, timezone

from pymongo import ASCENDING, MongoClient, ReturnDocument

import actions
from rules import NOTIFY_TYPES, select_rules, sort_rules, validate_rule

MONGO_URL = os.getenv("MONGO_URL", "mongodb://mongodb:27017")
DB_NAME = os.getenv("DB_NAME", "mailserver")
POLL_SECONDS = max(2, int(os.getenv("ROUTER_POLL_SECONDS", os.getenv("FORWARD_POLL_SECONDS", "5"))))
RETRY_SECONDS = max(15, int(os.getenv("ROUTER_RETRY_SECONDS", os.getenv("FORWARD_RETRY_SECONDS", "60"))))
MAX_ATTEMPTS = max(1, int(os.getenv("ROUTER_MAX_ATTEMPTS", "12")))
STALE_CLAIM = timedelta(minutes=10)
VIEWER_URL = os.getenv("VIEWER_PUBLIC_URL", "").strip()

# Old single-forwarder variables -> rule id. Kept as rules so .env stays the source of truth.
LEGACY_FORWARDS = (
    ("env-forward", ""),
    ("env-paypal-forward", "PAYPAL_"),
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [mail-router] %(levelname)s: %(message)s")
logger = logging.getLogger("mail-router")

mongo_client = MongoClient(MONGO_URL, serverSelectionTimeoutMS=5000)
db = mongo_client[DB_NAME]


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _aware(value: datetime) -> datetime:
    # PyMongo hands back naive UTC datetimes unless tz_aware is set.
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def legacy_rule(rule_id: str, prefix: str):
    source = os.getenv(f"{prefix}FORWARD_SOURCE_ADDRESS", "").strip().lower()
    target = os.getenv(f"{prefix}FORWARD_TO_ADDRESS", "").strip().lower()
    sender = os.getenv(f"{prefix}FORWARD_FROM", "").strip()
    if not (source and target and sender):
        return None
    return {
        "_id": rule_id,
        "name": f"Forward {source}",
        "managed_by": "env",
        "enabled": True,
        "order": 0,
        "stop": False,
        "match": {"to": [source]},
        "actions": [{
            "type": "forward",
            "to": [target],
            "from": sender,
            "subject_prefix": os.getenv(f"{prefix}FORWARD_SUBJECT_PREFIX", "").strip(),
            "api_key_env": f"{prefix}FORWARD_RESEND_API_KEY",
        }],
    }


def seed_legacy_rules() -> None:
    for rule_id, prefix in LEGACY_FORWARDS:
        rule = legacy_rule(rule_id, prefix)
        if rule is None:
            db.routing_rules.delete_one({"_id": rule_id, "managed_by": "env"})
            continue
        problems = validate_rule(rule)
        if problems:
            logger.error("Ignoring %sFORWARD_* settings: %s", prefix, "; ".join(problems))
            continue
        db.routing_rules.replace_one({"_id": rule_id}, {**rule, "updated_at": now_utc()}, upsert=True)
        logger.info("Rule %s from %sFORWARD_*: %s -> %s", rule_id, prefix,
                    rule["match"]["to"][0], rule["actions"][0]["to"][0])


def start_time() -> datetime:
    """Only mail that arrives after the router first started is routed (no replay of history)."""
    state = db.router_state.find_one({"_id": "router"})
    if state is None:
        override = os.getenv("ROUTER_START_FROM", "").strip()
        since = datetime.fromisoformat(override) if override else now_utc()
        since = _aware(since)
        db.router_state.update_one({"_id": "router"}, {"$setOnInsert": {"since": since}}, upsert=True)
        state = db.router_state.find_one({"_id": "router"})
    return _aware(state["since"])


def load_rules() -> list:
    usable = []
    for rule in db.routing_rules.find({}):
        problems = validate_rule(rule)
        if problems:
            logger.warning("Skipping rule %s: %s", rule.get("_id"), "; ".join(problems))
            continue
        usable.append(rule)
    return sort_rules(usable)


def claim_next_message(since: datetime, collection=None):
    collection = db.messages if collection is None else collection
    now = now_utc()
    return collection.find_one_and_update(
        {
            "created_at": {"$gte": since},
            "$or": [
                {"routing.status": {"$exists": False}},
                {"routing.status": "retry", "routing.next_attempt_at": {"$lte": now}},
                {"routing.status": "running", "routing.claimed_at": {"$lte": now - STALE_CLAIM}},
            ],
        },
        {"$set": {"routing.status": "running", "routing.claimed_at": now}, "$inc": {"routing.attempts": 1}},
        sort=[("created_at", ASCENDING)],
        return_document=ReturnDocument.AFTER,
    )


def process_message(message: dict, rules: list, collection=None) -> str:
    collection = db.messages if collection is None else collection
    external = message.get("source") == "imap"
    routing = message.get("routing") or {}
    if "matched" in routing:
        wanted = set(routing["matched"])
        matched = [rule for rule in rules if str(rule["_id"]) in wanted]
    else:
        matched = select_rules(rules, message)
    results = dict(routing.get("results") or {})

    failed, waiting = [], []
    for rule in matched:
        for index, action in enumerate(rule["actions"]):
            key = f"{rule['_id']}:{index}"
            if (results.get(key) or {}).get("status") == "done":
                continue
            if external and action["type"] not in NOTIFY_TYPES:
                # Forwarding or changing a message needs it stored here; IMAP mail only has a header.
                results[key] = {"status": "done", "type": action["type"], "detail": "skipped for IMAP mail", "at": now_utc()}
                continue
            ctx = {"db": db, "rule": rule, "action_key": key, "viewer_url": VIEWER_URL}
            try:
                detail = actions.run_action(action, message, ctx)
                results[key] = {"status": "done", "type": action["type"], "detail": detail[:300], "at": now_utc()}
                logger.info("%s %s on %s: %s", key, action["type"], message["_id"], detail[:200])
            except actions.RetryLater as exc:
                waiting.append(key)
                results[key] = {"status": "waiting", "type": action["type"], "error": str(exc)[:300], "at": now_utc()}
            except Exception as exc:  # noqa: BLE001 - every failure is recorded and retried
                failed.append(key)
                results[key] = {"status": "error", "type": action["type"], "error": str(exc)[:500], "at": now_utc()}
                logger.warning("%s %s on %s failed: %s", key, action["type"], message["_id"], str(exc)[:300])

    attempts = int(routing.get("attempts") or 1)
    update = {
        "routing.matched": [str(rule["_id"]) for rule in matched],
        "routing.results": results,
        "routing.updated_at": now_utc(),
    }
    unset = {}
    if failed and attempts >= MAX_ATTEMPTS:
        status = "failed"
        unset["routing.next_attempt_at"] = ""
    elif failed or waiting:
        status = "retry"
        delay = RETRY_SECONDS * (2 ** min(attempts - 1, 6)) if failed else POLL_SECONDS * 2
        update["routing.next_attempt_at"] = now_utc() + timedelta(seconds=min(delay, 3600))
    else:
        status = "done"
        unset["routing.next_attempt_at"] = ""
    update["routing.status"] = status
    change = {"$set": update}
    if unset:
        change["$unset"] = unset
    collection.update_one({"_id": message["_id"]}, change)
    return status


def ensure_indexes() -> None:
    db.messages.create_index([("routing.status", ASCENDING), ("created_at", ASCENDING)])
    db.messages.create_index([("routing.status", ASCENDING), ("routing.next_attempt_at", ASCENDING)])
    db.routing_events.create_index("event_key", unique=True)
    db.routing_events.create_index([("routing.status", ASCENDING), ("created_at", ASCENDING)])
    # IMAP events only matter while they are fresh.
    db.routing_events.create_index("created_at", expireAfterSeconds=30 * 24 * 3600)


def run_once(since: datetime) -> bool:
    """Route one pending message or IMAP event; False when there was nothing to do."""
    for collection in (db.messages, db.routing_events):
        message = claim_next_message(since, collection)
        if message is not None:
            # Rules are re-read per message (a handful of documents) so edits apply at once.
            process_message(message, load_rules(), collection)
            return True
    return False


def main():
    ensure_indexes()
    seed_legacy_rules()
    since = start_time()
    logger.info("Routing mail received since %s with %d rule(s)", since.isoformat(), len(load_rules()))
    import api  # noqa: PLC0415 - api imports this module

    api.start_in_background(db, viewer_url=VIEWER_URL)
    while True:
        if not run_once(since):
            time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
