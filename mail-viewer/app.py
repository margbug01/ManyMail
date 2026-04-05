import ipaddress
import os
import re
import socket
import requests
import bleach
from functools import wraps
from bleach.css_sanitizer import CSSSanitizer
from urllib.parse import urlparse, urljoin
from flask import Flask, render_template, jsonify, request, session, redirect, url_for, Response

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
_EMAIL_ALLOWED_TAGS = [
    "a", "abbr", "b", "blockquote", "br", "code", "div", "em", "font",
    "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "li", "ol",
    "p", "pre", "span", "strong", "table", "tbody", "td", "th", "thead",
    "tr", "u", "ul",
]
_EMAIL_ALLOWED_ATTRIBUTES = {
    "*": ["align", "valign"],
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
_EMAIL_CSS_SANITIZER = CSSSanitizer(
    allowed_css_properties=[
        "background", "background-color", "border", "border-bottom", "border-collapse",
        "border-left", "border-right", "border-spacing", "border-top", "color",
        "display", "font", "font-family", "font-size", "font-style", "font-weight",
        "height", "letter-spacing", "line-height", "margin", "margin-bottom",
        "margin-left", "margin-right", "margin-top", "max-width", "min-width",
        "padding", "padding-bottom", "padding-left", "padding-right", "padding-top",
        "text-align", "text-decoration", "vertical-align", "white-space", "width",
        "word-break",
    ]
)


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


def _sanitize_email_html(html: str) -> str:
    html = (html or "").strip()
    if not html:
        return ""
    body_match = re.search(r"<body[^>]*>(.*)</body>", html, flags=re.IGNORECASE | re.DOTALL)
    if body_match:
        html = body_match.group(1)
    cleaned = bleach.clean(
        html,
        tags=_EMAIL_ALLOWED_TAGS,
        attributes=_EMAIL_ALLOWED_ATTRIBUTES,
        protocols={"http", "https", "mailto", "cid", "data"},
        strip=True,
        css_sanitizer=_EMAIL_CSS_SANITIZER,
    )
    return cleaned.strip()


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


@app.route("/login", methods=["GET", "POST"])
def login_page():
    """登录页面"""
    if not ACCESS_PASSWORD:
        return redirect(url_for("index"))
    
    if request.method == "POST":
        password = request.form.get("password", "")
        if password == ACCESS_PASSWORD:
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
        
        # 如果登录失败（邮箱不存在），尝试创建
        if token_resp.status_code != 200:
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
                except:
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
            subject = msg.get("subject", "")
            intro = msg.get("intro", "")
            text = f"{subject} {intro}"
            code_match = re.search(r"\b(\d{6})\b", text)
            msg["extracted_code"] = code_match.group(1) if code_match else None
        
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
        return jsonify({"success": False, "message": str(e)})


@app.route("/api/domains", methods=["POST"])
@login_required
def add_domain():
    """添加新域名"""
    data = request.json or {}
    domain = data.get("domain", "").strip().lower()
    if not domain:
        return jsonify({"success": False, "message": "域名不能为空"})

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
        return jsonify({"success": False, "message": str(e)})


@app.route("/api/domains/<domain>", methods=["DELETE"])
@login_required
def delete_domain(domain):
    """删除（停用）域名"""
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
        return jsonify({"success": False, "message": str(e)})


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
        return jsonify({"success": True, "detail": detail})

    except Exception as e:
        app.logger.error(f"获取邮件详情失败: {e}", exc_info=True)
        return jsonify({"success": False, "message": "服务内部错误，请稍后重试"})


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
            subject = msg.get("subject", "")
            intro = msg.get("intro", "")
            text = f"{subject} {intro}"
            code_match = re.search(r"\b(\d{6})\b", text)
            msg["extracted_code"] = code_match.group(1) if code_match else None

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


# ---- 已发送邮件查询 API ----

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

        sent_resp = http_session.get(
            f"{base_url}/sent",
            headers={"Authorization": f"Bearer {token}"},
            timeout=30,
        )
        if sent_resp.status_code != 200:
            return jsonify({"success": False, "message": "查询已发送失败", "messages": []})

        messages = sent_resp.json()
        if isinstance(messages, dict):
            messages = messages.get("hydra:member", [])
        for msg in messages:
            if isinstance(msg, dict):
                msg["html"] = _prepare_html_for_render(msg.get("html", ""))

        return jsonify({"success": True, "messages": messages})

    except Exception as e:
        app.logger.error(f"查询已发送邮件失败: {e}", exc_info=True)
        return jsonify({"success": False, "message": "服务内部错误，请稍后重试", "messages": []})


# ---- 发送邮件 API（通过 Resend） ----

@app.route("/api/send", methods=["POST"])
@login_required
def send_email():
    """通过 Resend API 发送邮件"""
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
