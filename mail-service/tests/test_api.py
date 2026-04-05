"""Tests for mail-service REST API endpoints."""

import pytest


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
        assert resp.status_code == 200
        assert resp.json()["success"] is True

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
        assert "@id" in data

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
        assert resp.status_code == 409


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
