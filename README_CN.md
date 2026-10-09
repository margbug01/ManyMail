# ManyMail

轻量自建邮箱，Docker 一键部署：SMTP 收信、IMAP、Web 邮箱、REST API。用来收验证码、做临时邮箱、挂多个域名，不用装 Postfix / Mailcow。

<div align="center">

<img src="docs/banner.svg" alt="ManyMail — 轻量自建邮箱" width="700">

**一条 `docker compose up`：SMTP 收件、Web 邮箱、IMAP、REST API**

[![Python](https://img.shields.io/badge/Python-3.11-3776AB?logo=python&logoColor=white)](https://python.org)
[![FastAPI](https://img.shields.io/badge/FastAPI-009688?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com)
[![Flask](https://img.shields.io/badge/Flask-000000?logo=flask&logoColor=white)](https://flask.palletsprojects.com)
[![Node.js](https://img.shields.io/badge/Node.js-20-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![MongoDB](https://img.shields.io/badge/MongoDB-7-47A248?logo=mongodb&logoColor=white)](https://www.mongodb.com)
[![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white)](https://docs.docker.com/compose/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Stars](https://img.shields.io/github/stars/margbug01/ManyMail?style=flat)](https://github.com/margbug01/ManyMail/stargazers)

**[English](README.md)** · **[linux.do 介绍稿](docs/linuxdo-post.md)**

---

<img src="docs/screenshot.jpg" alt="ManyMail Web 邮箱收件箱截图" width="900">

<sub>*截图中所有邮件均为测试邮件，无实际意义。*</sub>

</div>

## 它适合谁

Mailcow、docker-mailserver 是完整的邮局方案。ManyMail 是一套很小的 Docker 栈，给**自己托管的收件箱**用：验证码、临时邮箱、几个域名，带网页和 API。

| 你想要 | 用 |
|:-------|:---|
| 自己域名上的 catch-all / 临时地址 | ManyMail |
| Web 邮箱 + REST API + IMAP，一份 compose | ManyMail |
| 小 VPS / ARM 小鸡，不想碰 Postfix、Dovecot | ManyMail |
| 公司邮箱、日历、ActiveSync、专业反垃圾 | Mailcow / docker-mailserver |

## 功能

- **自建 SMTP** — 域名 25 端口收信；文档里写了 MX、SPF、DKIM、DMARC
- **Web 邮箱** — 搜索、阅读、回复、发信；渲染前做 HTML 过滤
- **IMAP** — Thunderbird、手机邮件 App；也可桥接 Gmail / Outlook / QQ / 163
- **REST API** — 兼容 DuckMail 的接口，方便脚本和临时邮箱工具
- **多域名** — 可挂多个域名，前缀按需创建
- **Docker Compose** — FastAPI + Flask + IMAP + MongoDB。MIT 协议，邮件留在你自己的服务器上

## 概述

一份 compose 里三个服务：

| 服务 | 技术栈 | 端口 | 说明 |
|:-----|:-------|:-----|:-----|
| **mail-service** | FastAPI + aiosmtpd | `:25` `:8080` | SMTP 收件 + DuckMail 兼容 REST API |
| **mail-viewer** | Flask + bleach | `:5000` | Web 邮件查看器，支持搜索、回复、发信 |
| **imap-bridge** | Node.js + imapflow | `:3939` | IMAP 桥接，接入 Gmail / Outlook / QQ 等 |

<br>

## 架构

```
    互联网                                 你的服务器
    ──────                                 ──────────
                      ┌──────────────────────────────────────────────┐
                      │                                              │
   外部邮件     ──────┤►  mail-service        ┌───────────────┐     │
   (SMTP :25)         │   (FastAPI+aiosmtpd)  │   MongoDB 7   │     │
                      │   ┌──────────────┐    │   ┌─────────┐ │     │
                      │   │ SMTP 处理器  │────┤►  │ accounts│ │     │
                      │   │ REST API     │◄───┤   │ messages│ │     │
                      │   └──────┬───────┘    │   │ domains │ │     │
                      │          │ :8080      └───┴─────────┘─┘     │
                      │          │                                    │
                      │          ▼                                    │
   浏览器      ───────┤►  mail-viewer          imap-bridge           │
   (HTTP :5000)       │   (Flask)              (Node.js)             │
                      │   ┌──────────────┐    ┌──────────────┐      │
                      │   │ 收件箱视图   │    │ Gmail        │      │
                      │   │ 搜索         │◄───┤ Outlook      │      │
                      │   │ 回复 / 发信  │    │ QQ / 163     │      │
                      │   │ HTML 安全过滤│    │ Yahoo / GMX  │      │
                      │   └──────────────┘    └──────────────┘      │
                      │                         :3939                 │
                      └──────────────────────────────────────────────┘
```

<br>

## 快速开始

### 1. 克隆并配置

```bash
git clone https://github.com/margbug01/ManyMail.git
cd ManyMail
cp .env.example .env
```

编辑 `.env`，填入实际值：

```env
# 邮件服务
JWT_SECRET=你的JWT密钥
API_KEY=你的API密钥
SMTP_HOSTNAME=mail.yourdomain.com
DOMAINS=yourdomain.com

# 邮件查看器
ACCESS_PASSWORD=查看器登录密码
SECRET_KEY=Flask会话密钥
UNIFIED_PASSWORD=邮箱统一密码
AUTO_CREATE_ACCOUNTS=0

# 可选：外部 IMAP 桥接账户加密持久化
IMAP_ACCOUNT_PERSISTENCE=encrypted
IMAP_ACCOUNT_ENCRYPTION_KEY=请使用32位以上强随机密钥
```

生产部署前请阅读 `docs/production-hardening.md`，并在编辑 `.env` 后运行配置自检：

```bash
python tools/check_production_config.py
```

### 2. 部署

```bash
docker compose up -d
```

### 3. 验证

```bash
# 检查服务状态
docker compose ps

# 查看日志
docker compose logs -f

# 健康检查
curl http://127.0.0.1:8080/health
```

<br>

## DNS 配置

为你的域名添加以下 DNS 记录：

```dns
; MX 记录 — 告诉其他邮件服务器投递到哪里
yourdomain.com.       IN  MX   10  mail.yourdomain.com.

; A 记录 — 指向你的服务器 IP
mail.yourdomain.com.  IN  A        <你的服务器IP>

; SPF 记录 — 声明哪些 IP 可以代表你的域名发信
yourdomain.com.       IN  TXT      "v=spf1 ip4:<你的服务器IP> -all"

; DKIM 记录 — 邮件签名验证（需先生成密钥对）
default._domainkey.yourdomain.com.  IN  TXT  "v=DKIM1; k=rsa; p=<你的公钥>"

; DMARC 记录 — SPF/DKIM 验证失败时的处理策略
_dmarc.yourdomain.com.  IN  TXT  "v=DMARC1; p=quarantine; rua=mailto:dmarc@yourdomain.com"
```

> **STARTTLS**：ManyMail 支持 STARTTLS 加密传输。在 `docker-compose.yml` 中挂载 TLS 证书，并在 `.env` 中设置 `SMTP_TLS_CERT` / `SMTP_TLS_KEY`。详见 `.env.example`。

<br>

## API 参考

> 基础地址：`http://127.0.0.1:8080`
>
> 认证方式：`Authorization: Bearer <token>`（`/health`、`/token`、`/accounts` 除外）

### 账户管理

```http
POST /accounts              # 创建邮箱账户
POST /token                 # 登录获取 JWT Token
```

### 邮件操作

```http
GET  /messages              # 查询收件箱（分页：?offset=0&limit=30）
GET  /messages/{id}         # 获取邮件详情
GET  /messages/search?q=    # 全文搜索
PATCH /messages/{id}        # 标记已读 / 删除
GET  /sent                  # 已发送邮件列表
```

### 系统接口

```http
GET  /health                # 健康检查（无需认证）
GET  /domains               # 可用域名列表
```

<details>
<summary><strong>示例：创建账户并读取收件箱</strong></summary>

```bash
# 创建账户
curl -X POST http://127.0.0.1:8080/accounts \
  -H "Content-Type: application/json" \
  -d '{"address": "user@yourdomain.com", "password": "secret123"}'

# 获取 Token
TOKEN=$(curl -s -X POST http://127.0.0.1:8080/token \
  -H "Content-Type: application/json" \
  -d '{"address": "user@yourdomain.com", "password": "secret123"}' \
  | jq -r '.token')

# 查看收件箱
curl http://127.0.0.1:8080/messages \
  -H "Authorization: Bearer $TOKEN"
```

</details>

<br>

## 项目结构

```
ManyMail/
│
├── mail-service/                # SMTP + REST API 服务
│   ├── app.py                   #   FastAPI 主程序
│   ├── Dockerfile               #   Python 3.11-slim
│   └── requirements.txt         #   fastapi, aiosmtpd, pymongo, jwt, bcrypt
│
├── mail-viewer/                 # Web 邮件查看器
│   ├── app.py                   #   Flask 主程序
│   ├── Dockerfile               #   Python 3.11-slim + gunicorn
│   ├── requirements.txt         #   flask, bleach, tinycss2
│   ├── templates/
│   │   ├── index.html           #   收件箱界面
│   │   └── login.html           #   登录页面
│   └── imap-mail-app/           #   IMAP 桥接服务 (Node.js)
│       ├── server.js            #     Express REST API
│       ├── client.js            #     ImapFlow 封装
│       ├── config.js            #     邮件服务商预设配置
│       └── package.json         #     imapflow, mailparser
│
├── docker-compose.yml           # 统一编排 4 个服务
├── .env.example                 # 环境变量模板
└── tools/                       # 运维与手动测试脚本
    ├── send_test_smtp.py        #   向本地 SMTP 发测试邮件
    └── send_test_external_smtp.py # 通过外部 SMTP 发测试邮件
```

<br>

## 安全特性

| 层级 | 特性 |
|:-----|:-----|
| **认证** | JWT Token 鉴权（24h 自动过期）+ API Key 保护管理端点 |
| **密码** | bcrypt 哈希存储，不可逆 |
| **速率限制** | API、SMTP、查看器登录、自动创建、域名管理、邮件变更和发信路径限流 |
| **SMTP 防护** | IP 黑名单 / 灰名单，收件人数量限制，邮件大小限制，可选 STARTTLS |
| **邮件渲染** | HTML 安全过滤 (bleach + CSSSanitizer)，iframe 沙箱隔离 |
| **网络安全** | 服务端图片代理，并拒绝代理内网/本机地址 |
| **数据清理** | MongoDB TTL 索引自动清理过期邮件（默认 3 天；设置 `MESSAGE_TTL_DAYS=0` 可永久保存） |
| **外部 IMAP** | 账户持久化使用 `IMAP_ACCOUNT_ENCRYPTION_KEY` 加密；拒绝恢复旧版明文账户文件 |
| **访问控制** | 查看器登录保护，HttpOnly Session Cookie，生产默认关闭自动创建邮箱 |

更多生产硬化建议见 `docs/production-hardening.md`。

<br>

## 技术栈

<table>
<tr>
<td align="center" width="150"><br><strong>Python 3.11</strong><br>FastAPI · Flask<br><br></td>
<td align="center" width="150"><br><strong>Node.js 20</strong><br>Express · ImapFlow<br><br></td>
<td align="center" width="150"><br><strong>MongoDB 7</strong><br>pymongo<br><br></td>
<td align="center" width="150"><br><strong>Docker</strong><br>Compose<br><br></td>
</tr>
</table>

| 组件 | 依赖 |
|:-----|:-----|
| mail-service | `fastapi` `uvicorn` `aiosmtpd` `pymongo` `PyJWT` `bcrypt` |
| mail-viewer | `flask` `gunicorn` `requests` `bleach` `tinycss2` |
| imap-bridge | `express` `imapflow` `mailparser` `dotenv` |

<br>

## 社区

ManyMail 感谢 [linux.do](https://linux.do/) 社区。这里有很多真实、友好的技术分享，也给了这个项目不少自托管和产品体验方面的启发。

<br>

## 许可证

[MIT](LICENSE)

---

<div align="center">
<sub>为自托管而生，掌控你自己的邮件基础设施。</sub>
</div>
