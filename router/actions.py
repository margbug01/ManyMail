"""Actions a routing rule can run. Each returns a short detail string or raises."""

import base64
import hashlib
import hmac
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

from rules import as_list, extract_code

USER_AGENT = "ManyMail-Router/1.1"
HTTP_TIMEOUT = 20


class RetryLater(Exception):
    """Not a failure, just not ready yet (e.g. the legacy forwarder is mid-send)."""


def _env(name: str, *fallbacks: str) -> str:
    for key in (name, *fallbacks):
        if key and os.getenv(key, "").strip():
            return os.getenv(key, "").strip()
    return ""


def _post_json(url: str, payload: dict, headers: dict | None = None) -> dict:
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "User-Agent": USER_AGENT, **(headers or {})},
        method="POST",
    )
    host = urllib.parse.urlsplit(url).hostname
    try:
        with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT) as response:
            raw = response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:300]
        raise RuntimeError(f"{host} HTTP {exc.code}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"{host} connection failed: {exc.reason}") from exc
    try:
        return json.loads(raw) if raw.strip() else {}
    except ValueError:
        return {}


def summarize(message: dict) -> dict:
    sender = message.get("from") or {}
    subject = (message.get("subject") or "").strip() or "(no subject)"
    return {
        "id": str(message.get("_id")),
        "from": sender.get("address", ""),
        "from_name": sender.get("name", ""),
        "to": list(message.get("to_addresses") or []),
        "subject": subject,
        "intro": (message.get("intro") or "")[:300],
        "code": extract_code(message.get("subject") or "", message.get("text") or message.get("intro") or ""),
        "has_attachments": bool(message.get("has_attachments")),
        "created_at": (message.get("created_at") or datetime.now(timezone.utc)).isoformat(),
    }


def notification_text(info: dict) -> str:
    sender = f"{info['from_name']} <{info['from']}>" if info["from_name"] else info["from"]
    lines = [f"From: {sender}", f"To: {', '.join(info['to'])}"]
    if info["code"]:
        lines.append(f"Code: {info['code']}")
    if info["intro"]:
        lines.append("")
        lines.append(info["intro"])
    return "\n".join(lines)


# ---- forward through Resend ------------------------------------------------------------


def build_forward_payload(action: dict, message: dict) -> dict:
    original_from = (message.get("from") or {}).get("address", "").strip().lower()
    subject = (message.get("subject") or "").strip() or "(no subject)"
    prefix = str(action.get("subject_prefix") or "").strip()
    payload = {
        "from": action["from"],
        "to": as_list(action.get("to")),
        "subject": (f"{prefix} {subject}" if prefix else subject)[:998],
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
        attachments.append({
            "filename": attachment.get("filename") or "attachment",
            "content": base64.b64encode(content).decode("ascii"),
        })
    if attachments:
        payload["attachments"] = attachments
    return payload


def forward(action: dict, message: dict, ctx: dict) -> str:
    # Mail the old single-purpose forwarder already handled must not go out twice
    # while both run side by side during the switch-over.
    legacy = message.get("forwarding") or {}
    targets = {t.lower() for t in as_list(action.get("to"))}
    if legacy.get("target") in targets:
        if legacy.get("status") == "forwarded":
            return f"already forwarded by the legacy forwarder ({legacy.get('resend_id', '')})"
        if legacy.get("status") == "sending":
            raise RetryLater("legacy forwarder is sending this message")

    api_key = _env(action.get("api_key_env") or "", "RESEND_API_KEY", "FORWARD_RESEND_API_KEY")
    if not api_key:
        raise RuntimeError("no Resend API key (set RESEND_API_KEY or the rule's api_key_env)")
    body = _post_json(
        "https://api.resend.com/emails",
        build_forward_payload(action, message),
        {
            "Authorization": f"Bearer {api_key}",
            "Idempotency-Key": f"manymail-route-{message['_id']}-{ctx['action_key']}"[:256],
        },
    )
    if not body.get("id"):
        raise RuntimeError("Resend response did not include an email id")
    return f"resend {body['id']}"


# ---- push notifications ---------------------------------------------------------------


def ntfy(action: dict, message: dict, ctx: dict) -> str:
    info = summarize(message)
    server = str(action.get("server") or "https://ntfy.sh").rstrip("/")
    payload = {
        "topic": str(action["topic"]).strip(),
        "title": info["subject"][:250],
        "message": notification_text(info),
        "tags": ["envelope"],
    }
    if action.get("priority"):
        payload["priority"] = int(action["priority"])
    if ctx.get("viewer_url"):
        payload["click"] = ctx["viewer_url"]
    headers = {}
    token = _env(action.get("token_env") or "")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    body = _post_json(server, payload, headers)
    return f"ntfy {body.get('id', 'sent')}"


def telegram(action: dict, message: dict, ctx: dict) -> str:
    token = _env(action.get("bot_token_env") or "", "TELEGRAM_BOT_TOKEN")
    if not token:
        raise RuntimeError("no Telegram bot token (set TELEGRAM_BOT_TOKEN or the rule's bot_token_env)")
    info = summarize(message)
    text = f"✉️ {info['subject']}\n{notification_text(info)}"
    if ctx.get("viewer_url"):
        text += f"\n\n{ctx['viewer_url']}"
    body = _post_json(
        f"https://api.telegram.org/bot{token}/sendMessage",
        {"chat_id": str(action["chat_id"]), "text": text[:4000], "disable_web_page_preview": True},
    )
    return f"telegram {(body.get('result') or {}).get('message_id', 'sent')}"


def webhook(action: dict, message: dict, ctx: dict) -> str:
    payload = {
        "event": "message.received",
        "rule": {"id": str(ctx["rule"].get("_id")), "name": ctx["rule"].get("name", "")},
        "message": summarize(message),
    }
    headers = {}
    secret = _env(action.get("secret_env") or "")
    if secret:
        raw = json.dumps(payload).encode("utf-8")
        signature = hmac.new(secret.encode("utf-8"), raw, hashlib.sha256).hexdigest()
        headers["X-ManyMail-Signature"] = f"sha256={signature}"
    _post_json(str(action["url"]), payload, headers)
    return "webhook delivered"


# ---- local mailbox changes ------------------------------------------------------------


def tag(action: dict, message: dict, ctx: dict) -> str:
    tags = list(dict.fromkeys(str(t).strip() for t in as_list(action.get("tags")) if str(t).strip()))
    ctx["db"].messages.update_one({"_id": message["_id"]}, {"$addToSet": {"tags": {"$each": tags}}})
    return "tagged " + ", ".join(tags)


def mark_read(action: dict, message: dict, ctx: dict) -> str:
    ctx["db"].messages.update_one(
        {"_id": message["_id"]},
        {"$set": {"seen": True, "updated_at": datetime.now(timezone.utc)}},
    )
    return "marked read"


def trash(action: dict, message: dict, ctx: dict) -> str:
    ctx["db"].messages.update_one(
        {"_id": message["_id"]},
        {"$set": {"is_deleted": True, "updated_at": datetime.now(timezone.utc)}},
    )
    return "moved to trash"


HANDLERS = {
    "forward": forward,
    "ntfy": ntfy,
    "telegram": telegram,
    "webhook": webhook,
    "tag": tag,
    "mark_read": mark_read,
    "trash": trash,
}


def run_action(action: dict, message: dict, ctx: dict) -> str:
    return HANDLERS[action["type"]](action, message, ctx)
