"""Per-domain Resend keys stored for the webmail (opaque ciphertext)."""

KEY = {"X-API-Key": "test-api-key"}


def test_requires_api_key(client):
    assert client.get("/admin/sender-keys").status_code == 403
    assert client.put("/admin/sender-keys/example.com", json={"ciphertext": "x"}).status_code == 403


def test_put_list_delete(client, mock_mongo):
    resp = client.put("/admin/sender-keys/Example.COM.", json={"ciphertext": "gAAAA-blob", "hint": "re_…1a2b"}, headers=KEY)
    assert resp.status_code == 200 and resp.json() == {"domain": "example.com"}
    client.put("/admin/sender-keys/example.com", json={"ciphertext": "gAAAA-new", "hint": "re_…9z9z"}, headers=KEY)

    keys = client.get("/admin/sender-keys", headers=KEY).json()["keys"]
    assert [(k["domain"], k["ciphertext"], k["hint"]) for k in keys] == [("example.com", "gAAAA-new", "re_…9z9z")]
    assert keys[0]["updated_at"]

    assert client.delete("/admin/sender-keys/example.com", headers=KEY).status_code == 200
    assert client.delete("/admin/sender-keys/example.com", headers=KEY).status_code == 404
    assert mock_mongo.sender_keys.count_documents({}) == 0


def test_validation(client):
    assert client.put("/admin/sender-keys/not_a_domain", json={"ciphertext": "x"}, headers=KEY).status_code == 400
    assert client.put("/admin/sender-keys/example.com", json={"hint": "x"}, headers=KEY).status_code == 400
    assert client.put("/admin/sender-keys/example.com", content=b"nope", headers=KEY).status_code == 400
