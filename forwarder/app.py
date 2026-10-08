"""Forward selected ManyMail inbox messages through Resend."""

import base64
import json
import logging
import os
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

from pymongo import MongoClient, ReturnDocument


MONGO_URL = os.getenv("MONGO_URL", "mongodb://mongodb:27017")
DB_NAME = os.getenv("DB_NAME", "mailserver")
RESEND_API_KEY = os.getenv("RESEND_API_KEY", "").strip()
SOURCE_ADDRESS = os.getenv("FORWARD_SOURCE_ADDRESS", "").strip().lower()
TARGET_ADDRESS = os.getenv("FORWARD_TO_ADDRESS", "").strip().lower()
FORWARD_FROM = os.getenv("FORWARD_FROM", "").strip()
POLL_SECONDS = max(2, int(os.getenv("FORWARD_POLL_SECONDS", "5")))
RETRY_SECONDS = max(15, int(os.getenv("FORWARD_RETRY_SECONDS", "60")))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [mail-forwarder] %(levelname)s: %(message)s",
)
logger = logging.getLogger("mail-forwarder")

mongo_client = MongoClient(MONGO_URL, serverSelectionTimeoutMS=5000)
db = mongo_client[DB_NAME]


def validate_config():
    missing = [
        name
        for name, value in (
            ("RESEND_API_KEY", RESEND_API_KEY),
            ("FORWARD_SOURCE_ADDRESS", SOURCE_ADDRESS),
            ("FORWARD_TO_ADDRESS", TARGET_ADDRESS),
            ("FORWARD_FROM", FORWARD_FROM),
        )
        if not value
    ]
    if missing:
        raise RuntimeError("Missing required configuration: " + ", ".join(missing))
    if "@" not in SOURCE_ADDRESS or "@" not in TARGET_ADDRESS:
        raise RuntimeError("Forwarding addresses must be valid email addresses")


def build_payload(message: dict) -> dict:
    original_from = (message.get("from") or {}).get("address", "").strip().lower()
    original_subject = (message.get("subject") or "").strip() or "(no subject)"
    payload = {
        "from": FORWARD_FROM,
        "to": [TARGET_ADDRESS],
        "subject": f"[Canton Medical] {original_subject}"[:998],
    }
    if "@" in original_from:
        payload["reply_to"] = original_from

    text_body = message.get("text") or ""
    html_body = message.get("html") or ""
    if text_body:
        payload["text"] = text_body
    if html_body:
        payload["html"] = html_body
    if not text_body and not html_body:
        payload["text"] = "The original message did not contain a readable body."

    attachments = []
    for attachment in message.get("attachments") or []:
        content = attachment.get("content")
        if not isinstance(content, (bytes, bytearray)):
            continue
        attachments.append(
            {
                "filename": attachment.get("filename") or "attachment",
                "content": base64.b64encode(content).decode("ascii"),
            }
        )
    if attachments:
        payload["attachments"] = attachments
    return payload


def send_via_resend(message: dict) -> str:
    message_id = str(message["_id"])
    request = urllib.request.Request(
        "https://api.resend.com/emails",
        data=json.dumps(build_payload(message)).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {RESEND_API_KEY}",
            "Content-Type": "application/json",
            "User-Agent": "ManyMail-Forwarder/1.0",
            "Idempotency-Key": f"manymail-forward-{message_id}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            body = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:500]
        raise RuntimeError(f"Resend HTTP {exc.code}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Resend connection failed: {exc.reason}") from exc

    resend_id = body.get("id")
    if not resend_id:
        raise RuntimeError("Resend response did not include an email id")
    return resend_id


def claim_next_message():
    now = datetime.now(timezone.utc)
    stale_before = now - timedelta(minutes=10)
    return db.messages.find_one_and_update(
        {
            "to_addresses": SOURCE_ADDRESS,
            "is_deleted": {"$ne": True},
            "$or": [
                {"forwarding.status": {"$exists": False}},
                {"forwarding.status": "pending"},
                {
                    "forwarding.status": "retry",
                    "forwarding.next_attempt_at": {"$lte": now},
                },
                {
                    "forwarding.status": "sending",
                    "forwarding.last_attempt_at": {"$lte": stale_before},
                },
            ],
        },
        {
            "$set": {
                "forwarding.status": "sending",
                "forwarding.target": TARGET_ADDRESS,
                "forwarding.last_attempt_at": now,
            },
            "$inc": {"forwarding.attempts": 1},
        },
        sort=[("created_at", 1)],
        return_document=ReturnDocument.AFTER,
    )


def process_next_message() -> bool:
    message = claim_next_message()
    if not message:
        return False

    try:
        resend_id = send_via_resend(message)
        db.messages.update_one(
            {"_id": message["_id"]},
            {
                "$set": {
                    "forwarding.status": "forwarded",
                    "forwarding.forwarded_at": datetime.now(timezone.utc),
                    "forwarding.resend_id": resend_id,
                },
                "$unset": {
                    "forwarding.last_error": "",
                    "forwarding.next_attempt_at": "",
                },
            },
        )
        logger.info(
            "Forwarded message %s to %s",
            str(message["_id"]),
            TARGET_ADDRESS,
        )
    except Exception as exc:
        attempts = int((message.get("forwarding") or {}).get("attempts", 1))
        delay = min(RETRY_SECONDS * (2 ** min(attempts - 1, 6)), 3600)
        db.messages.update_one(
            {"_id": message["_id"]},
            {
                "$set": {
                    "forwarding.status": "retry",
                    "forwarding.last_error": str(exc)[:500],
                    "forwarding.next_attempt_at": datetime.now(timezone.utc)
                    + timedelta(seconds=delay),
                }
            },
        )
        logger.warning("Forward failed; retry scheduled: %s", str(exc)[:300])
    return True


def main():
    validate_config()
    db.messages.create_index(
        [("forwarding.status", 1), ("forwarding.next_attempt_at", 1)]
    )
    logger.info("Forwarding enabled: %s -> %s", SOURCE_ADDRESS, TARGET_ADDRESS)
    while True:
        if not process_next_message():
            time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
