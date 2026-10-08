import base64
import importlib.util
import sys
from pathlib import Path
from unittest.mock import Mock

import pytest

APP_DIR = Path(__file__).resolve().parents[1]
MODULE_NAME = "mail_viewer_app_under_test"


def load_app(monkeypatch, **env):
    defaults = {
        "ENVIRONMENT": "development",
        "SECRET_KEY": "test-secret-key",
        "ACCESS_PASSWORD": "viewer-pass",
        "DUCKMAIL_API_KEY": "test-api-key",
        "UNIFIED_PASSWORD": "mailbox-pass",
        "DUCKMAIL_BASE_URL": "http://mail-service.test",
        "IMAP_MAIL_BASE_URL": "http://imap-mail.test",
        "AUTO_CREATE_ACCOUNTS": "0",
        "RESEND_API_KEY": "",
        "LOGIN_RATE_LIMIT_MAX": "2",
        "LOGIN_RATE_LIMIT_WINDOW": "300",
        "SENSITIVE_RATE_LIMIT_MAX": "2",
        "SENSITIVE_RATE_LIMIT_WINDOW": "60",
    }
    defaults.update(env)
    for key, value in defaults.items():
        monkeypatch.setenv(key, value)

    sys.modules.pop(MODULE_NAME, None)
    spec = importlib.util.spec_from_file_location(MODULE_NAME, APP_DIR / "app.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[MODULE_NAME] = module
    spec.loader.exec_module(module)
    module.app.config.update(TESTING=True)
    return module


@pytest.fixture
def viewer(monkeypatch):
    module = load_app(monkeypatch)
    return module


@pytest.fixture
def client(viewer):
    with viewer.app.test_client() as test_client:
        yield test_client


def login(test_client):
    return test_client.post("/login", data={"password": "viewer-pass"})


def test_login_required_blocks_json(client):
    resp = client.post("/api/inbox/query", json={"email": "user@test.local"})
    assert resp.status_code == 401
    assert resp.get_json()["message"] == "未授权访问"


def test_login_uses_rate_limit(client):
    assert client.post("/login", data={"password": "bad"}).status_code == 200
    assert client.post("/login", data={"password": "bad"}).status_code == 200
    resp = client.post("/login", data={"password": "bad"})
    assert resp.status_code == 429


def test_image_proxy_rejects_private_address(client, viewer, monkeypatch):
    login(client)
    monkeypatch.setattr(viewer.socket, "getaddrinfo", lambda *args, **kwargs: [(None, None, None, None, ("127.0.0.1", 0))])
    resp = client.get("/api/image-proxy?url=http://internal.local/image.png")
    assert resp.status_code == 400


def test_sanitize_email_html_removes_script(viewer):
    html = viewer._sanitize_email_html('<div onclick="alert(1)"><script>alert(1)</script><b>ok</b></div>')
    assert "script" not in html.lower()
    assert "onclick" not in html.lower()
    assert "<b>ok</b>" in html


def test_inbox_query_does_not_auto_create_when_disabled(client, viewer, monkeypatch):
    login(client)
    post = Mock(return_value=Mock(status_code=401))
    monkeypatch.setattr(viewer.http_session, "post", post)

    resp = client.post("/api/inbox/query", json={"email": "new@test.local"})

    assert resp.status_code == 200
    assert resp.get_json()["success"] is False
    assert "自动创建已关闭" in resp.get_json()["message"]
    assert post.call_count == 1


def test_inbox_query_auto_create_enabled(monkeypatch):
    module = load_app(monkeypatch, AUTO_CREATE_ACCOUNTS="1")
    module.app.config.update(TESTING=True)
    with module.app.test_client() as test_client:
        login(test_client)
        token_resp_1 = Mock(status_code=401)
        create_resp = Mock(status_code=201)
        token_resp_2 = Mock(status_code=200)
        token_resp_2.json.return_value = {"token": "token-1"}
        module.http_session.post = Mock(side_effect=[token_resp_1, create_resp, token_resp_2])
        mail_resp = Mock(status_code=200)
        mail_resp.json.return_value = {"hydra:member": [], "hydra:totalItems": 0}
        module.http_session.get = Mock(return_value=mail_resp)

        resp = test_client.post("/api/inbox/query", json={"email": "new@test.local"})

    assert resp.status_code == 200
    assert resp.get_json()["success"] is True
    assert module.http_session.post.call_count == 3


def test_send_requires_resend_key(client):
    login(client)
    resp = client.post("/api/send", json={})
    assert resp.status_code == 200
    assert resp.get_json()["success"] is False
    assert "Resend" in resp.get_json()["message"]


def test_sanitize_email_html_moves_style_into_one_clean_block(viewer):
    html = (
        '<style>.a{color:red}</style><p class="a">one</p>'
        '<STYLE type="text/css">.b{color:blue}</STYLE><p class="b">two</p>'
    )
    cleaned = viewer._sanitize_email_html(html)
    # 两个 <style> 合并成一个，CSS 不再以正文形式出现
    assert cleaned.count("<style>") == 1
    assert cleaned.startswith("<style>")
    assert ".a{color:red}" in cleaned and ".b{color:blue}" in cleaned
    assert "one" in cleaned and "two" in cleaned


def test_sanitize_stylesheet_keeps_media_queries(viewer):
    css = "@media (prefers-color-scheme: dark) { .dark-img { display: block !important; } }"
    out = viewer._sanitize_stylesheet(css)
    assert "@media (prefers-color-scheme: dark)" in out
    assert "display:block !important" in out


def test_sanitize_stylesheet_blocks_external_fetches(viewer):
    css = (
        '@import url("https://evil.test/x.css");'
        '@font-face { font-family: X; src: url(https://evil.test/f.woff); }'
        '.tracker { background: url(https://evil.test/pixel.png); color: red; }'
        '.ok { color: green; }'
    )
    out = viewer._sanitize_stylesheet(css)
    assert "evil.test" not in out
    assert "@import" not in out and "@font-face" not in out
    # 同一条规则里 url() 的那句被丢掉，安全的声明保留
    assert "color:red" in out
    assert ".ok{color:green}" in out


def test_sanitize_stylesheet_drops_scripting_and_unknown_properties(viewer):
    css = '.a { width: expression(alert(1)); behavior: url(#x); position: fixed; color: red; }'
    out = viewer._sanitize_stylesheet(css)
    assert "expression" not in out and "behavior" not in out
    assert "position" not in out  # 不在白名单
    assert "color:red" in out


def test_sanitize_email_html_blocks_style_rawtext_escape(viewer):
    html = '<style>a{color:red}</style x>{color:red}</style><p>body</p>'
    cleaned = viewer._sanitize_email_html(html)
    assert "<img" not in cleaned
    assert "</style x>" not in cleaned
    # style 块里不能出现能提前闭合 rawtext 的 "<"
    style_block = cleaned.split("</style>")[0]
    assert "<" not in style_block[len("<style>"):]


def test_sanitize_email_html_still_drops_script_and_title(viewer):
    html = '<title>t</title><script>var leak = 1;</script><p>three</p><style>.c{color:green}'
    cleaned = viewer._sanitize_email_html(html)
    assert "var leak" not in cleaned
    assert "t</p>" not in cleaned and ">t<" not in cleaned
    assert "color:green" not in cleaned  # 未闭合的 <style> 整段丢弃
    assert "three" in cleaned


def test_sanitize_email_html_keeps_class_and_id_for_selectors(viewer):
    html = '<style>.hide{display:none}</style><div class="hide" id="pre">preheader</div>'
    cleaned = viewer._sanitize_email_html(html)
    # 没有 class 就没有匹配目标，放开 <style> 也白搭
    assert 'class="hide"' in cleaned
    assert 'id="pre"' in cleaned
    assert ".hide{display:none}" in cleaned


def test_sanitize_email_html_keeps_inline_styles(viewer):
    cleaned = viewer._sanitize_email_html('<p style="color: red;">kept</p>')
    assert "color" in cleaned
    assert "kept" in cleaned


def test_extract_code_finds_six_digits(viewer):
    assert viewer._extract_code("您的验证码是 123456，5 分钟内有效") == "123456"
    assert viewer._extract_code("Subject", "", "code: 987654") == "987654"


def test_extract_code_returns_none_without_match(viewer):
    assert viewer._extract_code("no digits here") is None
    assert viewer._extract_code("order 1234567 shipped") is None
    assert viewer._extract_code() is None


def test_inbox_detail_includes_extracted_code(client, viewer, monkeypatch):
    login(client)
    token_resp = Mock(status_code=200)
    token_resp.json.return_value = {"token": "token-1"}
    monkeypatch.setattr(viewer.http_session, "post", Mock(return_value=token_resp))
    detail_resp = Mock(status_code=200)
    detail_resp.json.return_value = {"subject": "Verify", "text": "your code is 246810", "html": ""}
    monkeypatch.setattr(viewer.http_session, "get", Mock(return_value=detail_resp))

    resp = client.post("/api/inbox/detail", json={"email": "a@test.local", "message_id": "m1"})

    assert resp.get_json()["detail"]["extracted_code"] == "246810"


def test_inbox_source_returns_404_when_upstream_missing(client, viewer, monkeypatch):
    login(client)
    token_resp = Mock(status_code=200)
    token_resp.json.return_value = {"token": "token-1"}
    monkeypatch.setattr(viewer.http_session, "post", Mock(return_value=token_resp))
    get = Mock(return_value=Mock(status_code=404))
    monkeypatch.setattr(viewer.http_session, "get", get)

    resp = client.get("/api/inbox/source/m1?email=a@test.local")

    assert resp.status_code == 404
    assert resp.get_json()["message"] == "邮件原文接口不可用"
    assert get.call_count == 3  # 三个候选路径都探测过


def test_send_rejects_oversized_attachment(monkeypatch):
    module = load_app(monkeypatch, RESEND_API_KEY="resend-key", MAX_ATTACHMENT_BYTES="16")
    module.app.config.update(TESTING=True)
    post = Mock()
    module.http_session.post = post
    with module.app.test_client() as test_client:
        login(test_client)
        oversized = base64.b64encode(b"x" * 64).decode()
        resp = test_client.post("/api/send", json={
            "from_email": "a@test.local",
            "to": "b@test.local",
            "subject": "hi",
            "text": "body",
            "attachments": [{"filename": "big.bin", "content": oversized}],
        })

    assert resp.get_json()["success"] is False
    assert "超过单个" in resp.get_json()["message"]
    post.assert_not_called()


def test_send_rejects_invalid_base64_attachment(monkeypatch):
    module = load_app(monkeypatch, RESEND_API_KEY="resend-key")
    module.app.config.update(TESTING=True)
    module.http_session.post = Mock()
    with module.app.test_client() as test_client:
        login(test_client)
        resp = test_client.post("/api/send", json={
            "from_email": "a@test.local",
            "to": "b@test.local",
            "subject": "hi",
            "text": "body",
            "attachments": [{"filename": "bad.bin", "content": "not-base64!!!"}],
        })

    assert resp.get_json()["success"] is False
    assert "编码不合法" in resp.get_json()["message"]


def test_send_forwards_attachments_to_resend(monkeypatch):
    module = load_app(monkeypatch, RESEND_API_KEY="resend-key")
    module.app.config.update(TESTING=True)
    send_resp = Mock(status_code=200)
    send_resp.json.return_value = {"id": "resend-1"}
    post = Mock(return_value=send_resp)
    module.http_session.post = post
    content = base64.b64encode(b"hello").decode()
    with module.app.test_client() as test_client:
        login(test_client)
        resp = test_client.post("/api/send", json={
            "from_email": "a@test.local",
            "to": "b@test.local",
            "subject": "hi",
            "text": "body",
            "attachments": [{"filename": "../../etc/passwd", "content": content}],
        })

    assert resp.get_json()["success"] is True
    payload = post.call_args_list[0].kwargs["json"]
    assert payload["attachments"] == [{"filename": "passwd", "content": content}]


def test_payload_too_large_returns_json(monkeypatch):
    module = load_app(monkeypatch, RESEND_API_KEY="resend-key", MAX_CONTENT_LENGTH="128")
    module.app.config.update(TESTING=True)
    with module.app.test_client() as test_client:
        login(test_client)
        resp = test_client.post("/api/send", json={"text": "x" * 500})

    assert resp.status_code == 413
    assert resp.get_json()["success"] is False


def test_domain_proxy_masks_internal_exception(client, viewer, monkeypatch):
    login(client)
    monkeypatch.setattr(viewer.http_session, "get", Mock(side_effect=RuntimeError("boom secret")))

    resp = client.get("/api/domains")

    assert resp.status_code == 502
    assert resp.get_json()["message"] == "获取域名失败"
