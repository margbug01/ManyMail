"""Tests for mail-service REST API endpoints."""

import asyncio
from email.message import EmailMessage
from types import SimpleNamespace


# ========== Health ==========

class TestHealth:
    def test_health_ok(self, client):
        resp = client.get("/health")
        assert resp.status_code == 200
        assert resp.json()["status"] == "ok"


# ========== Domains ==========

class TestDomains:
    def test_list_domains(self, client):
        resp = client.get("/domains")
        assert resp.status_code == 200
        domains = resp.json()["hydra:member"]
        domain_names = [d["domain"] for d in domains]
        assert "test.local" in domain_names
        assert "example.test" in domain_names

    def test_admin_add_domain(self, client):
        resp = client.post(
            "/admin/domains",
            json={"domain": "newdomain.test"},
            headers={"X-API-Key": "test-api-key"},
        )
        assert resp.status_code == 201
        assert resp.json()["domain"] == "newdomain.test"

        # Verify it shows up
        resp = client.get("/domains")
        domain_names = [d["domain"] for d in resp.json()["hydra:member"]]
        assert "newdomain.test" in domain_names

    def test_admin_add_domain_no_api_key(self, client):
        resp = client.post(
            "/admin/domains",
            json={"domain": "hack.test"},
        )
        assert resp.status_code == 403

    def test_admin_delete_domain(self, client):
        # Add then delete
        client.post(
            "/admin/domains",
            json={"domain": "temp.test"},
            headers={"X-API-Key": "test-api-key"},
        )
        resp = client.delete(
            "/admin/domains/temp.test",
            headers={"X-API-Key": "test-api-key"},
        )
        assert resp.status_code == 200


# ========== Accounts ==========

class TestAccounts:
    def test_create_account(self, client):
        resp = client.post("/accounts", json={
            "address": "newuser@test.local",
            "password": "password123",
        })
        assert resp.status_code == 201
        data = resp.json()
        assert data["address"] == "newuser@test.local"
        assert "id" in data

    def test_create_account_missing_fields(self, client):
        resp = client.post("/accounts", json={"address": "", "password": ""})
        assert resp.status_code == 422

    def test_create_account_invalid_domain(self, client):
        resp = client.post("/accounts", json={
            "address": "user@unknown-domain.xyz",
            "password": "pass123",
        })
        assert resp.status_code == 422

    def test_create_duplicate_account(self, client):
        client.post("/accounts", json={
            "address": "dup@test.local",
            "password": "pass1",
        })
        resp = client.post("/accounts", json={
            "address": "dup@test.local",
            "password": "pass2",
        })
        assert resp.status_code == 422


# ========== Token (Login) ==========

class TestToken:
    def test_login_success(self, client, test_account):
        address, password, _ = test_account
        resp = client.post("/token", json={
            "address": address,
            "password": password,
        })
        assert resp.status_code == 200
        assert "token" in resp.json()

    def test_login_wrong_password(self, client, test_account):
        address, _, _ = test_account
        resp = client.post("/token", json={
            "address": address,
            "password": "wrongpassword",
        })
        assert resp.status_code == 401

    def test_login_nonexistent_account(self, client):
        resp = client.post("/token", json={
            "address": "ghost@test.local",
            "password": "whatever",
        })
        assert resp.status_code == 401


# ========== Messages ==========

class TestMessages:
    def test_list_messages_empty(self, client, auth_header):
        resp = client.get("/messages", headers=auth_header)
        assert resp.status_code == 200
        data = resp.json()
        assert data["hydra:totalItems"] == 0
        assert data["hydra:member"] == []

    def test_list_messages_with_data(self, client, auth_header, sample_message):
        resp = client.get("/messages", headers=auth_header)
        assert resp.status_code == 200
        data = resp.json()
        assert data["hydra:totalItems"] == 1
        assert len(data["hydra:member"]) == 1
        msg = data["hydra:member"][0]
        assert msg["subject"] == "Test Subject"
        assert msg["from"]["name"] == "Test Sender"

    def test_list_messages_pagination(self, client, auth_header):
        resp = client.get("/messages?offset=0&limit=5", headers=auth_header)
        assert resp.status_code == 200
        assert resp.json()["limit"] == 5

    def test_list_messages_unauthorized(self, client):
        resp = client.get("/messages")
        assert resp.status_code == 401

    def test_get_message_detail(self, client, auth_header, sample_message):
        resp = client.get(f"/messages/{sample_message}", headers=auth_header)
        assert resp.status_code == 200
        data = resp.json()
        assert data["subject"] == "Test Subject"
        assert "html" in data

    def test_get_message_not_found(self, client, auth_header):
        resp = client.get("/messages/000000000000000000000000", headers=auth_header)
        assert resp.status_code == 404

    def test_delete_message(self, client, auth_header, sample_message):
        resp = client.delete(f"/messages/{sample_message}", headers=auth_header)
        assert resp.status_code == 200

        # Verify it's gone from listing
        resp = client.get("/messages", headers=auth_header)
        assert resp.json()["hydra:totalItems"] == 0

    def test_search_messages(self, client, auth_header, sample_message):
        resp = client.get("/messages/search?q=Test", headers=auth_header)
        assert resp.status_code == 200
        results = resp.json()
        members = results if isinstance(results, list) else results.get("hydra:member", [])
        assert len(members) >= 1

    def test_search_messages_matches_body_and_escapes_regex(self, client, auth_header, sample_message):
        resp = client.get("/messages/search", params={"q": "test email body."}, headers=auth_header)
        assert resp.status_code == 200
        assert len(resp.json()["hydra:member"]) == 1

        resp = client.get("/messages/search", params={"q": ".*"}, headers=auth_header)
        assert resp.status_code == 200
        assert resp.json()["hydra:member"] == []

    def test_trash_restore_and_permanent_delete(self, client, auth_header, sample_message):
        resp = client.delete(f"/messages/{sample_message}", headers=auth_header)
        assert resp.status_code == 200

        resp = client.get("/messages/trash", headers=auth_header)
        assert resp.status_code == 200
        assert resp.json()["hydra:totalItems"] == 1
        assert resp.json()["hydra:member"][0]["id"] == sample_message

        resp = client.post(f"/messages/{sample_message}/restore", headers=auth_header)
        assert resp.status_code == 200
        resp = client.get("/messages", headers=auth_header)
        assert resp.json()["hydra:totalItems"] == 1

        client.delete(f"/messages/{sample_message}", headers=auth_header)
        resp = client.delete(f"/messages/{sample_message}/permanent", headers=auth_header)
        assert resp.status_code == 200
        resp = client.get("/messages/trash", headers=auth_header)
        assert resp.json()["hydra:totalItems"] == 0

    def test_smtp_attachment_metadata_and_download(self, client, auth_header, test_account, mock_mongo):
        from app import MailHandler

        address = test_account[0]
        mail = EmailMessage()
        mail["From"] = "Sender <sender@external.com>"
        mail["To"] = address
        mail["Subject"] = "Attachment Test"
        mail.set_content("Body with attachment")
        mail.add_attachment(b"hello attachment", maintype="text", subtype="plain", filename="hello.txt")

        envelope = SimpleNamespace(
            content=mail.as_bytes(),
            rcpt_tos=[address],
            mail_from="sender@external.com",
        )
        session = SimpleNamespace(peer=("127.0.0.1", 25000), rcpt_count=1, mail_from="sender@external.com")
        status = asyncio.run(MailHandler().handle_DATA(None, session, envelope))
        assert status == "250 Message accepted for delivery"

        stored = mock_mongo.messages.find_one({"subject": "Attachment Test"})
        assert stored is not None
        assert stored["has_attachments"] is True
        assert stored["attachments"][0]["filename"] == "hello.txt"
        assert stored["attachments"][0]["content"] == b"hello attachment"

        message_id = str(stored["_id"])
        resp = client.get(f"/messages/{message_id}", headers=auth_header)
        assert resp.status_code == 200
        attachment = resp.json()["attachments"][0]
        assert attachment["filename"] == "hello.txt"
        assert "content" not in attachment

        resp = client.get(
            f"/messages/{message_id}/attachments/{attachment['id']}",
            headers=auth_header,
        )
        assert resp.status_code == 200
        assert resp.content == b"hello attachment"
        assert resp.headers["content-type"].startswith("text/plain")


# ========== Batch Operations ==========

class TestBatch:
    def test_batch_mark_read(self, client, auth_header, sample_message):
        resp = client.post("/messages/batch", json={
            "action": "mark_read",
            "ids": [sample_message],
        }, headers=auth_header)
        assert resp.status_code == 200

    def test_batch_delete(self, client, auth_header, sample_message):
        resp = client.post("/messages/batch", json={
            "action": "delete",
            "ids": [sample_message],
        }, headers=auth_header)
        assert resp.status_code == 200

    def test_batch_invalid_action(self, client, auth_header, sample_message):
        resp = client.post("/messages/batch", json={
            "action": "invalid",
            "ids": [sample_message],
        }, headers=auth_header)
        assert resp.status_code in (400, 422)


# ========== Sent Messages ==========

class TestSentMessages:
    def test_store_list_and_detail_sent_messages(self, client, auth_header, test_account):
        address = test_account[0]
        for i in range(3):
            resp = client.post("/admin/sent", json={
                "from_address": address,
                "to": ["recipient@example.com"],
                "subject": f"Sent {i}",
                "text": f"text {i}",
                "html": f"<p>html {i}</p>",
                "resend_id": f"resend-{i}",
            }, headers={"Authorization": "Bearer test-api-key"})
            assert resp.status_code == 201

        resp = client.get("/sent?offset=1&limit=1", headers=auth_header)
        assert resp.status_code == 200
        data = resp.json()
        assert data["hydra:totalItems"] == 3
        assert data["offset"] == 1
        assert data["limit"] == 1
        assert len(data["hydra:member"]) == 1

        sent_id = data["hydra:member"][0]["id"]
        resp = client.get(f"/sent/{sent_id}", headers=auth_header)
        assert resp.status_code == 200
        detail = resp.json()
        assert detail["id"] == sent_id
        assert detail["from_address"] == address
        assert "text" in detail
        assert "html" in detail


# ========== Auth Edge Cases ==========

class TestAuth:
    def test_expired_token(self, client):
        """Manually craft an expired token."""
        import jwt as pyjwt
        from datetime import datetime, timedelta, timezone

        expired = pyjwt.encode({
            "account_id": "fake",
            "address": "fake@test.local",
            "exp": datetime.now(timezone.utc) - timedelta(hours=1),
        }, "test-secret-key-for-ci", algorithm="HS256")

        resp = client.get("/messages", headers={"Authorization": f"Bearer {expired}"})
        assert resp.status_code == 401

    def test_invalid_token(self, client):
        resp = client.get("/messages", headers={"Authorization": "Bearer garbage.token.here"})
        assert resp.status_code == 401

    def test_missing_bearer(self, client):
        resp = client.get("/messages", headers={"Authorization": "Token abc"})
        assert resp.status_code == 401
