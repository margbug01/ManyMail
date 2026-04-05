<div align="center">

# Self-Hosted Mail

**轻量级自建邮箱服务 —— 一键部署，开箱即用**

**Lightweight self-hosted mail service — one-click deploy, ready to use**

SMTP 收件 &bull; REST API &bull; Web 查看器 &bull; IMAP 桥接

[![Python](https://img.shields.io/badge/Python-3.11-3776AB?logo=python&logoColor=white)](https://python.org)
[![FastAPI](https://img.shields.io/badge/FastAPI-009688?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com)
[![Flask](https://img.shields.io/badge/Flask-000000?logo=flask&logoColor=white)](https://flask.palletsprojects.com)
[![Node.js](https://img.shields.io/badge/Node.js-20-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![MongoDB](https://img.shields.io/badge/MongoDB-7-47A248?logo=mongodb&logoColor=white)](https://www.mongodb.com)
[![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white)](https://docs.docker.com/compose/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

</div>

## 概述 / Overview

Self-Hosted Mail 是一套完整的自建邮箱解决方案，包含三个核心服务：

A complete self-hosted mail solution with three core services:

| 服务 Service | 技术栈 Stack | 端口 Port | 说明 Description |
|:-------------|:-------------|:----------|:-----------------|
| **mail-service** | FastAPI + aiosmtpd | `:25` `:8080` | SMTP 收件 + DuckMail 兼容 REST API<br>SMTP receiver + DuckMail-compatible REST API |
| **mail-viewer** | Flask + bleach | `:5000` | Web 邮件查看器，支持搜索/回复/发信<br>Web mail viewer with search, reply & compose |
| **imap-bridge** | Node.js + imapflow | `:3939` | IMAP 桥接，接入 Gmail / Outlook / QQ 等<br>IMAP bridge for Gmail / Outlook / QQ etc. |

<br>

## 架构 / Architecture

```
    互联网 Internet                    你的服务器 Your Server
    ──────────────                     ──────────────────────
                    ┌──────────────────────────────────────────────┐
   外部邮件          │                                              │
   Incoming   ──────┤►  mail-service        ┌───────────────┐     │
   Email            │   (FastAPI+aiosmtpd)  │   MongoDB 7   │     │
   (SMTP :25)       │   ┌──────────────┐    │   ┌─────────┐ │     │
                    │   │ SMTP 处理器  │────┤►  │ accounts│ │     │
                    │   │ REST API     │◄───┤   │ messages│ │     │
                    │   └──────┬───────┘    │   │ domains │ │     │
                    │          │ :8080      └───┴─────────┘─┘     │
                    │          │                                    │
                    │          ▼                                    │
   浏览器    ───────┤►  mail-viewer          imap-bridge           │
   Browser          │   (Flask)              (Node.js)             │
   (HTTP :5000)     │   ┌──────────────┐    ┌──────────────┐      │
                    │   │ 收件箱视图   │    │ Gmail        │      │
                    │   │ 搜索 Search  │◄───┤ Outlook      │      │
                    │   │ 回复 Reply   │    │ QQ / 163     │      │
                    │   │ HTML 安全过滤│    │ Yahoo / GMX  │      │
                    │   └──────────────┘    └──────────────┘      │
                    │                         :3939                 │
                    └──────────────────────────────────────────────┘
```

<br>

## 快速开始 / Quick Start

### 1. 克隆并配置 / Clone & Configure

```bash
git clone https://github.com/margbug01/self-hosted-mail.git
cd self-hosted-mail
cp .env.example .env
```

编辑 `.env`，填入实际值 / Edit `.env` with your actual values:

```env
# 邮件服务 / Mail Service
JWT_SECRET=your-strong-jwt-secret
API_KEY=your-api-key
SMTP_HOSTNAME=mail.yourdomain.com
DOMAINS=yourdomain.com

# 邮件查看器 / Mail Viewer
ACCESS_PASSWORD=your-viewer-password
SECRET_KEY=random-flask-secret
UNIFIED_PASSWORD=shared-mailbox-password
```

### 2. 部署 / Deploy

```bash
docker compose up -d
```

### 3. 验证 / Verify

```bash
# 检查服务状态 / Check all services
docker compose ps

# 查看日志 / View logs
docker compose logs -f

# 健康检查 / Health check
curl http://127.0.0.1:8080/health
```

<br>

## DNS 配置 / DNS Setup

为你的域名添加以下 DNS 记录 / Add these DNS records for your domain:

```dns
; MX 记录 — 告诉其他邮件服务器投递到哪里
; MX record — tells other mail servers where to deliver
yourdomain.com.       IN  MX   10  mail.yourdomain.com.

; A 记录 — 指向你的服务器 IP
; A record — points to your server IP
mail.yourdomain.com.  IN  A        <your-server-ip>

; SPF 记录（推荐）
; SPF record (recommended)
yourdomain.com.       IN  TXT      "v=spf1 ip4:<your-server-ip> -all"
```

<br>

## API 参考 / API Reference

> 基础地址 Base URL: `http://127.0.0.1:8080`
>
> 认证 Auth: `Authorization: Bearer <token>`（`/health`、`/token`、`/accounts` 除外）

### 账户管理 / Account

```http
POST /accounts              # 创建邮箱账户 / Create mailbox account
POST /token                 # 登录获取 JWT / Login, returns JWT
```

### 邮件操作 / Messages

```http
GET  /messages              # 查询收件箱（分页）/ List inbox (?offset=0&limit=30)
GET  /messages/{id}         # 邮件详情 / Message detail
GET  /messages/search?q=    # 全文搜索 / Full-text search
PATCH /messages/{id}        # 标记已读/删除 / Mark read or delete
GET  /sent                  # 已发送邮件 / Sent messages
```

### 系统 / System

```http
GET  /health                # 健康检查（无需认证）/ Health check (no auth)
GET  /domains               # 可用域名列表 / Active domain list
```

<details>
<summary><strong>示例：创建账户并读取收件箱 / Example: Create account & read inbox</strong></summary>

```bash
# 创建账户 / Create account
curl -X POST http://127.0.0.1:8080/accounts \
  -H "Content-Type: application/json" \
  -d '{"address": "user@yourdomain.com", "password": "secret123"}'

# 获取 Token / Get token
TOKEN=$(curl -s -X POST http://127.0.0.1:8080/token \
  -H "Content-Type: application/json" \
  -d '{"address": "user@yourdomain.com", "password": "secret123"}' \
  | jq -r '.token')

# 查看收件箱 / List messages
curl http://127.0.0.1:8080/messages \
  -H "Authorization: Bearer $TOKEN"
```

</details>

<br>

## 项目结构 / Project Structure

```
self-hosted-mail/
│
├── mail-service/                # SMTP + REST API 服务
│   ├── app.py                   #   FastAPI 主程序 / Main app
│   ├── Dockerfile               #   Python 3.11-slim
│   └── requirements.txt         #   fastapi, aiosmtpd, pymongo, jwt, bcrypt
│
├── mail-viewer/                 # Web 邮件查看器 / Web Mail Viewer
│   ├── app.py                   #   Flask 主程序 / Main app
│   ├── Dockerfile               #   Python 3.11-slim + gunicorn
│   ├── requirements.txt         #   flask, bleach, tinycss2
│   ├── templates/
│   │   ├── index.html           #   收件箱界面 / Inbox UI
│   │   └── login.html           #   登录页面 / Login page
│   └── imap-mail-app/           #   IMAP 桥接服务 / IMAP Bridge (Node.js)
│       ├── server.js            #     Express REST API
│       ├── client.js            #     ImapFlow 封装 / wrapper
│       ├── config.js            #     服务商预设 / Provider presets
│       └── package.json         #     imapflow, mailparser
│
├── docker-compose.yml           # 统一编排 4 个服务 / All 4 services
├── .env.example                 # 环境变量模板 / Environment template
├── deploy.sh                    # 部署脚本 / Deployment script
├── test_smtp.py                 # SMTP 测试 / SMTP tests
└── test_external_smtp.py        # 外部 SMTP 测试 / External SMTP tests
```

<br>

## 安全特性 / Security

| 层级 Layer | 特性 Feature |
|:-----------|:-------------|
| **认证 Auth** | JWT Token 鉴权（24h 过期）+ API Key 保护管理端点<br>JWT tokens (24h expiry) + API Key for admin endpoints |
| **密码 Password** | bcrypt 哈希存储 / bcrypt hashing |
| **速率限制 Rate Limit** | API 和 SMTP 双层 IP 限流<br>Per-IP throttling on both API and SMTP |
| **SMTP** | IP 黑名单/灰名单，收件人数量限制，邮件大小限制<br>IP blacklist/greylist, recipient & size limits |
| **邮件渲染 Render** | HTML 安全过滤 (bleach + CSSSanitizer)，iframe 沙箱<br>HTML sanitization, iframe sandbox |
| **网络 Network** | 服务端图片代理（防止 IP 泄露）<br>Server-side image proxy (prevents IP leakage) |
| **存储 Storage** | MongoDB TTL 索引自动清理（默认 3 天）<br>Auto-cleanup via TTL index (default 3 days) |
| **Web** | 登录保护，HttpOnly Session Cookie<br>Login-protected viewer, HttpOnly session cookies |

<br>

## 技术栈 / Tech Stack

<table>
<tr>
<td align="center" width="150"><br><strong>Python 3.11</strong><br>FastAPI &bull; Flask<br><br></td>
<td align="center" width="150"><br><strong>Node.js 20</strong><br>Express &bull; ImapFlow<br><br></td>
<td align="center" width="150"><br><strong>MongoDB 7</strong><br>pymongo<br><br></td>
<td align="center" width="150"><br><strong>Docker</strong><br>Compose<br><br></td>
</tr>
</table>

| 组件 Component | 依赖 Dependencies |
|:---------------|:-------------------|
| mail-service | `fastapi` `uvicorn` `aiosmtpd` `pymongo` `PyJWT` `bcrypt` |
| mail-viewer | `flask` `gunicorn` `requests` `bleach` `tinycss2` |
| imap-bridge | `express` `imapflow` `mailparser` `dotenv` |

<br>

## 许可证 / License

[MIT](LICENSE)

---

<div align="center">
<sub>为自托管而生，掌控你自己的邮件基础设施。</sub>
<br>
<sub>Built for self-hosting. Own your email infrastructure.</sub>
</div>
