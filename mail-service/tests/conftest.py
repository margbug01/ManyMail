"""
Shared pytest fixtures for mail-service tests.

Uses mongomock to avoid requiring a real MongoDB instance.
"""

import os

# Set test environment BEFORE importing app
os.environ.update({
    "MONGO_URL": "mongomock://localhost",
    "DB_NAME": "test_mailserver",
    "JWT_SECRET": "test-secret-key-for-ci",
    "API_KEY": "test-api-key",
    "SMTP_HOSTNAME": "mail.test.local",
    "DOMAINS": "test.local,example.test",
    "ENVIRONMENT": "development",
    "RATE_LIMIT_MAX": "0",  # disable rate limiting in tests
})

import pytest
from unittest.mock import patch, MagicMock
import mongomock
from fastapi.testclient import TestClient


@pytest.fixture(autouse=True)
def mock_mongo():
    """Replace pymongo with mongomock for all tests."""
    mock_client = mongomock.MongoClient()
    mock_db = mock_client["test_mailserver"]

    with patch("app.mongo_client", mock_client), \
         patch("app.db", mock_db):
        # Re-init indexes
        from app import init_db
        init_db()
        yield mock_db

    mock_client.close()


@pytest.fixture(autouse=True)
def mock_smtp():
    """Prevent SMTP server from actually starting during tests."""
    with patch("app.start_smtp_server"):
        yield


@pytest.fixture
def client(mock_mongo, mock_smtp):
    """FastAPI test client."""
    from app import app
    with TestClient(app) as c:
        yield c


@pytest.fixture
def test_account(client):
    """Create a test account and return (address, password, token)."""
    address = "testuser@test.local"
    password = "testpass123"

    resp = client.post("/accounts", json={"address": address, "password": password})
    assert resp.status_code == 201

    resp = client.post("/token", json={"address": address, "password": password})
    assert resp.status_code == 200
    token = resp.json()["token"]

    return address, password, token


@pytest.fixture
def auth_header(test_account):
    """Authorization header for authenticated requests."""
    _, _, token = test_account
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def sample_message(mock_mongo, test_account):
    """Insert a sample message into the DB and return its ID."""
    from datetime import datetime, timezone
    from bson import ObjectId

    address = test_account[0]
    msg_id = ObjectId()
    mock_mongo.messages.insert_one({
        "_id": msg_id,
        "to_addresses": [address],
        "from": {"address": "sender@external.com", "name": "Test Sender"},
        "to": [{"address": address, "name": ""}],
        "subject": "Test Subject",
        "intro": "This is a test email preview",
        "text": "Hello, this is a test email body.",
        "html": "<p>Hello, this is a <b>test</b> email body.</p>",
        "has_attachments": False,
        "seen": False,
        "is_deleted": False,
        "size": 256,
        "created_at": datetime.now(timezone.utc),
        "updated_at": datetime.now(timezone.utc),
    })
    return str(msg_id)
