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

**[English](README.md)**

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

- **自建 SMTP** — 域名 25 端口收信；自带 DNS 自检，缺哪条 MX、SPF、DMARC 记录直接告诉你
- **Web 邮箱** — 搜索、阅读、回复、发信；渲染前做 HTML 过滤
- **IMAP** — Thunderbird、手机邮件 App；也可桥接 Gmail / Outlook / QQ / 163
- **REST API** — 兼容 DuckMail 的接口，方便脚本和临时邮箱工具
- **转发与推送规则** — 按收件人、发件人、主题匹配，经 Resend 转发到 Gmail/QQ，推送到 ntfy、Telegram 或 webhook，也能打标签、标已读、丢垃圾箱（[文档](docs/mail-router.md)）
- **多域名** — 可挂多个域名，前缀按需创建
- **一条命令安装** — `install.sh` 加上 GHCR 上的 amd64 / arm64 预构建镜像；FastAPI + Flask + Node.js + MongoDB 跑在 Docker Compose 里。MIT 协议，邮件留在你自己的服务器上

## 概述

一份 compose 里四个服务：

| 服务 | 技术栈 | 端口 | 说明 |
|:-----|:-------|:-----|:-----|
| **mail-service** | FastAPI + aiosmtpd | `:25` `:8080` | SMTP 收件 + DuckMail 兼容 REST API |
| **mail-viewer** | Flask + bleach | `:5000` | Web 邮件查看器，支持搜索、回复、发信 |
| **imap-bridge** | Node.js + imapflow | `:3939` | IMAP 桥接，接入 Gmail / Outlook / QQ 等 |
| **mail-router** | Python | — | 新邮件的转发与推送规则 |

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

需要一台装了 Docker 的 Linux 服务器（amd64 或 arm64）、一个公网 IPv4（入站 TCP 25、80、443
放行），以及一个能改 DNS 的域名。

```bash
curl -fsSL https://raw.githubusercontent.com/margbug01/ManyMail/master/install.sh | bash
```

安装脚本会问邮件域名、网页用的主机名（默认 `mail.<域名>`）、登录密码（留空自动生成）和邮件保留天数，
然后用随机密钥写好 `.env`，从 GHCR 拉预构建镜像（`linux/amd64` 和 `linux/arm64`），启动全部服务，
最后跑一遍 DNS 自检，把还缺的记录打印出来。

无人值守：`MANYMAIL_DOMAINS=example.com ./install.sh --yes`，全部选项见
[`install.sh`](install.sh) 开头。

### 手动安装

```bash
git clone https://github.com/margbug01/ManyMail.git && cd ManyMail
cp .env.example .env     # 填 DOMAINS、SMTP_HOSTNAME、MAIL_WEB_HOST、各项密钥和 ACCESS_PASSWORD
docker compose up -d     # 拉镜像；加 --build 则从当前源码构建
```

生产环境请看 `docs/production-hardening.md`，改完 `.env` 后跑一下
`python tools/check_production_config.py`。

### 检查

```bash
docker compose ps
docker compose exec -T mail-service python dnscheck.py   # 网页里也有：https://<网页主机名>/dns-check
curl http://127.0.0.1:8080/health
```

### 升级

```bash
git fetch --depth 1 origin tag v1.2.0 && git checkout v1.2.0
sed -i 's/^MANYMAIL_VERSION=.*/MANYMAIL_VERSION=1.2.0/' .env
docker compose pull && docker compose up -d
```

<br>

## DNS 配置

收信只需要前两条，后两条建议加上：

```dns
; 必需：别的邮件服务器往哪投递，以及它连接的主机
yourdomain.com.         IN  MX   10  mail.yourdomain.com.
mail.yourdomain.com.    IN  A        <服务器 IP>

; 建议：声明没有任何服务器可以用这个域名发信
; （如果通过 Resend 发信，改用 Resend 后台给出的 SPF 记录）
yourdomain.com.         IN  TXT      "v=spf1 -all"

; 建议：DMARC 策略
_dmarc.yourdomain.com.  IN  TXT      "v=DMARC1; p=quarantine; rua=mailto:dmarc@yourdomain.com"
```

ManyMail 自己不给外发邮件签名，所以这里没有 DKIM 密钥要生成。回复和转发经 Resend 发出，
按 Resend 后台列出的 DKIM、SPF 记录配置即可。

DNS 自检（网页里的 `/dns-check`，或 `dnscheck.py`）通过公共 DNS 查询 MX、MX 主机地址、网页主机名、
SPF 和 DMARC，缺什么就给出可以直接照抄的记录。

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
│   ├── dnscheck.py              #   DNS 自检（MX、SPF、DMARC）
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
├── router/                      # 转发 / 推送规则
│   ├── app.py                   #   新邮件规则循环
│   ├── rules.py                 #   匹配与校验
│   ├── actions.py               #   forward、ntfy、telegram、webhook、tag 等动作
│   └── cli.py                   #   规则的增删、试运行、测试推送
│
├── docker-compose.yml           # 编排全部服务（GHCR 镜像或本地构建）
├── install.sh                   # 交互式安装脚本
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
