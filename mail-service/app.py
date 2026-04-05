"""
自建邮箱服务 - DuckMail API 兼容
SMTP 接收 (aiosmtpd, port 25) + REST API (FastAPI, port 8080)
"""

import ipaddress
import os
import re
import time
import hmac
import logging
import threading
from collections import defaultdict
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from email import policy
from email.parser import BytesParser

import jwt
import bcrypt
import uvicorn
from bson import ObjectId
from pymongo import MongoClient, DESCENDING
from fastapi import FastAPI, Request, HTTPException, Depends
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from aiosmtpd.controller import Controller

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

MONGO_URL = os.getenv("MONGO_URL", "mongodb://mongodb:27017")
DB_NAME = os.getenv("DB_NAME", "mailserver")
JWT_SECRET = os.getenv("JWT_SECRET", "change-this-in-production")
API_KEY = os.getenv("API_KEY", "")
SMTP_HOSTNAME = os.getenv("SMTP_HOSTNAME", "mail.example.com")
ENVIRONMENT = os.getenv("ENVIRONMENT", "development").strip().lower()
# 环境变量中的域名仅作为种子数据，实际域名列表存储在 MongoDB 中
_SEED_DOMAINS = [d.strip().lower() for d in os.getenv("DOMAINS", "").split(",") if d.strip()]
API_PORT = int(os.getenv("API_PORT", "8080"))
SMTP_PORT = int(os.getenv("SMTP_PORT", "25"))
MESSAGE_TTL_DAYS = int(os.getenv("MESSAGE_TTL_DAYS", "3"))


def _env_flag(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


IS_PRODUCTION = ENVIRONMENT == "production"
ENABLE_API_DOCS = _env_flag("ENABLE_API_DOCS", default=not IS_PRODUCTION)
EXPOSE_HEALTH_DETAILS = _env_flag("EXPOSE_HEALTH_DETAILS", default=not IS_PRODUCTION)
_CORS_ORIGINS = [o.strip() for o in os.getenv("CORS_ORIGINS", "").split(",") if o.strip()]
if not _CORS_ORIGINS and not IS_PRODUCTION:
    _CORS_ORIGINS = ["*"]


def _require_production_value(name: str, value: str, disallowed: set[str] | None = None):
    if not IS_PRODUCTION:
        return
    disallowed = disallowed or set()
    normalized = (value or "").strip()
    if not normalized or normalized in disallowed:
        raise RuntimeError(f"{name} must be configured for production")

# ---------------------------------------------------------------------------
# Rate Limiting (内存级简单限流)
# ---------------------------------------------------------------------------

_rate_limit_store: dict = defaultdict(list)
_RATE_LIMIT_WINDOW = int(os.getenv("RATE_LIMIT_WINDOW", "60"))  # 秒
_RATE_LIMIT_MAX = int(os.getenv("RATE_LIMIT_MAX", "60"))  # 每个IP每分钟最多请求数
_SMTP_RCPT_RATE_WINDOW = int(os.getenv("SMTP_RCPT_RATE_WINDOW", "60"))
_SMTP_RCPT_RATE_MAX = int(os.getenv("SMTP_RCPT_RATE_MAX", "100"))
_SMTP_DATA_RATE_WINDOW = int(os.getenv("SMTP_DATA_RATE_WINDOW", "60"))
_SMTP_DATA_RATE_MAX = int(os.getenv("SMTP_DATA_RATE_MAX", "20"))
_SMTP_MAX_RCPTS_PER_MESSAGE = int(os.getenv("SMTP_MAX_RCPTS_PER_MESSAGE", "20"))
_SMTP_MAX_MESSAGE_BYTES = int(os.getenv("SMTP_MAX_MESSAGE_BYTES", str(1024 * 1024)))
_SMTP_MAX_ADDRESS_LENGTH = int(os.getenv("SMTP_MAX_ADDRESS_LENGTH", "320"))
_SMTP_BLACKLIST_IPS = {item.strip() for item in os.getenv("SMTP_BLACKLIST_IPS", "").split(",") if item.strip()}
_SMTP_BLACKLIST_SENDERS = {item.strip().lower() for item in os.getenv("SMTP_BLACKLIST_SENDERS", "").split(",") if item.strip()}
_SMTP_GREYLIST_ENABLED = _env_flag("SMTP_GREYLIST_ENABLED", default=False)
_SMTP_GREYLIST_DELAY_SECONDS = int(os.getenv("SMTP_GREYLIST_DELAY_SECONDS", "60"))
_SMTP_GREYLIST_TTL_SECONDS = int(os.getenv("SMTP_GREYLIST_TTL_SECONDS", "3600"))
_smtp_rcpt_rate_store: dict = defaultdict(list)
_smtp_data_rate_store: dict = defaultdict(list)
_smtp_greylist_store: dict = {}
_smtp_limit_lock = threading.Lock()

_require_production_value("JWT_SECRET", JWT_SECRET, {"change-this-in-production"})
_require_production_value("API_KEY", API_KEY)
if IS_PRODUCTION and not _CORS_ORIGINS:
    raise RuntimeError("CORS_ORIGINS must be configured for production")


def _is_internal_client(client_ip: str) -> bool:
    try:
        ip = ipaddress.ip_address(client_ip)
        return ip.is_private or ip.is_loopback
    except ValueError:
        return False


def _check_rate_limit(client_ip: str):
    """简单的内存速率限制；跳过容器/内网来源，避免前端代理共享 IP 误伤"""
    if _RATE_LIMIT_MAX <= 0 or _is_internal_client(client_ip):
        return
    now = time.time()
    _rate_limit_store[client_ip] = [t for t in _rate_limit_store[client_ip] if now - t < _RATE_LIMIT_WINDOW]
    if len(_rate_limit_store[client_ip]) >= _RATE_LIMIT_MAX:
        raise HTTPException(status_code=429, detail="Too many requests, please try again later")
    _rate_limit_store[client_ip].append(now)


def _get_smtp_client_ip(session) -> str:
    peer = getattr(session, "peer", None)
    if isinstance(peer, (tuple, list)) and peer:
        return str(peer[0])
    return ""


def _prune_rate_bucket(store: dict, key: str, window_seconds: int, now: float | None = None) -> list:
    now = now or time.time()
    store[key] = [t for t in store[key] if now - t < window_seconds]
    return store[key]


def _check_smtp_rcpt_limit(client_ip: str, current_rcpt_count: int) -> str | None:
    if not client_ip or _is_internal_client(client_ip):
        return None
    if _SMTP_MAX_RCPTS_PER_MESSAGE > 0 and current_rcpt_count >= _SMTP_MAX_RCPTS_PER_MESSAGE:
        return "452 4.5.3 Too many recipients"
    if _SMTP_RCPT_RATE_MAX <= 0:
        return None
    now = time.time()
    with _smtp_limit_lock:
        bucket = _prune_rate_bucket(_smtp_rcpt_rate_store, client_ip, _SMTP_RCPT_RATE_WINDOW, now)
        if len(bucket) >= _SMTP_RCPT_RATE_MAX:
            return "421 4.7.0 Too many recipient commands, try again later"
        bucket.append(now)
    return None


def _check_smtp_data_limit(client_ip: str) -> str | None:
    if not client_ip or _is_internal_client(client_ip) or _SMTP_DATA_RATE_MAX <= 0:
        return None
    now = time.time()
    with _smtp_limit_lock:
        bucket = _prune_rate_bucket(_smtp_data_rate_store, client_ip, _SMTP_DATA_RATE_WINDOW, now)
        if len(bucket) >= _SMTP_DATA_RATE_MAX:
            return "421 4.7.0 Too many messages, try again later"
        bucket.append(now)
    return None


def _is_blacklisted_sender(address: str) -> bool:
    sender = (address or "").strip().lower()
    if not sender:
        return False
    if sender in _SMTP_BLACKLIST_SENDERS:
        return True
    domain = sender.split("@", 1)[1] if "@" in sender else sender
    return domain in _SMTP_BLACKLIST_SENDERS


def _check_smtp_blacklist(client_ip: str, mail_from: str) -> str | None:
    if client_ip and client_ip in _SMTP_BLACKLIST_IPS:
        return "554 5.7.1 Client blocked"
    if _is_blacklisted_sender(mail_from):
        return "554 5.7.1 Sender blocked"
    return None


def _check_smtp_greylist(client_ip: str, mail_from: str, rcpt_to: str) -> str | None:
    if not _SMTP_GREYLIST_ENABLED or not client_ip or _is_internal_client(client_ip):
        return None
    sender = (mail_from or "").strip().lower()
    recipient = (rcpt_to or "").strip().lower()
    if not sender or not recipient:
        return None
    now = time.time()
    key = (client_ip, sender, recipient)
    with _smtp_limit_lock:
        expired_keys = [k for k, meta in _smtp_greylist_store.items() if now - meta["first_seen"] > _SMTP_GREYLIST_TTL_SECONDS]
        for expired in expired_keys:
            _smtp_greylist_store.pop(expired, None)
        meta = _smtp_greylist_store.get(key)
        if meta is None:
            _smtp_greylist_store[key] = {"first_seen": now}
            return "451 4.7.1 Greylisted, please retry later"
        if now - meta["first_seen"] < _SMTP_GREYLIST_DELAY_SECONDS:
            return "451 4.7.1 Greylisted, please retry later"
    return None

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)
logger = logging.getLogger("mail-service")

# ---------------------------------------------------------------------------
# MongoDB (pymongo, thread-safe)
# ---------------------------------------------------------------------------

mongo_client = MongoClient(MONGO_URL, serverSelectionTimeoutMS=5000)
db = mongo_client[DB_NAME]


def init_db():
    """创建索引并导入种子域名"""
    if JWT_SECRET == "change-this-in-production":
        logger.warning("⚠️ JWT_SECRET is using default value! Change it in production!")
    db.accounts.create_index("address", unique=True)
    db.messages.create_index("to_addresses")
    db.messages.create_index([("created_at", DESCENDING)])
    # TTL: 自动删除过期邮件
    db.messages.create_index(
        "created_at", expireAfterSeconds=MESSAGE_TTL_DAYS * 86400, name="ttl_cleanup"
    )
    # 已发送邮件集合索引
    db.sent_messages.create_index("from_address")
    db.sent_messages.create_index([("created_at", DESCENDING)])
    # 域名集合索引
    db.domains.create_index("domain", unique=True)
    # 将环境变量中的域名作为种子数据导入（幂等）
    for d in _SEED_DOMAINS:
        db.domains.update_one(
            {"domain": d},
            {"$setOnInsert": {
                "domain": d,
                "is_active": True,
                "created_at": datetime.now(timezone.utc),
            }},
            upsert=True,
        )
    logger.info(f"MongoDB indexes created, message TTL = {MESSAGE_TTL_DAYS} days")
    logger.info(f"Seed domains imported: {_SEED_DOMAINS}")


# ---------------------------------------------------------------------------
# Dynamic Domain Management (带缓存)
# ---------------------------------------------------------------------------

_domains_cache: list = []
_domains_cache_ts: float = 0
_domains_cache_lock = threading.Lock()
_DOMAINS_CACHE_TTL = 30  # 缓存 30 秒


def get_active_domains() -> list:
    """从 MongoDB 获取活跃域名列表（带内存缓存，避免频繁查库）"""
    global _domains_cache, _domains_cache_ts
    now = time.time()
    if now - _domains_cache_ts < _DOMAINS_CACHE_TTL and _domains_cache:
        return _domains_cache
    with _domains_cache_lock:
        # double-check
        if now - _domains_cache_ts < _DOMAINS_CACHE_TTL and _domains_cache:
            return _domains_cache
        try:
            docs = db.domains.find({"is_active": True})
            _domains_cache = [doc["domain"] for doc in docs]
            _domains_cache_ts = time.time()
        except Exception as e:
            logger.error(f"Failed to load domains from DB: {e}")
            # 回退到种子域名
            if not _domains_cache:
                _domains_cache = list(_SEED_DOMAINS)
    return _domains_cache


def _invalidate_domains_cache():
    """清除域名缓存，使下次调用重新从 DB 读取"""
    global _domains_cache_ts
    _domains_cache_ts = 0


# ---------------------------------------------------------------------------
# JWT Helpers
# ---------------------------------------------------------------------------

def create_token(account_id: str, address: str) -> str:
    payload = {
        "account_id": account_id,
        "address": address,
        "exp": datetime.now(timezone.utc) + timedelta(hours=24),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm="HS256")


def decode_token(token: str) -> dict:
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")


async def get_current_account(request: Request):
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid token")
    return decode_token(auth[7:])


# ---------------------------------------------------------------------------
# FastAPI Application
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app):
    init_db()
    start_smtp_server()
    logger.info(f"API server ready on port {API_PORT}")
    yield


app = FastAPI(
    title="Self-Hosted Mail API",
    docs_url="/api-docs" if ENABLE_API_DOCS else None,
    redoc_url=None,
    openapi_url="/openapi.json" if ENABLE_API_DOCS else None,
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_CORS_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---- Health Check ----

@app.get("/health")
async def health():
    payload = {"status": "ok"}
    if EXPOSE_HEALTH_DETAILS:
        payload["domains"] = get_active_domains()
    return payload


# ---- Domains ----

@app.get("/domains")
async def list_domains(request: Request):
    """列出可用域名 (公开 + API Key 私有域名)"""
    active_domains = get_active_domains()
    domain_list = [
        {
            "@id": f"/domains/{d}",
            "@type": "Domain",
            "domain": d,
            "isActive": True,
            "isPrivate": False,
        }
        for d in active_domains
    ]
    return {"hydra:member": domain_list}


# ---- Accounts ----

@app.post("/accounts")
async def create_account(request: Request):
    """创建邮箱账户 (兼容 DuckMail API)"""
    _check_rate_limit(request.client.host)
    data = await request.json()
    address = data.get("address", "").strip().lower()
    password = data.get("password", "")

    if not address or not password:
        raise HTTPException(
            status_code=422,
            detail={"hydra:description": "Address and password are required"},
        )

    if "@" not in address:
        raise HTTPException(
            status_code=422,
            detail={"hydra:description": "Invalid email address format"},
        )

    domain = address.split("@", 1)[1]
    if domain not in get_active_domains():
        raise HTTPException(
            status_code=422,
            detail={"hydra:description": f"Domain '{domain}' is not available"},
        )

    # 检查是否已存在
    if db.accounts.find_one({"address": address}):
        raise HTTPException(
            status_code=422,
            detail={
                "hydra:description": "This address is already used.",
                "violations": [{"message": "This address is already used."}],
            },
        )

    now = datetime.now(timezone.utc)
    password_hash = bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()

    result = db.accounts.insert_one(
        {
            "address": address,
            "password_hash": password_hash,
            "is_active": True,
            "created_at": now,
            "updated_at": now,
        }
    )

    logger.info(f"Account created: {address}")
    return JSONResponse(
        status_code=201,
        content={
            "id": str(result.inserted_id),
            "address": address,
            "isActive": True,
            "isSilenced": False,
            "createdAt": now.isoformat(),
            "updatedAt": now.isoformat(),
        },
    )


# ---- Token (Login) ----

@app.post("/token")
async def login(request: Request):
    """登录获取 JWT Token (兼容 DuckMail API)"""
    _check_rate_limit(request.client.host)
    data = await request.json()
    address = data.get("address", "").strip().lower()
    password = data.get("password", "")

    account = db.accounts.find_one({"address": address})
    if not account:
        raise HTTPException(status_code=401, detail="Invalid credentials")

    if not bcrypt.checkpw(password.encode(), account["password_hash"].encode()):
        raise HTTPException(status_code=401, detail="Invalid credentials")

    token = create_token(str(account["_id"]), account["address"])
    return {"token": token}


# ---- Admin: Domain Management (API_KEY 鉴权) ----

def _require_api_key(request: Request):
    """验证 API Key（用于管理端点）"""
    auth = request.headers.get("Authorization", "")
    key = auth.replace("Bearer ", "").strip() if auth.startswith("Bearer ") else ""
    if not API_KEY or not hmac.compare_digest(key, API_KEY):
        raise HTTPException(status_code=403, detail="Invalid or missing API key")


@app.get("/admin/domains")
async def admin_list_domains(request: Request):
    """列出所有域名（含非活跃）"""
    _require_api_key(request)
    docs = list(db.domains.find({}, {"_id": 0}))
    for doc in docs:
        if "created_at" in doc and isinstance(doc["created_at"], datetime):
            doc["created_at"] = doc["created_at"].isoformat()
    return {"domains": docs}


@app.post("/admin/domains")
async def admin_add_domain(request: Request):
    """添加新域名"""
    _require_api_key(request)
    data = await request.json()
    domain = data.get("domain", "").strip().lower()

    if not domain:
        raise HTTPException(status_code=422, detail="Domain is required")

    # 简单校验域名格式
    if "." not in domain or len(domain) < 3:
        raise HTTPException(status_code=422, detail="Invalid domain format")

    existing = db.domains.find_one({"domain": domain})
    if existing:
        # 如果已存在但非活跃，重新激活
        if not existing.get("is_active", True):
            db.domains.update_one({"domain": domain}, {"$set": {"is_active": True}})
            _invalidate_domains_cache()
            return {"message": f"Domain '{domain}' reactivated", "domain": domain}
        raise HTTPException(status_code=409, detail=f"Domain '{domain}' already exists")

    db.domains.insert_one({
        "domain": domain,
        "is_active": True,
        "created_at": datetime.now(timezone.utc),
    })
    _invalidate_domains_cache()
    logger.info(f"Domain added: {domain}")
    return JSONResponse(status_code=201, content={"message": f"Domain '{domain}' added", "domain": domain})


@app.delete("/admin/domains/{domain}")
async def admin_delete_domain(domain: str, request: Request):
    """删除（停用）域名"""
    _require_api_key(request)
    domain = domain.strip().lower()

    result = db.domains.update_one(
        {"domain": domain},
        {"$set": {"is_active": False}},
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail=f"Domain '{domain}' not found")

    _invalidate_domains_cache()
    logger.info(f"Domain deactivated: {domain}")
    return {"message": f"Domain '{domain}' deactivated", "domain": domain}


# ---- Messages ----

def _dt_to_iso_utc(dt) -> str:
    """将 datetime 转为带 UTC 标识的 ISO 字符串（MongoDB 返回的 naive datetime 默认是 UTC）"""
    if isinstance(dt, datetime):
        s = dt.isoformat()
        # pymongo 返回的 naive datetime 没有时区信息，但实际是 UTC，需加 'Z'
        if dt.tzinfo is None:
            s += "Z"
        return s
    return str(dt) if dt else ""


def _format_message(msg: dict, include_body: bool = False) -> dict:
    """格式化消息为 DuckMail 兼容格式"""
    msg_id = str(msg["_id"])
    created = msg["created_at"]
    updated = msg.get("updated_at", created)

    result = {
        "@context": "/contexts/Message",
        "@id": f"/messages/{msg_id}",
        "@type": "Message",
        "id": msg_id,
        "msgid": msg_id,
        "from": msg.get("from", {}),
        "to": msg.get("to", []),
        "subject": msg.get("subject", ""),
        "intro": msg.get("intro", ""),
        "hasAttachments": msg.get("has_attachments", False),
        "seen": msg.get("seen", False),
        "isDeleted": msg.get("is_deleted", False),
        "size": msg.get("size", 0),
        "createdAt": _dt_to_iso_utc(created),
        "updatedAt": _dt_to_iso_utc(updated),
    }

    if include_body:
        result["text"] = msg.get("text", "")
        result["html"] = msg.get("html", "")

    return result


@app.get("/messages")
async def list_messages(
    account=Depends(get_current_account),
    offset: int = 0,
    limit: int = 30,
):
    """查询收件箱 (Bearer Token 鉴权)，支持分页"""
    address = account["address"]
    limit = min(limit, 100)  # 最大 100 条
    offset = max(offset, 0)

    query_filter = {"to_addresses": address, "is_deleted": {"$ne": True}}
    total = db.messages.count_documents(query_filter)

    cursor = (
        db.messages.find(query_filter)
        .sort("created_at", DESCENDING)
        .skip(offset)
        .limit(limit)
    )
    messages = [_format_message(msg) for msg in cursor]
    return {
        "hydra:member": messages,
        "hydra:totalItems": total,
        "offset": offset,
        "limit": limit,
    }


@app.get("/messages/search")
async def search_messages(
    q: str = "",
    account=Depends(get_current_account),
):
    """搜索邮件（按发件人、主题、摘要模糊匹配）"""
    address = account["address"]
    if not q.strip():
        return {"hydra:member": []}

    escaped_q = re.escape(q)
    query_filter = {
        "to_addresses": address,
        "is_deleted": {"$ne": True},
        "$or": [
            {"subject": {"$regex": escaped_q, "$options": "i"}},
            {"intro": {"$regex": escaped_q, "$options": "i"}},
            {"from.address": {"$regex": escaped_q, "$options": "i"}},
            {"from.name": {"$regex": escaped_q, "$options": "i"}},
        ],
    }
    cursor = (
        db.messages.find(query_filter)
        .sort("created_at", DESCENDING)
        .limit(50)
    )
    messages = [_format_message(msg) for msg in cursor]
    return {"hydra:member": messages}


@app.get("/messages/{message_id}")
async def get_message(message_id: str, account=Depends(get_current_account)):
    """获取邮件详情"""
    address = account["address"]

    try:
        oid = ObjectId(message_id)
    except Exception:
        raise HTTPException(status_code=404, detail="Message not found")

    msg = db.messages.find_one({"_id": oid, "to_addresses": address})
    if not msg:
        raise HTTPException(status_code=404, detail="Message not found")

    # 标记已读
    if not msg.get("seen"):
        db.messages.update_one({"_id": oid}, {"$set": {"seen": True}})

    return _format_message(msg, include_body=True)


@app.delete("/messages/{message_id}")
async def delete_message(message_id: str, account=Depends(get_current_account)):
    """软删除邮件（标记 is_deleted）"""
    address = account["address"]

    try:
        oid = ObjectId(message_id)
    except Exception:
        raise HTTPException(status_code=404, detail="Message not found")

    result = db.messages.update_one(
        {"_id": oid, "to_addresses": address},
        {"$set": {"is_deleted": True}},
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Message not found")

    logger.info(f"Message deleted: {message_id} by {address}")
    return {"message": "Deleted", "id": message_id}


@app.post("/messages/batch")
async def batch_action(request: Request, account=Depends(get_current_account)):
    """批量操作邮件（删除 / 标记已读）"""
    address = account["address"]
    data = await request.json()
    action = data.get("action", "")
    message_ids = data.get("message_ids", [])

    if not message_ids or not isinstance(message_ids, list):
        raise HTTPException(status_code=422, detail="message_ids is required")

    oids = []
    for mid in message_ids:
        try:
            oids.append(ObjectId(mid))
        except Exception:
            pass

    if not oids:
        raise HTTPException(status_code=422, detail="No valid message IDs")

    query_filter = {"_id": {"$in": oids}, "to_addresses": address}

    if action == "delete":
        result = db.messages.update_many(query_filter, {"$set": {"is_deleted": True}})
        logger.info(f"Batch delete: {result.modified_count} messages by {address}")
        return {"message": f"Deleted {result.modified_count} messages", "count": result.modified_count}
    elif action == "mark_read":
        result = db.messages.update_many(query_filter, {"$set": {"seen": True}})
        logger.info(f"Batch mark_read: {result.modified_count} messages by {address}")
        return {"message": f"Marked {result.modified_count} as read", "count": result.modified_count}
    else:
        raise HTTPException(status_code=422, detail=f"Unknown action: {action}")


# ---- Sent Messages (已发送记录) ----

@app.post("/admin/sent")
async def store_sent_message(request: Request):
    """存储已发送邮件记录（API_KEY 鉴权）"""
    _require_api_key(request)
    data = await request.json()

    from_address = data.get("from_address", "").strip().lower()
    to = data.get("to", [])
    subject = data.get("subject", "")
    text = data.get("text", "")
    html = data.get("html", "")
    resend_id = data.get("resend_id", "")

    if not from_address or not to:
        raise HTTPException(status_code=422, detail="from_address and to are required")

    now = datetime.now(timezone.utc)
    doc = {
        "from_address": from_address,
        "to": to if isinstance(to, list) else [to],
        "subject": subject,
        "text": text,
        "html": html,
        "resend_id": resend_id,
        "created_at": now,
    }
    result = db.sent_messages.insert_one(doc)
    logger.info(f"Sent message stored: {from_address} -> {to} | {subject[:50]}")
    return JSONResponse(status_code=201, content={
        "id": str(result.inserted_id),
        "message": "Stored",
    })


@app.get("/sent")
async def list_sent_messages(account=Depends(get_current_account)):
    """查询已发送邮件（Bearer Token 鉴权）"""
    address = account["address"]
    cursor = (
        db.sent_messages.find({"from_address": address})
        .sort("created_at", DESCENDING)
        .limit(100)
    )
    messages = []
    for doc in cursor:
        messages.append({
            "id": str(doc["_id"]),
            "from_address": doc.get("from_address", ""),
            "to": doc.get("to", []),
            "subject": doc.get("subject", ""),
            "text": doc.get("text", ""),
            "html": doc.get("html", ""),
            "resend_id": doc.get("resend_id", ""),
            "createdAt": _dt_to_iso_utc(doc.get("created_at")),
        })
    return {"hydra:member": messages}


# ---------------------------------------------------------------------------
# SMTP Server (aiosmtpd)
# ---------------------------------------------------------------------------

class MailHandler:
    """SMTP 邮件接收处理器"""

    async def handle_MAIL(self, server, session, envelope, address, mail_options):
        session.rcpt_count = 0
        session.mail_from = address
        envelope.mail_from = address
        return "250 OK"

    async def handle_RCPT(self, server, session, envelope, address, rcpt_options):
        """验证收件域名（动态从 MongoDB 读取域名列表）"""
        addr = (address or "").strip().lower()
        client_ip = _get_smtp_client_ip(session)
        current_rcpt_count = int(getattr(session, "rcpt_count", 0))
        mail_from = getattr(envelope, "mail_from", "") or getattr(session, "mail_from", "")
        if not addr or "@" not in addr:
            return "501 5.1.3 Bad recipient address syntax"
        if len(addr) > _SMTP_MAX_ADDRESS_LENGTH:
            return "552 5.3.4 Recipient address too long"
        if addr in envelope.rcpt_tos:
            return "452 4.5.3 Duplicate recipient"
        blocked = _check_smtp_blacklist(client_ip, mail_from)
        if blocked:
            return blocked
        greylist = _check_smtp_greylist(client_ip, mail_from, addr)
        if greylist:
            return greylist
        limit_error = _check_smtp_rcpt_limit(client_ip, current_rcpt_count)
        if limit_error:
            return limit_error
        domain = addr.split("@", 1)[1] if "@" in addr else ""
        if domain not in get_active_domains():
            return f"550 Domain {domain} not accepted here"
        envelope.rcpt_tos.append(addr)
        session.rcpt_count = current_rcpt_count + 1
        return "250 OK"

    async def handle_DATA(self, server, session, envelope):
        """接收并存储邮件"""
        try:
            client_ip = _get_smtp_client_ip(session)
            limit_error = _check_smtp_data_limit(client_ip)
            if limit_error:
                return limit_error
            raw = envelope.content
            if isinstance(raw, str):
                raw = raw.encode("utf-8")
            if len(raw) > _SMTP_MAX_MESSAGE_BYTES:
                return "552 5.3.4 Message too large"
            if not envelope.rcpt_tos:
                return "554 5.5.1 No valid recipients"

            # 解析邮件
            parser = BytesParser(policy=policy.default)
            msg = parser.parsebytes(raw)

            # 提取发件人
            from_header = msg.get("From", "")
            from_name, from_email = "", ""
            if "<" in from_header:
                parts = from_header.rsplit("<", 1)
                from_name = parts[0].strip().strip('"').strip()
                from_email = parts[1].strip(">").strip().lower()
            else:
                from_email = from_header.strip().lower()

            # 提取收件人
            to_addresses = [a.lower() for a in envelope.rcpt_tos]
            to_list = [{"address": a, "name": ""} for a in to_addresses]

            # 提取正文
            text_body = ""
            html_body = ""
            has_attachments = False

            if msg.is_multipart():
                for part in msg.walk():
                    ct = part.get_content_type()
                    cd = part.get("Content-Disposition", "")
                    if "attachment" in cd:
                        has_attachments = True
                        continue
                    if ct == "text/plain" and not text_body:
                        try:
                            text_body = part.get_content()
                        except Exception:
                            pass
                    elif ct == "text/html" and not html_body:
                        try:
                            html_body = part.get_content()
                        except Exception:
                            pass
            else:
                ct = msg.get_content_type()
                try:
                    content = msg.get_content()
                except Exception:
                    content = ""
                if ct == "text/html":
                    html_body = content
                else:
                    text_body = content

            subject = msg.get("Subject", "")
            # 从纯文本中截取摘要
            intro = re.sub(r"\s+", " ", (text_body or "")).strip()[:200]
            if not any([subject.strip(), text_body.strip(), html_body.strip()]):
                return "554 5.6.0 Empty message rejected"

            now = datetime.now(timezone.utc)
            doc = {
                "to_addresses": to_addresses,
                "from": {"address": from_email, "name": from_name},
                "to": to_list,
                "subject": subject,
                "intro": intro,
                "text": text_body,
                "html": html_body,
                "has_attachments": has_attachments,
                "seen": False,
                "is_deleted": False,
                "size": len(raw),
                "created_at": now,
                "updated_at": now,
            }

            db.messages.insert_one(doc)
            logger.info(
                f"Email stored: {from_email} -> {to_addresses} | {subject[:50]}"
            )
            session.rcpt_count = 0
            return "250 Message accepted for delivery"

        except Exception as e:
            logger.error(f"Failed to store email: {e}", exc_info=True)
            session.rcpt_count = 0
            return "451 Requested action aborted: error in processing"


def start_smtp_server():
    """启动 SMTP 服务器 (后台守护线程)"""
    handler = MailHandler()
    controller = Controller(
        handler,
        hostname="0.0.0.0",
        port=SMTP_PORT,
        server_hostname=SMTP_HOSTNAME,
        data_size_limit=10 * 1024 * 1024,  # 10MB
    )
    controller.start()
    logger.info(f"SMTP server started on port {SMTP_PORT}")
    logger.info(f"Accepting mail for domains: {get_active_domains()} (dynamic from DB)")


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=API_PORT, log_level="info")
