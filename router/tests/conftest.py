"""Shared fixtures for mail-router tests. MongoDB is replaced by mongomock."""

import os
import sys
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import mongomock
import pytest

ROUTER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROUTER_DIR)

for _key in list(os.environ):
    if "FORWARD_" in _key or _key.startswith(("ROUTER_", "RESEND_", "TELEGRAM_")):
        del os.environ[_key]

with patch("pymongo.MongoClient", lambda *args, **kwargs: mongomock.MongoClient()):
    import actions  # noqa: E402
    import app as router_app  # noqa: E402


@pytest.fixture
def db(monkeypatch):
    database = mongomock.MongoClient()["test_router"]
    monkeypatch.setattr(router_app, "db", database)
    return database


@pytest.fixture
def http(monkeypatch):
    """Record outgoing HTTP calls instead of making them."""
    calls = []

    def fake_post(url, payload, headers=None):
        calls.append({"url": url, "payload": payload, "headers": headers or {}})
        if fake_post.fail:
            raise RuntimeError(fake_post.fail)
        return {"id": f"id-{len(calls)}"}

    fake_post.fail = None
    fake_post.calls = calls
    monkeypatch.setattr(actions, "_post_json", fake_post)
    return fake_post


@pytest.fixture
def since(db):
    start = datetime.now(timezone.utc) - timedelta(minutes=5)
    db.router_state.insert_one({"_id": "router", "since": start})
    return start


def make_message(db, **fields):
    now = datetime.now(timezone.utc)
    doc = {
        "to_addresses": ["hello@example.com"],
        "from": {"address": "alice@sender.test", "name": "Alice"},
        "subject": "Hello",
        "intro": "Your code is 482913",
        "text": "Your code is 482913",
        "html": "",
        "has_attachments": False,
        "attachments": [],
        "seen": False,
        "is_deleted": False,
        "is_spam": False,
        "created_at": now,
        "updated_at": now,
    }
    doc.update(fields)
    doc["_id"] = db.messages.insert_one(doc).inserted_id
    return doc
