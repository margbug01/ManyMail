"""Small JSON API for the webmail rules page and the IMAP bridge (mail-net only).

    GET    /health
    GET    /rules                      list rules (with validation problems)
    POST   /rules                      create; PUT /rules/<id> replace; DELETE /rules/<id>
    POST   /rules/<id>/enabled         {"enabled": true|false}
    POST   /rules/<id>/test            send a sample through the rule's notification actions
    POST   /test                       same for an unsaved rule: {"rule": {...}}
    POST   /dry-run                    {"rule": {...}, "limit": 50}
    GET    /status?limit=20            recently routed mail
    POST   /events/imap                new mail in an external IMAP account (from the bridge)

Everything except /health needs `X-API-Key: $API_KEY`.
"""

import hmac
import json
import logging
import os
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlsplit

from pymongo.errors import DuplicateKeyError

import store

logger = logging.getLogger("mail-router")
MAX_BODY = 256 * 1024
MAX_EVENTS = 50


def _json_default(value):
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value)


def record_imap_event(db, payload: dict) -> int:
    """Store new-mail notices from the IMAP bridge; duplicates (same account/uid) are ignored."""
    account = str(payload.get("account") or "").strip().lower()
    if "@" not in account:
        raise store.RuleError("account must be an email address")
    messages = payload.get("messages")
    if not isinstance(messages, list) or not messages:
        raise store.RuleError("messages must be a non-empty list")
    validity = str(payload.get("uidvalidity") or "0")
    accepted = 0
    now = datetime.now(timezone.utc)
    for item in messages[:MAX_EVENTS]:
        if not isinstance(item, dict) or not str(item.get("uid") or "").isdigit():
            continue
        sender = item.get("from") if isinstance(item.get("from"), dict) else {}
        doc = {
            "event_key": f"imap:{account}:{validity}:{item['uid']}",
            "source": "imap",
            "account": account,
            "uid": int(item["uid"]),
            "to_addresses": [account],
            "from": {"address": str(sender.get("address") or "")[:320].lower(),
                     "name": str(sender.get("name") or "")[:200]},
            "subject": str(item.get("subject") or "")[:500],
            "intro": str(item.get("intro") or "")[:300],
            "has_attachments": bool(item.get("has_attachments")),
            "is_deleted": False,
            "created_at": now,
        }
        try:
            db.routing_events.insert_one(doc)
            accepted += 1
        except DuplicateKeyError:
            pass
    return accepted


def make_handler(db, api_key: str, viewer_url: str = ""):
    class Handler(BaseHTTPRequestHandler):
        server_version = "ManyMailRouter/1.2"

        def log_message(self, fmt, *args):  # keep request noise out of the router log
            pass

        def _send(self, status: int, body: dict) -> None:
            raw = json.dumps(body, default=_json_default, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def _body(self) -> dict:
            length = int(self.headers.get("Content-Length") or 0)
            if length > MAX_BODY:
                raise store.RuleError("request body too large", status=413)
            if not length:
                return {}
            try:
                data = json.loads(self.rfile.read(length).decode("utf-8"))
            except ValueError as exc:
                raise store.RuleError("body is not valid JSON") from exc
            if not isinstance(data, dict):
                raise store.RuleError("body must be a JSON object")
            return data

        def _authorized(self) -> bool:
            given = self.headers.get("X-API-Key", "")
            return bool(api_key) and hmac.compare_digest(given.encode(), api_key.encode())

        def _dispatch(self, method: str) -> None:
            url = urlsplit(self.path)
            parts = [unquote(p) for p in url.path.strip("/").split("/") if p]
            if method == "GET" and parts == ["health"]:
                return self._send(200, {"ok": True})
            if not api_key:
                return self._send(503, {"error": "API_KEY is not set for mail-router"})
            if not self._authorized():
                return self._send(401, {"error": "invalid API key"})
            try:
                self._route(method, parts, parse_qs(url.query))
            except store.RuleError as exc:
                self._send(exc.status, {"error": str(exc), "problems": exc.problems})
            except Exception:  # noqa: BLE001
                logger.exception("API %s %s failed", method, url.path)
                self._send(500, {"error": "internal error"})

        def _route(self, method, parts, query):
            if parts == ["rules"] and method == "GET":
                return self._send(200, {"rules": store.list_rules(db)})
            if parts == ["rules"] and method == "POST":
                rule, created = store.save_rule(db, self._body())
                return self._send(201 if created else 200, {"rule": rule, "created": created})
            if len(parts) == 2 and parts[0] == "rules":
                if method == "PUT":
                    rule, created = store.save_rule(db, self._body(), rule_id=parts[1])
                    return self._send(200, {"rule": rule, "created": created})
                if method == "DELETE":
                    store.delete_rule(db, parts[1])
                    return self._send(200, {"deleted": parts[1]})
            if len(parts) == 3 and parts[0] == "rules" and method == "POST":
                if parts[2] == "enabled":
                    store.set_enabled(db, parts[1], bool(self._body().get("enabled")))
                    return self._send(200, {"id": parts[1]})
                if parts[2] == "test":
                    rule = store.get_rule(db, parts[1])
                    return self._send(200, {"results": store.test_notifications(db, rule, viewer_url)})
            if parts == ["test"] and method == "POST":
                rule = self._body().get("rule")
                if not isinstance(rule, dict):
                    raise store.RuleError("rule must be an object")
                return self._send(200, {"results": store.test_notifications(db, rule, viewer_url)})
            if parts == ["dry-run"] and method == "POST":
                body = self._body()
                if not isinstance(body.get("rule"), dict):
                    raise store.RuleError("rule must be an object")
                return self._send(200, store.dry_run(db, body["rule"], body.get("limit") or 50))
            if parts == ["status"] and method == "GET":
                limit = (query.get("limit") or ["20"])[0]
                return self._send(200, {"messages": store.recent_status(db, int(limit) if limit.isdigit() else 20)})
            if parts == ["events", "imap"] and method == "POST":
                return self._send(202, {"accepted": record_imap_event(db, self._body())})
            return self._send(404, {"error": "not found"})

        def do_GET(self):
            self._dispatch("GET")

        def do_POST(self):
            self._dispatch("POST")

        def do_PUT(self):
            self._dispatch("PUT")

        def do_DELETE(self):
            self._dispatch("DELETE")

    return Handler


def start_in_background(db, api_key=None, viewer_url="", host="0.0.0.0", port=None):
    if api_key is None:
        api_key = os.getenv("ROUTER_API_KEY") or os.getenv("API_KEY", "")
    port = int(port or os.getenv("ROUTER_API_PORT", "8090"))
    server = ThreadingHTTPServer((host, port), make_handler(db, api_key.strip(), viewer_url))
    threading.Thread(target=server.serve_forever, name="router-api", daemon=True).start()
    if not api_key.strip():
        logger.warning("API_KEY is empty: the rules API on :%d answers 503", port)
    logger.info("Rules API listening on :%d", port)
    return server
