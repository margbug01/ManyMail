import base64
import binascii
import hmac
import ipaddress
import os
import re
import socket
import time
from collections import defaultdict
from functools import wraps

import requests
import bleach
from bleach.css_sanitizer import CSSSanitizer
from urllib.parse import urlparse, urljoin, quote
from flask import Flask, render_template, jsonify, request, session, redirect, url_for, Response, stream_with_context

app = Flask(__name__)
app.secret_key = os.getenv("SECRET_KEY", "mail-viewer-secret-key-change-me")
ENVIRONMENT = os.getenv("ENVIRONMENT", "development").strip().lower()
IS_PRODUCTION = ENVIRONMENT == "production"
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=IS_PRODUCTION,
)

if app.secret_key == "mail-viewer-secret-key-change-me":
    import warnings
    warnings.warn("⚠️ SECRET_KEY is using default value! Set it via environment variable in production!")

# 访问密码（从环境变量读取）
ACCESS_PASSWORD = os.getenv("ACCESS_PASSWORD", "")

# DuckMail API 配置
DUCKMAIL_BASE_URL = os.getenv("DUCKMAIL_BASE_URL", "http://161.33.195.3:8080")
DUCKMAIL_API_KEY = os.getenv("DUCKMAIL_API_KEY", "")
UNIFIED_PASSWORD = os.getenv("UNIFIED_PASSWORD", "openai123456")
IMAP_MAIL_BASE_URL = os.getenv("IMAP_MAIL_BASE_URL", "http://imap-mail:3939")

# Resend 发信配置
RESEND_API_KEY = os.getenv("RESEND_API_KEY", "")
MAX_IMAGE_PROXY_BYTES = int(os.getenv("MAX_IMAGE_PROXY_BYTES", str(5 * 1024 * 1024)))

# 发信附件限制（base64 前的原始字节数）
MAX_ATTACHMENT_BYTES = int(os.getenv("MAX_ATTACHMENT_BYTES", str(5 * 1024 * 1024)))
MAX_ATTACHMENT_TOTAL_BYTES = int(os.getenv("MAX_ATTACHMENT_TOTAL_BYTES", str(10 * 1024 * 1024)))
MAX_ATTACHMENT_COUNT = int(os.getenv("MAX_ATTACHMENT_COUNT", "10"))
# base64 膨胀约 4/3，再留出正文与其它字段的余量
app.config["MAX_CONTENT_LENGTH"] = int(
    os.getenv("MAX_CONTENT_LENGTH", str(MAX_ATTACHMENT_TOTAL_BYTES * 4 // 3 + 2 * 1024 * 1024))
)


def _env_flag(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


AUTO_CREATE_ACCOUNTS = _env_flag("AUTO_CREATE_ACCOUNTS", default=not IS_PRODUCTION)
LOGIN_RATE_LIMIT_WINDOW = int(os.getenv("LOGIN_RATE_LIMIT_WINDOW", "300"))
LOGIN_RATE_LIMIT_MAX = int(os.getenv("LOGIN_RATE_LIMIT_MAX", "10"))
SENSITIVE_RATE_LIMIT_WINDOW = int(os.getenv("SENSITIVE_RATE_LIMIT_WINDOW", "60"))
SENSITIVE_RATE_LIMIT_MAX = int(os.getenv("SENSITIVE_RATE_LIMIT_MAX", "20"))
_rate_limit_store: dict[str, list[float]] = defaultdict(list)

_EMAIL_ALLOWED_TAGS = [
    "a", "abbr", "b", "blockquote", "br", "code", "div", "em", "font",
    "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "li", "ol",
    "p", "pre", "span", "strong", "table", "tbody", "td", "th", "thead",
    "tr", "u", "ul",
]
_EMAIL_ALLOWED_ATTRIBUTES = {
    # class/id 是惰性属性，不带 URL 也不带脚本；
    # 放开 <style> 后没有它们，选择器就没有匹配目标
    "*": ["align", "valign", "class", "id"],
    "a": ["href", "title", "target", "rel", "style"],
    "div": ["style"],
    "font": ["color", "size", "face"],
    "img": ["src", "alt", "title", "width", "height", "style"],
    "p": ["style"],
    "span": ["style"],
    "table": ["border", "cellpadding", "cellspacing", "width", "style"],
    "tbody": ["style"],
    "thead": ["style"],
    "tr": ["style"],
    "td": ["colspan", "rowspan", "width", "height", "style"],
    "th": ["colspan", "rowspan", "width", "height", "style"],
}
_EMAIL_ALLOWED_CSS_PROPERTIES = [
    "background", "background-color", "border", "border-bottom", "border-collapse",
    "border-left", "border-radius", "border-right", "border-spacing", "border-top",
    "clear", "color", "display", "float", "font", "font-family", "font-size",
    "font-style", "font-weight", "height", "letter-spacing", "line-height",
    "list-style", "margin", "margin-bottom", "margin-left", "margin-right",
    "margin-top", "max-height", "max-width", "min-height", "min-width", "opacity",
    "overflow", "padding", "padding-bottom", "padding-left", "padding-right",
    "padding-top", "text-align", "text-decoration", "text-transform",
    "vertical-align", "visibility", "white-space", "width", "word-break",
]
_EMAIL_CSS_SANITIZER = CSSSanitizer(allowed_css_properties=_EMAIL_ALLOWED_CSS_PROPERTIES)


def _require_production_value(name: str, value: str, disallowed: set[str] | None = None):
    if not IS_PRODUCTION:
        return
    disallowed = disallowed or set()
    normalized = (value or "").strip()
    if not normalized or normalized in disallowed:
        raise RuntimeError(f"{name} must be configured for production")


_require_production_value("SECRET_KEY", app.secret_key, {"mail-viewer-secret-key-change-me"})
_require_production_value("ACCESS_PASSWORD", ACCESS_PASSWORD)
_require_production_value("DUCKMAIL_API_KEY", DUCKMAIL_API_KEY)
_require_production_value("UNIFIED_PASSWORD", UNIFIED_PASSWORD)
_require_production_value("IMAP_MAIL_BASE_URL", IMAP_MAIL_BASE_URL)


def _client_ip() -> str:
    forwarded_for = request.headers.get("X-Forwarded-For", "").split(",", 1)[0].strip()
    return forwarded_for or request.remote_addr or "unknown"


def _check_viewer_rate_limit(scope: str, window_seconds: int, max_attempts: int) -> bool:
    if max_attempts <= 0:
        return False
    now = time.time()
    key = f"{scope}:{_client_ip()}"
    bucket = [t for t in _rate_limit_store[key] if now - t < window_seconds]
    if len(bucket) >= max_attempts:
        _rate_limit_store[key] = bucket
        return True
    bucket.append(now)
    _rate_limit_store[key] = bucket
    return False


def _rate_limited_json(message: str = "操作过于频繁，请稍后再试"):
    return jsonify({"success": False, "message": message}), 429


def login_required(f):
    """登录验证装饰器"""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if ACCESS_PASSWORD and not session.get("authenticated"):
            if request.is_json:
                return jsonify({"success": False, "message": "未授权访问"}), 401
            return redirect(url_for("login_page"))
        return f(*args, **kwargs)
    return decorated_function

# 创建带重试的 HTTP session
http_session = requests.Session()
adapter = requests.adapters.HTTPAdapter(max_retries=3)
http_session.mount("http://", adapter)
http_session.mount("https://", adapter)


def _normalize_remote_url(url: str) -> str:
    url = (url or "").strip()
    if url.startswith("//"):
        return f"https:{url}"
    return url


def _is_public_hostname(hostname: str) -> bool:
    if not hostname:
        return False
    try:
        addr_infos = socket.getaddrinfo(hostname, None)
    except socket.gaierror:
        return False

    has_public_ip = False
    for _, _, _, _, sockaddr in addr_infos:
        try:
            ip = ipaddress.ip_address(sockaddr[0])
        except ValueError:
            return False
        if any([
            ip.is_private,
            ip.is_loopback,
            ip.is_link_local,
            ip.is_multicast,
            ip.is_reserved,
            ip.is_unspecified,
        ]):
            return False
        has_public_ip = True
    return has_public_ip


def _is_proxyable_image_url(url: str) -> bool:
    parsed = urlparse(_normalize_remote_url(url))
    return parsed.scheme in {"http", "https"} and _is_public_hostname(parsed.hostname or "")


# bleach 的 strip=True 会删掉不允许的标签但保留标签内的文字，
# 于是 <script> / <title> 里的源码会被当成正文显示出来。
# 这几类元素的内容永远不该出现在正文里，先整段删掉再交给 bleach。
# <style> 单独处理：内容过一遍白名单后重新拼回去（见 _extract_stylesheets）。
_RAW_TEXT_ELEMENT_RE = re.compile(
    r"<(script|title)\b[^>]*>.*?</\1\s*>",
    flags=re.IGNORECASE | re.DOTALL,
)
# 没有闭合标签的情况：后面的内容全是该元素的原始文本，一并丢弃
_UNCLOSED_RAW_TEXT_ELEMENT_RE = re.compile(
    r"<(style|script)\b[^>]*>(?:(?!</\1\s*>).)*$",
    flags=re.IGNORECASE | re.DOTALL,
)
_STYLE_ELEMENT_RE = re.compile(
    r"<style\b[^>]*>(.*?)</style\s*>",
    flags=re.IGNORECASE | re.DOTALL,
)

_CSS_COMMENT_RE = re.compile(r"/\*.*?\*/", flags=re.DOTALL)
# url() 会让 CSS 直接对外发请求（追踪像素、字体），一律挡掉；其余是脚本执行面
_CSS_FORBIDDEN_RE = re.compile(
    r"url\s*\(|image-set\s*\(|expression\s*\(|javascript\s*:|vbscript\s*:|behavior\s*:|-moz-binding",
    flags=re.IGNORECASE,
)
# 只放行这两种条件规则；@import / @font-face / @charset 之类都会拉外部资源
_CSS_ALLOWED_AT_RULES = {"media", "supports"}
_CSS_AT_RULE_NAME_RE = re.compile(r"@([a-zA-Z-]+)")
_MAX_STYLESHEET_BYTES = 200 * 1024


def _drop_raw_text_elements(html: str) -> str:
    previous = None
    # 嵌套或拼接出来的标签需要反复清理，直到没有匹配为止
    while previous != html:
        previous = html
        html = _RAW_TEXT_ELEMENT_RE.sub("", html)
    return _UNCLOSED_RAW_TEXT_ELEMENT_RE.sub("", html)


def _sanitize_css_declarations(body: str) -> str:
    kept = []
    for declaration in body.split(";"):
        prop, sep, value = declaration.partition(":")
        if not sep:
            continue
        prop = prop.strip().lower()
        value = value.strip()
        if not prop or not value:
            continue
        if prop not in _EMAIL_ALLOWED_CSS_PROPERTIES:
            continue
        if _CSS_FORBIDDEN_RE.search(value) or "<" in value:
            continue
        kept.append(f"{prop}:{value}")
    return ";".join(kept)


def _sanitize_stylesheet(css: str, depth: int = 0) -> str:
    """按白名单重写 <style> 里的 CSS：保留选择器与 @media，丢掉外链和未知属性。"""
    if depth > 4:
        return ""
    css = _CSS_COMMENT_RE.sub("", css)
    rules = []
    prelude = []
    index = 0
    length = len(css)
    while index < length:
        char = css[index]
        if char == "{":
            level = 1
            cursor = index + 1
            while cursor < length and level:
                if css[cursor] == "{":
                    level += 1
                elif css[cursor] == "}":
                    level -= 1
                cursor += 1
            block = css[index + 1:cursor - 1]
            selector = "".join(prelude).strip()
            prelude = []
            index = cursor
            # 选择器里带 "<" 说明有人在拼 </style> 想跳出 rawtext，直接丢
            if not selector or "<" in selector:
                continue
            if selector.startswith("@"):
                match = _CSS_AT_RULE_NAME_RE.match(selector)
                if not match or match.group(1).lower() not in _CSS_ALLOWED_AT_RULES:
                    continue
                if _CSS_FORBIDDEN_RE.search(selector):
                    continue
                inner = _sanitize_stylesheet(block, depth + 1)
                if inner:
                    rules.append(f"{selector}{{{inner}}}")
            else:
                if _CSS_FORBIDDEN_RE.search(selector):
                    continue
                declarations = _sanitize_css_declarations(block)
                if declarations:
                    rules.append(f"{selector}{{{declarations}}}")
        elif char == ";":
            # 无块的 at 规则（@import/@charset/@namespace）与游离分号，一并丢弃
            prelude = []
            index += 1
        else:
            prelude.append(char)
            index += 1
    return "".join(rules)


def _extract_stylesheets(html: str) -> tuple[str, str]:
    """摘出所有 <style> 块并清洗，返回 (去掉 style 的 html, 清洗后的 CSS)。"""
    collected = []

    def _collect(match):
        collected.append(match.group(1))
        return ""

    html = _STYLE_ELEMENT_RE.sub(_collect, html)
    if not collected:
        return html, ""
    raw = "\n".join(collected)[:_MAX_STYLESHEET_BYTES]
    return html, _sanitize_stylesheet(raw)


def _sanitize_email_html(html: str) -> str:
    html = (html or "").strip()
    if not html:
        return ""
    # 先摘样式表：<style> 可能在 <head> 里，抠 body 之前处理
    html, stylesheet = _extract_stylesheets(html)
    body_match = re.search(r"<body[^>]*>(.*)</body>", html, flags=re.IGNORECASE | re.DOTALL)
    if body_match:
        html = body_match.group(1)
    html = _drop_raw_text_elements(html)
    cleaned = bleach.clean(
        html,
        tags=_EMAIL_ALLOWED_TAGS,
        attributes=_EMAIL_ALLOWED_ATTRIBUTES,
        protocols={"http", "https", "mailto", "cid", "data"},
        strip=True,
        css_sanitizer=_EMAIL_CSS_SANITIZER,
    ).strip()
    if stylesheet:
        cleaned = f"<style>{stylesheet}</style>{cleaned}"
    return cleaned


def _prepare_html_for_render(html: str) -> str:
    return _rewrite_html_images(_sanitize_email_html(html))


def _rewrite_imap_html(html: str) -> str:
    rewritten = html.replace("'/api/", "'/imap/api/").replace('"/api/', '"/imap/api/')
    rewritten = rewritten.replace("fetch(url, opts)", "fetch(url, opts)")
    return rewritten


def _proxy_imap_response(subpath: str = ""):
    target = urljoin(IMAP_MAIL_BASE_URL.rstrip("/") + "/", subpath.lstrip("/"))
    headers = {}
    for key, value in request.headers.items():
        key_lower = key.lower()
        if key_lower in {"host", "content-length", "cookie"}:
            continue
        if key_lower in {"accept", "content-type", "x-requested-with"}:
            headers[key] = value
    body = None if request.method in {"GET", "HEAD"} else request.get_data()
    resp = http_session.request(
        method=request.method,
        url=target,
        params=request.args,
        data=body,
        headers=headers,
        timeout=60,
        allow_redirects=False,
    )
    content_type = resp.headers.get("Content-Type", "")
    payload = resp.content
    if "text/html" in content_type:
        payload = _rewrite_imap_html(resp.text).encode(resp.encoding or "utf-8")
    proxied = Response(payload, status=resp.status_code, content_type=content_type or None)
    for header in ["Content-Disposition", "Cache-Control", "Location"]:
        if header in resp.headers:
            value = resp.headers[header]
            if header == "Location" and value.startswith("/"):
                value = "/imap" + value
            proxied.headers[header] = value
    return proxied


def _rewrite_html_images(html: str) -> str:
    if not html or "<img" not in html.lower():
        return html

    def _replace(match):
        prefix, src, suffix = match.groups()
        normalized = _normalize_remote_url(src)
        if not _is_proxyable_image_url(normalized):
            return match.group(0)
        proxied = url_for("image_proxy", url=normalized)
        return f"{prefix}{proxied}{suffix}"

    return re.sub(r'(<img\b[^>]*?\bsrc=["\'])([^"\']+)(["\'])', _replace, html, flags=re.IGNORECASE)


def _get_mail_token(email: str, password: str = "") -> tuple:
    """获取邮件服务 Token，返回 (token, error_response)"""
    password = password or UNIFIED_PASSWORD
    base_url = DUCKMAIL_BASE_URL.rstrip("/")
    try:
        token_resp = http_session.post(
            f"{base_url}/token",
            json={"address": email, "password": password},
            headers={"Content-Type": "application/json"},
            timeout=30
        )
        if token_resp.status_code != 200:
            return None, ("登录失败", token_resp.status_code)
        token = token_resp.json().get("token")
        return token, None
    except Exception as e:
        app.logger.error(f"获取 mail token 失败: {e}", exc_info=True)
        return None, ("连接邮件服务失败", 500)


def _extract_api_error(resp, fallback: str = "操作失败") -> str:
    try:
        data = resp.json()
        if isinstance(data, dict):
            return data.get("detail") or data.get("message") or data.get("hydra:description") or fallback
    except Exception:
        pass
    return fallback


_CODE_PATTERN = re.compile(r"\b(\d{6})\b")


def _extract_code(*parts: str) -> str | None:
    """从若干文本片段里提取 6 位验证码，取第一个命中。"""
    text = " ".join(p for p in parts if p)
    match = _CODE_PATTERN.search(text)
    return match.group(1) if match else None


def _format_attachments(detail: dict) -> list:
    attachments = detail.get("attachments") or []
    if not isinstance(attachments, list):
        attachments = []
    if not attachments and detail.get("hasAttachments"):
        attachments = [{"index": 0, "filename": "attachment", "size": 0}]
    normalized = []
    for index, item in enumerate(attachments):
        if isinstance(item, dict):
            normalized.append({
                "index": item.get("index", index),
                "id": item.get("id") or item.get("attachment_id") or item.get("contentId") or "",
                "filename": item.get("filename") or item.get("name") or f"attachment_{index}",
                "size": item.get("size") or 0,
                "contentType": item.get("contentType") or item.get("content_type") or "",
            })
        else:
            normalized.append({"index": index, "id": "", "filename": str(item), "size": 0, "contentType": ""})
    return normalized


def _find_attachment_download_url(base_url: str, message_id: str, attachment_id: str, headers: dict):
    quoted_id = quote(attachment_id, safe="")
    candidate_paths = [
        f"/messages/{message_id}/attachments/{quoted_id}",
        f"/messages/{message_id}/attachment/{quoted_id}",
        f"/messages/{message_id}/attachments?index={quoted_id}",
    ]

    for path in candidate_paths:
        url = f"{base_url}{path}"
        try:
            resp = http_session.get(url, headers=headers, stream=True, timeout=30)
        except Exception:
            continue
        if resp.status_code == 200:
            return url, resp
        resp.close()
    return None, None


def _find_message_source_url(base_url: str, message_id: str, headers: dict):
    """探测上游的邮件原文（.eml）接口，不同实现路径不一致。"""
    quoted_id = quote(message_id, safe="")
    candidate_paths = [
        f"/messages/{quoted_id}/download",
        f"/messages/{quoted_id}/source",
        f"/sources/{quoted_id}",
    ]

    for path in candidate_paths:
        url = f"{base_url}{path}"
        try:
            resp = http_session.get(url, headers=headers, stream=True, timeout=30)
        except Exception:
            continue
        if resp.status_code == 200:
            return url, resp
        resp.close()
    return None, None


@app.errorhandler(413)
def _payload_too_large(_e):
    """请求体超过 MAX_CONTENT_LENGTH 时也返回 JSON，前端统一按 JSON 解析。"""
    return jsonify({"success": False, "message": "请求内容过大，请减小附件体积"}), 413


@app.route("/login", methods=["GET", "POST"])
def login_page():
    """登录页面"""
    if not ACCESS_PASSWORD:
        app.logger.warning("ACCESS_PASSWORD is empty; viewer login is disabled")
        return redirect(url_for("index"))

    if request.method == "POST":
        if _check_viewer_rate_limit("login", LOGIN_RATE_LIMIT_WINDOW, LOGIN_RATE_LIMIT_MAX):
            return render_template("login.html", error="登录尝试过于频繁，请稍后再试"), 429
        password = request.form.get("password", "")
        if hmac.compare_digest(password, ACCESS_PASSWORD):
            session["authenticated"] = True
            return redirect(url_for("index"))
        return render_template("login.html", error="密码错误")

    return render_template("login.html", error=None)


@app.route("/logout")
def logout():
    session.pop("authenticated", None)
    return redirect(url_for("login_page"))


@app.route("/")
@login_required
def index():
    return render_template("index.html")


@app.route("/imap")
@login_required
def imap_root():
    return redirect("/imap/")


@app.route("/imap/", defaults={"subpath": ""}, methods=["GET", "POST", "DELETE", "PUT", "PATCH"])
@app.route("/imap/<path:subpath>", methods=["GET", "POST", "DELETE", "PUT", "PATCH"])
@login_required
def imap_proxy(subpath: str):
    return _proxy_imap_response(subpath)


@app.route("/api/image-proxy")
@login_required
def image_proxy():
    """服务端代理远程图片，避免客户端地区/网络限制导致邮件图片加载失败。"""
    source_url = _normalize_remote_url(request.args.get("url", ""))
    if not _is_proxyable_image_url(source_url):
        return jsonify({"success": False, "message": "非法图片地址"}), 400

    try:
        resp = http_session.get(
            source_url,
            timeout=30,
            stream=True,
            allow_redirects=True,
            headers={
                "User-Agent": "Mozilla/5.0 mail-viewer-image-proxy",
                "Accept": "image/*,*/*;q=0.8",
            },
        )
    except requests.RequestException as e:
        app.logger.error(f"图片代理请求失败: {e}", exc_info=True)
        return jsonify({"success": False, "message": "图片加载失败"}), 502

    final_url = _normalize_remote_url(resp.url)
    if not resp.ok or not _is_proxyable_image_url(final_url):
        resp.close()
        return jsonify({"success": False, "message": "图片加载失败"}), 502

    content_type = resp.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
    if not content_type.startswith("image/"):
        resp.close()
        return jsonify({"success": False, "message": "远程资源不是图片"}), 415

    content_length = resp.headers.get("Content-Length")
    if content_length and int(content_length) > MAX_IMAGE_PROXY_BYTES:
        resp.close()
        return jsonify({"success": False, "message": "图片过大"}), 413

    chunks = []
    total = 0
    try:
        for chunk in resp.iter_content(65536):
            if not chunk:
                continue
            total += len(chunk)
            if total > MAX_IMAGE_PROXY_BYTES:
                return jsonify({"success": False, "message": "图片过大"}), 413
            chunks.append(chunk)
    finally:
        resp.close()

    proxied_resp = Response(b"".join(chunks), mimetype=content_type)
    proxied_resp.headers["Cache-Control"] = "public, max-age=3600"
    return proxied_resp


@app.route("/api/inbox/query", methods=["POST"])
@login_required
def inbox_query():
    """通用收件箱查询 - 自动创建邮箱（如不存在）"""
    data = request.json or {}
    email = data.get("email", "").strip()
    password = data.get("password", "").strip() or UNIFIED_PASSWORD
    offset = int(data.get("offset", 0))
    limit = int(data.get("limit", 30))

    if not email:
        return jsonify({"success": False, "message": "请输入邮箱", "messages": []})

    base_url = DUCKMAIL_BASE_URL.rstrip("/")

    try:
        # 尝试登录获取 Token
        token_resp = http_session.post(
            f"{base_url}/token",
            json={"address": email, "password": password},
            headers={"Content-Type": "application/json"},
            timeout=30
        )

        # 如果登录失败（邮箱不存在），按配置决定是否自动创建
        if token_resp.status_code != 200:
            if not AUTO_CREATE_ACCOUNTS:
                return jsonify({"success": False, "message": "邮箱不存在或密码错误，自动创建已关闭", "messages": []})
            if _check_viewer_rate_limit("auto_create_account", SENSITIVE_RATE_LIMIT_WINDOW, SENSITIVE_RATE_LIMIT_MAX):
                return _rate_limited_json()
            if not DUCKMAIL_API_KEY:
                return jsonify({"success": False, "message": "邮箱不存在且未配置 API Key，无法自动创建", "messages": []})

            create_headers = {
                "Authorization": f"Bearer {DUCKMAIL_API_KEY}",
                "Content-Type": "application/json",
            }
            create_resp = http_session.post(
                f"{base_url}/accounts",
                json={"address": email, "password": password},
                headers=create_headers,
                timeout=30
            )

            if create_resp.status_code not in [200, 201]:
                error_msg = "邮箱创建失败"
                try:
                    error_data = create_resp.json()
                    if "violations" in error_data:
                        error_msg = error_data["violations"][0].get("message", error_msg)
                    elif "hydra:description" in error_data:
                        error_msg = error_data["hydra:description"]
                except Exception:
                    pass
                return jsonify({"success": False, "message": error_msg, "messages": []})

            # 创建成功后重新登录
            token_resp = http_session.post(
                f"{base_url}/token",
                json={"address": email, "password": password},
                headers={"Content-Type": "application/json"},
                timeout=30
            )

            if token_resp.status_code != 200:
                return jsonify({"success": False, "message": "登录失败", "messages": []})

        token = token_resp.json().get("token")

        # 获取邮件列表（带分页参数）
        mail_resp = http_session.get(
            f"{base_url}/messages",
            params={"offset": offset, "limit": limit},
            headers={"Authorization": f"Bearer {token}"},
            timeout=30
        )

        if mail_resp.status_code != 200:
            return jsonify({"success": False, "message": "获取邮件失败", "messages": []})

        resp_data = mail_resp.json()
        messages = resp_data.get("hydra:member", []) if isinstance(resp_data, dict) else resp_data
        total = resp_data.get("hydra:totalItems", len(messages)) if isinstance(resp_data, dict) else len(messages)

        # 过滤：只保留发给当前查询邮箱的邮件（DuckMail 会返回同前缀所有域名的邮件）
        filtered = []
        for msg in messages:
            to_list = msg.get("to", [])
            if any(r.get("address", "").lower() == email.lower() for r in to_list):
                filtered.append(msg)
        messages = filtered

        # 为每封邮件提取验证码
        for msg in messages:
            msg["extracted_code"] = _extract_code(msg.get("subject", ""), msg.get("intro", ""))

        return jsonify({
            "success": True,
            "messages": messages,
            "total": total,
            "offset": offset,
            "limit": limit,
        })

    except Exception as e:
        app.logger.error(f"收件箱查询失败: {e}", exc_info=True)
        return jsonify({"success": False, "message": "服务内部错误，请稍后重试", "messages": []})


# ---- 域名管理 API（代理到 mail-server /admin/domains） ----

@app.route("/api/domains", methods=["GET"])
@login_required
def list_domains():
    """获取域名列表"""
    base_url = DUCKMAIL_BASE_URL.rstrip("/")
    try:
        resp = http_session.get(
            f"{base_url}/domains",
            timeout=30,
        )
        if resp.status_code != 200:
            return jsonify({"success": False, "message": f"获取域名失败: {resp.status_code}"}), resp.status_code
        payload = resp.json()
        domains = payload.get("hydra:member", []) if isinstance(payload, dict) else []
        normalized = [
            {
                "domain": item.get("domain", ""),
                "is_active": item.get("isActive", True),
            }
            for item in domains
        ]
        return jsonify({"success": True, "domains": normalized})
    except Exception as e:
        app.logger.error(f"获取域名列表失败: {e}", exc_info=True)
        return jsonify({"success": False, "message": "获取域名失败"}), 502


@app.route("/api/domains", methods=["POST"])
@login_required
def add_domain():
    """添加新域名"""
    data = request.json or {}
    domain = data.get("domain", "").strip().lower()
    if not domain:
        return jsonify({"success": False, "message": "域名不能为空"})
    if _check_viewer_rate_limit("domain_admin", SENSITIVE_RATE_LIMIT_WINDOW, SENSITIVE_RATE_LIMIT_MAX):
        return _rate_limited_json()
    if not DUCKMAIL_API_KEY:
        return jsonify({"success": False, "message": "未配置 API Key，无法管理域名"}), 503

    base_url = DUCKMAIL_BASE_URL.rstrip("/")
    try:
        resp = http_session.post(
            f"{base_url}/admin/domains",
            json={"domain": domain},
            headers={
                "Authorization": f"Bearer {DUCKMAIL_API_KEY}",
                "Content-Type": "application/json",
            },
            timeout=30,
        )
        if resp.status_code in (200, 201):
            return jsonify({"success": True, **resp.json()})
        else:
            detail = resp.json().get("detail", "添加失败") if resp.headers.get("content-type", "").startswith("application/json") else "添加失败"
            return jsonify({"success": False, "message": detail}), resp.status_code
    except Exception as e:
        app.logger.error(f"添加域名失败: {e}", exc_info=True)
        return jsonify({"success": False, "message": "添加域名失败"}), 502


@app.route("/api/domains/<domain>", methods=["DELETE"])
@login_required
def delete_domain(domain):
    """删除（停用）域名"""
    if _check_viewer_rate_limit("domain_admin", SENSITIVE_RATE_LIMIT_WINDOW, SENSITIVE_RATE_LIMIT_MAX):
        return _rate_limited_json()
    if not DUCKMAIL_API_KEY:
        return jsonify({"success": False, "message": "未配置 API Key，无法管理域名"}), 503

    base_url = DUCKMAIL_BASE_URL.rstrip("/")
    try:
        resp = http_session.delete(
            f"{base_url}/admin/domains/{domain}",
            headers={"Authorization": f"Bearer {DUCKMAIL_API_KEY}"},
            timeout=30,
        )
        if resp.status_code == 200:
            return jsonify({"success": True, **resp.json()})
        else:
            detail = resp.json().get("detail", "删除失败") if resp.headers.get("content-type", "").startswith("application/json") else "删除失败"
            return jsonify({"success": False, "message": detail}), resp.status_code
    except Exception as e:
        app.logger.error(f"删除域名失败: {e}", exc_info=True)
        return jsonify({"success": False, "message": "删除域名失败"}), 502


@app.route("/api/inbox/detail", methods=["POST"])
@login_required
def inbox_detail():
    """通用收件箱邮件详情"""
    data = request.json or {}
    email = data.get("email", "").strip()
    password = data.get("password", "").strip() or UNIFIED_PASSWORD
    message_id = data.get("message_id", "").strip()

    if not email or not message_id:
        return jsonify({"success": False, "message": "缺少必要参数"})

    base_url = DUCKMAIL_BASE_URL.rstrip("/")

    try:
        token, err = _get_mail_token(email, password)
        if err:
            return jsonify({"success": False, "message": err[0]})

        detail_resp = http_session.get(
            f"{base_url}/messages/{message_id}",
            headers={"Authorization": f"Bearer {token}"},
            timeout=30
        )

        if detail_resp.status_code != 200:
            return jsonify({"success": False, "message": "获取邮件详情失败"})

        detail = detail_resp.json()
        if isinstance(detail, dict):
            detail["html"] = _prepare_html_for_render(detail.get("html", ""))
            detail["attachments"] = _format_attachments(detail)
            # 详情能拿到正文，提取范围比列表的 subject + intro 更全
            detail["extracted_code"] = _extract_code(
                detail.get("subject", ""), detail.get("intro", ""), detail.get("text", "")
            )
        return jsonify({"success": True, "detail": detail})

    except Exception as e:
        app.logger.error(f"获取邮件详情失败: {e}", exc_info=True)
        return jsonify({"success": False, "message": "服务内部错误，请稍后重试"})


@app.route("/api/inbox/attachment/<message_id>/<attachment_id>")
@login_required
def inbox_attachment(message_id, attachment_id):
    """代理下载本地收件附件。"""
    email = request.args.get("email", "").strip()
    password = request.args.get("password", "").strip() or UNIFIED_PASSWORD
    if not email:
        return jsonify({"success": False, "message": "缺少邮箱参数"}), 400

    base_url = DUCKMAIL_BASE_URL.rstrip("/")
    token, err = _get_mail_token(email, password)
    if err:
        return jsonify({"success": False, "message": err[0]}), err[1]

    headers = {"Authorization": f"Bearer {token}"}
    url, download_resp = _find_attachment_download_url(base_url, message_id, attachment_id, headers)
    if not download_resp:
        return jsonify({"success": False, "message": "附件下载接口不可用"}), 404

    try:
        filename = request.args.get("filename", "attachment")
        content_type = download_resp.headers.get("Content-Type", "application/octet-stream")
        proxied = Response(stream_with_context(download_resp.iter_content(65536)), content_type=content_type)
        proxied.headers["Content-Disposition"] = f"attachment; filename*=UTF-8''{quote(filename)}"
        if "Content-Length" in download_resp.headers:
            proxied.headers["Content-Length"] = download_resp.headers["Content-Length"]
        return proxied
    except Exception as e:
        app.logger.error(f"附件下载失败: {e}", exc_info=True)
        return jsonify({"success": False, "message": "附件下载失败"}), 502


@app.route("/api/inbox/source/<message_id>")
@login_required
def inbox_source(message_id):
    """代理下载邮件原文（.eml）。上游未提供该接口时返回 404。"""
    email = request.args.get("email", "").strip()
    password = request.args.get("password", "").strip() or UNIFIED_PASSWORD
    if not email:
        return jsonify({"success": False, "message": "缺少邮箱参数"}), 400

    base_url = DUCKMAIL_BASE_URL.rstrip("/")
    token, err = _get_mail_token(email, password)
    if err:
        return jsonify({"success": False, "message": err[0]}), err[1]

    headers = {"Authorization": f"Bearer {token}"}
    url, source_resp = _find_message_source_url(base_url, message_id, headers)
    if not source_resp:
        return jsonify({"success": False, "message": "邮件原文接口不可用"}), 404

    try:
        filename = request.args.get("filename", "").strip() or f"{message_id}.eml"
        if not filename.lower().endswith(".eml"):
            filename += ".eml"

        # 部分实现把原文包在 JSON 里（如 {"data": "..."}），其余直接返回字节流
        content_type = (source_resp.headers.get("Content-Type") or "").lower()
        if "json" in content_type:
            payload = source_resp.json()
            source_resp.close()
            raw = ""
            if isinstance(payload, dict):
                for key in ("data", "raw", "source", "eml"):
                    value = payload.get(key)
                    if isinstance(value, str) and value:
                        raw = value
                        break
            elif isinstance(payload, str):
                raw = payload
            if not raw:
                return jsonify({"success": False, "message": "邮件原文接口不可用"}), 404
            proxied = Response(raw, content_type="message/rfc822")
        else:
            proxied = Response(
                stream_with_context(source_resp.iter_content(65536)),
                content_type="message/rfc822",
            )
            if "Content-Length" in source_resp.headers:
                proxied.headers["Content-Length"] = source_resp.headers["Content-Length"]

        proxied.headers["Content-Disposition"] = f"attachment; filename*=UTF-8''{quote(filename)}"
        return proxied
    except Exception as e:
        app.logger.error(f"邮件原文下载失败: {e}", exc_info=True)
        return jsonify({"success": False, "message": "邮件原文下载失败"}), 502


# ---- 批量操作 API ----

@app.route("/api/inbox/batch", methods=["POST"])
@login_required
def inbox_batch():
    """批量操作邮件"""
    data = request.json or {}
    email = data.get("email", "").strip()
    password = data.get("password", "").strip() or UNIFIED_PASSWORD
    action = data.get("action", "").strip()
    message_ids = data.get("message_ids", [])

    if not email or not action or not message_ids:
        return jsonify({"success": False, "message": "缺少必要参数"})
    if _check_viewer_rate_limit("mail_mutation", SENSITIVE_RATE_LIMIT_WINDOW, SENSITIVE_RATE_LIMIT_MAX):
        return _rate_limited_json()

    base_url = DUCKMAIL_BASE_URL.rstrip("/")

    try:
        token, err = _get_mail_token(email, password)
        if err:
            return jsonify({"success": False, "message": err[0]})

        batch_resp = http_session.post(
            f"{base_url}/messages/batch",
            json={"action": action, "message_ids": message_ids},
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
            timeout=30,
        )

        if batch_resp.status_code == 200:
            return jsonify({"success": True, **batch_resp.json()})
        else:
            detail = "操作失败"
            try:
                detail = batch_resp.json().get("detail", detail)
            except Exception:
                pass
            return jsonify({"success": False, "message": detail})

    except Exception as e:
        app.logger.error(f"批量操作失败: {e}", exc_info=True)
        return jsonify({"success": False, "message": "服务内部错误，请稍后重试"})


# ---- 搜索邮件 API ----

@app.route("/api/inbox/search", methods=["POST"])
@login_required
def inbox_search():
    """搜索邮件"""
    data = request.json or {}
    email = data.get("email", "").strip()
    password = data.get("password", "").strip() or UNIFIED_PASSWORD
    query = data.get("query", "").strip()

    if not email or not query:
        return jsonify({"success": False, "message": "缺少必要参数", "messages": []})

    base_url = DUCKMAIL_BASE_URL.rstrip("/")

    try:
        token, err = _get_mail_token(email, password)
        if err:
            return jsonify({"success": False, "message": err[0], "messages": []})

        search_resp = http_session.get(
            f"{base_url}/messages/search",
            params={"q": query},
            headers={"Authorization": f"Bearer {token}"},
            timeout=30,
        )
        if search_resp.status_code != 200:
            return jsonify({"success": False, "message": "搜索失败", "messages": []})

        messages = search_resp.json()
        if isinstance(messages, dict):
            messages = messages.get("hydra:member", [])

        for msg in messages:
            msg["extracted_code"] = _extract_code(msg.get("subject", ""), msg.get("intro", ""))

        return jsonify({"success": True, "messages": messages})

    except Exception as e:
        app.logger.error(f"搜索邮件失败: {e}", exc_info=True)
        return jsonify({"success": False, "message": "服务内部错误，请稍后重试", "messages": []})


# ---- 删除邮件 API ----

@app.route("/api/inbox/delete", methods=["POST"])
@login_required
def inbox_delete():
    """删除邮件（软删除）"""
    data = request.json or {}
    email = data.get("email", "").strip()
    password = data.get("password", "").strip() or UNIFIED_PASSWORD
    message_id = data.get("message_id", "").strip()

    if not email or not message_id:
        return jsonify({"success": False, "message": "缺少必要参数"})
    if _check_viewer_rate_limit("mail_mutation", SENSITIVE_RATE_LIMIT_WINDOW, SENSITIVE_RATE_LIMIT_MAX):
        return _rate_limited_json()

    base_url = DUCKMAIL_BASE_URL.rstrip("/")

    try:
        token, err = _get_mail_token(email, password)
        if err:
            return jsonify({"success": False, "message": err[0]})

        del_resp = http_session.delete(
            f"{base_url}/messages/{message_id}",
            headers={"Authorization": f"Bearer {token}"},
            timeout=30,
        )

        if del_resp.status_code == 200:
            return jsonify({"success": True, "message": "邮件已删除"})
        else:
            return jsonify({"success": False, "message": f"删除失败 (HTTP {del_resp.status_code})"})

    except Exception as e:
        app.logger.error(f"删除邮件失败: {e}", exc_info=True)
        return jsonify({"success": False, "message": "服务内部错误，请稍后重试"})


# ---- Trash / 恢复 / 彻底删除 API ----

@app.route("/api/trash/query", methods=["POST"])
@login_required
def trash_query():
    """查询回收站邮件。"""
    data = request.json or {}
    email = data.get("email", "").strip()
    password = data.get("password", "").strip() or UNIFIED_PASSWORD
    offset = int(data.get("offset", 0))
    limit = int(data.get("limit", 30))

    if not email:
        return jsonify({"success": False, "message": "缺少邮箱地址", "messages": []})

    base_url = DUCKMAIL_BASE_URL.rstrip("/")
    try:
        token, err = _get_mail_token(email, password)
        if err:
            return jsonify({"success": False, "message": err[0], "messages": []})

        headers = {"Authorization": f"Bearer {token}"}
        trash_resp = http_session.get(
            f"{base_url}/messages/trash",
            params={"offset": offset, "limit": limit},
            headers=headers,
            timeout=30,
        )
        if trash_resp.status_code == 404:
            trash_resp = http_session.get(
                f"{base_url}/trash",
                params={"offset": offset, "limit": limit},
                headers=headers,
                timeout=30,
            )
        if trash_resp.status_code != 200:
            return jsonify({"success": False, "message": "回收站接口不可用", "messages": []})

        resp_data = trash_resp.json()
        messages = resp_data.get("hydra:member", []) if isinstance(resp_data, dict) else resp_data
        total = resp_data.get("hydra:totalItems", len(messages)) if isinstance(resp_data, dict) else len(messages)
        return jsonify({"success": True, "messages": messages, "total": total, "offset": offset, "limit": limit})

    except Exception as e:
        app.logger.error(f"查询回收站失败: {e}", exc_info=True)
        return jsonify({"success": False, "message": "服务内部错误，请稍后重试", "messages": []})


@app.route("/api/inbox/restore", methods=["POST"])
@login_required
def inbox_restore():
    """从回收站恢复邮件。"""
    if _check_viewer_rate_limit("mail_mutation", SENSITIVE_RATE_LIMIT_WINDOW, SENSITIVE_RATE_LIMIT_MAX):
        return _rate_limited_json()
    return _message_action(["restore"], "邮件已恢复")


@app.route("/api/inbox/permanent-delete", methods=["POST"])
@login_required
def inbox_permanent_delete():
    """彻底删除邮件。"""
    if _check_viewer_rate_limit("mail_mutation", SENSITIVE_RATE_LIMIT_WINDOW, SENSITIVE_RATE_LIMIT_MAX):
        return _rate_limited_json()
    return _message_action(["permanent-delete", "permanent_delete", "purge"], "邮件已彻底删除")


def _message_action(actions: list[str], ok_message: str):
    data = request.json or {}
    email = data.get("email", "").strip()
    password = data.get("password", "").strip() or UNIFIED_PASSWORD
    message_id = data.get("message_id", "").strip()

    if not email or not message_id:
        return jsonify({"success": False, "message": "缺少必要参数"})

    base_url = DUCKMAIL_BASE_URL.rstrip("/")
    try:
        token, err = _get_mail_token(email, password)
        if err:
            return jsonify({"success": False, "message": err[0]})

        headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
        last_resp = None
        for action in actions:
            endpoints = []
            if action in {"permanent-delete", "permanent_delete", "purge"}:
                endpoints.append(("delete", f"{base_url}/messages/{message_id}/permanent", None))
            endpoints.extend([
                ("post", f"{base_url}/messages/{message_id}/{action}", None),
                ("patch", f"{base_url}/messages/{message_id}", {"action": action}),
                ("post", f"{base_url}/messages/batch", {"action": action, "message_ids": [message_id]}),
            ])
            for method, url, payload in endpoints:
                resp = http_session.request(method, url, json=payload, headers=headers, timeout=30)
                last_resp = resp
                if resp.status_code in (200, 204):
                    payload = resp.json() if resp.content else {}
                    return jsonify({"success": True, "message": ok_message, **payload})
                if resp.status_code not in (404, 405, 422):
                    detail = _extract_api_error(resp, ok_message)
                    return jsonify({"success": False, "message": detail}), resp.status_code

        detail = _extract_api_error(last_resp, "后端暂未提供该操作接口") if last_resp else "后端暂未提供该操作接口"
        return jsonify({"success": False, "message": detail})

    except Exception as e:
        app.logger.error(f"邮件操作失败: {e}", exc_info=True)
        return jsonify({"success": False, "message": "服务内部错误，请稍后重试"})


# ---- 已发送邮件查询 API ----

@app.route("/api/sent/detail", methods=["POST"])
@login_required
def sent_detail():
    """查询已发送邮件详情。"""
    data = request.json or {}
    email = data.get("email", "").strip()
    password = data.get("password", "").strip() or UNIFIED_PASSWORD
    message_id = data.get("message_id", "").strip()

    if not email or not message_id:
        return jsonify({"success": False, "message": "缺少必要参数"})

    base_url = DUCKMAIL_BASE_URL.rstrip("/")
    try:
        token, err = _get_mail_token(email, password)
        if err:
            return jsonify({"success": False, "message": err[0]})

        detail_resp = http_session.get(
            f"{base_url}/sent/{message_id}",
            headers={"Authorization": f"Bearer {token}"},
            timeout=30,
        )
        if detail_resp.status_code != 200:
            detail = _extract_api_error(detail_resp, "获取已发送详情失败")
            return jsonify({"success": False, "message": detail})

        detail = detail_resp.json()
        if isinstance(detail, dict):
            detail["html"] = _prepare_html_for_render(detail.get("html", ""))
        return jsonify({"success": True, "detail": detail})

    except Exception as e:
        app.logger.error(f"获取已发送详情失败: {e}", exc_info=True)
        return jsonify({"success": False, "message": "服务内部错误，请稍后重试"})


@app.route("/api/sent/query", methods=["POST"])
@login_required
def sent_query():
    """查询已发送邮件"""
    data = request.json or {}
    email = data.get("email", "").strip()
    password = data.get("password", "").strip() or UNIFIED_PASSWORD

    if not email:
        return jsonify({"success": False, "message": "缺少邮箱地址", "messages": []})

    base_url = DUCKMAIL_BASE_URL.rstrip("/")

    try:
        token, err = _get_mail_token(email, password)
        if err:
            return jsonify({"success": False, "message": err[0], "messages": []})

        offset = int(data.get("offset", 0))
        limit = int(data.get("limit", 30))
        sent_resp = http_session.get(
            f"{base_url}/sent",
            params={"offset": offset, "limit": limit},
            headers={"Authorization": f"Bearer {token}"},
            timeout=30,
        )
        if sent_resp.status_code != 200:
            return jsonify({"success": False, "message": "查询已发送失败", "messages": []})

        resp_data = sent_resp.json()
        if isinstance(resp_data, dict):
            messages = resp_data.get("hydra:member", [])
            total = resp_data.get("hydra:totalItems", len(messages))
        else:
            messages = resp_data
            total = len(messages)
        if total == len(messages) and len(messages) > limit:
            messages = messages[offset:offset + limit]
        for msg in messages:
            if isinstance(msg, dict):
                msg["html"] = _prepare_html_for_render(msg.get("html", ""))

        return jsonify({"success": True, "messages": messages, "total": total, "offset": offset, "limit": limit})

    except Exception as e:
        app.logger.error(f"查询已发送邮件失败: {e}", exc_info=True)
        return jsonify({"success": False, "message": "服务内部错误，请稍后重试", "messages": []})


# ---- 发送邮件 API（通过 Resend） ----

def _normalize_attachments(raw) -> tuple[list, str]:
    """校验前端传来的 base64 附件，返回 (Resend 附件列表, 错误信息)。"""
    if not raw:
        return [], ""
    if not isinstance(raw, list):
        return [], "附件格式不正确"
    if len(raw) > MAX_ATTACHMENT_COUNT:
        return [], f"附件数量最多 {MAX_ATTACHMENT_COUNT} 个"

    normalized = []
    total = 0
    for item in raw:
        if not isinstance(item, dict):
            return [], "附件格式不正确"
        filename = str(item.get("filename") or "").strip()
        content = item.get("content")
        if not filename or not isinstance(content, str) or not content:
            return [], "附件缺少文件名或内容"
        # 只保留基础文件名，避免路径分隔符进入 Content-Disposition
        filename = os.path.basename(filename.replace("\\", "/"))[:200]
        if not filename:
            return [], "附件文件名不合法"
        try:
            decoded = base64.b64decode(content, validate=True)
        except (binascii.Error, ValueError):
            return [], f"附件 {filename} 编码不合法"
        if len(decoded) > MAX_ATTACHMENT_BYTES:
            return [], f"附件 {filename} 超过单个 {MAX_ATTACHMENT_BYTES // 1024 // 1024}MB 限制"
        total += len(decoded)
        if total > MAX_ATTACHMENT_TOTAL_BYTES:
            return [], f"附件总大小超过 {MAX_ATTACHMENT_TOTAL_BYTES // 1024 // 1024}MB 限制"
        entry = {"filename": filename, "content": content}
        content_type = str(item.get("contentType") or "").strip()
        if content_type:
            entry["content_type"] = content_type[:100]
        normalized.append(entry)

    return normalized, ""


@app.route("/api/send", methods=["POST"])
@login_required
def send_email():
    """通过 Resend API 发送邮件"""
    if _check_viewer_rate_limit("send_email", SENSITIVE_RATE_LIMIT_WINDOW, SENSITIVE_RATE_LIMIT_MAX):
        return _rate_limited_json()
    if not RESEND_API_KEY:
        return jsonify({"success": False, "message": "未配置 Resend API Key，无法发信"})

    data = request.json or {}
    from_email = data.get("from_email", "").strip()
    from_name = data.get("from_name", "").strip()
    to = data.get("to", "").strip()
    subject = data.get("subject", "").strip()
    html = data.get("html", "").strip()
    text = data.get("text", "").strip()
    reply_to = data.get("reply_to", "").strip()
    attachments, attachment_error = _normalize_attachments(data.get("attachments"))
    if attachment_error:
        return jsonify({"success": False, "message": attachment_error})

    # 基本校验
    if not from_email:
        return jsonify({"success": False, "message": "请填写发件人邮箱"})
    if not to:
        return jsonify({"success": False, "message": "请填写收件人邮箱"})
    if not subject:
        return jsonify({"success": False, "message": "请填写邮件主题"})
    if not html and not text:
        return jsonify({"success": False, "message": "请填写邮件正文"})

    # 构造发件人字段
    sender = f"{from_name} <{from_email}>" if from_name else from_email

    # 支持多收件人（逗号分隔）
    to_list = [addr.strip() for addr in to.split(",") if addr.strip()]

    # 构造 Resend API 请求
    payload = {
        "from": sender,
        "to": to_list,
        "subject": subject,
    }
    sanitized_html = _sanitize_email_html(html) if html else ""
    if html:
        payload["html"] = sanitized_html
    if text:
        payload["text"] = text
    if reply_to:
        payload["reply_to"] = reply_to
    if attachments:
        payload["attachments"] = attachments

    try:
        resp = http_session.post(
            "https://api.resend.com/emails",
            json=payload,
            headers={
                "Authorization": f"Bearer {RESEND_API_KEY}",
                "Content-Type": "application/json",
            },
            timeout=30,
        )

        if resp.status_code in (200, 201):
            result = resp.json()
            resend_id = result.get("id", "")

            # 存储已发送记录到 mail-server
            try:
                base_url = DUCKMAIL_BASE_URL.rstrip("/")
                http_session.post(
                    f"{base_url}/admin/sent",
                    json={
                        "from_address": from_email.lower(),
                        "to": to_list,
                        "subject": subject,
                        "text": text,
                        "html": sanitized_html,
                        "resend_id": resend_id,
                    },
                    headers={
                        "Authorization": f"Bearer {DUCKMAIL_API_KEY}",
                        "Content-Type": "application/json",
                    },
                    timeout=10,
                )
            except Exception:
                pass  # 存储失败不影响发送结果

            return jsonify({
                "success": True,
                "message": "邮件发送成功",
                "email_id": resend_id,
            })
        else:
            # 解析 Resend 错误信息
            error_msg = "发送失败"
            try:
                err_data = resp.json()
                error_msg = err_data.get("message", "") or err_data.get("name", error_msg)
            except Exception:
                error_msg = f"发送失败 (HTTP {resp.status_code})"
            return jsonify({"success": False, "message": error_msg})

    except Exception as e:
        app.logger.error(f"发送邮件失败: {e}", exc_info=True)
        return jsonify({"success": False, "message": "服务内部错误，请稍后重试"})


if __name__ == "__main__":
    port = int(os.getenv("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)
