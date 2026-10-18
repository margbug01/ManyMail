# ManyMail

轻量自建邮箱：SMTP 收信、Web 邮箱、转发推送规则和 REST API 全在一个 Go 程序里，数据存 SQLite。用来收验证码、做临时邮箱、挂多个域名，不用装 Postfix / Mailcow。

<div align="center">

<img src="docs/banner.svg" alt="ManyMail — 轻量自建邮箱" width="700">

**一个容器，常驻内存约 10 MB：SMTP 收件、Web 邮箱、规则、REST API**

[![Go](https://img.shields.io/badge/Go-1.27-00ADD8?logo=go&logoColor=white)](https://go.dev)
[![SQLite](https://img.shields.io/badge/SQLite-003B57?logo=sqlite&logoColor=white)](https://sqlite.org)
[![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white)](https://docs.docker.com/compose/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Stars](https://img.shields.io/github/stars/margbug01/ManyMail?style=flat)](https://github.com/margbug01/ManyMail/stargazers)

**[项目主页](https://margbug01.github.io/ManyMail/)** · **[English](README.md)**

---

<img src="docs/screenshot.jpg" alt="ManyMail Web 邮箱收件箱" width="900">

<sub>*截图中的邮件均为测试数据，没有实际意义。*</sub>

</div>

## 它适合谁

Mailcow、docker-mailserver、Mail-in-a-Box 是完整的邮件平台。ManyMail 只做一件小事：**自己托管的收件箱**，收验证码、临时地址、几个域名，配一个网页和一套 API。

| 你想要 | 选 |
|:------|:---|
| 自己域名上的 catch-all / 临时地址 | ManyMail |
| Web 邮箱 + REST API + 转发规则，一个 compose 文件 | ManyMail |
| 小 VPS 或 ARM 机器，不想碰 Postfix/Dovecot | ManyMail |
| 公司邮箱、桌面客户端 IMAP、CalDAV、ActiveSync、Rspamd | Mailcow / docker-mailserver / Mail-in-a-Box |

## 功能

- **自建 SMTP**：25 端口收你域名的信（可选 STARTTLS），自带 DNS 自检，告诉你缺哪条 MX、SPF、DMARC
- **Web 邮箱**：搜索、阅读、回复、写信（经 Resend 发出）；来信 HTML 先清洗再显示，外部图片默认不加载
- **外部邮箱**：可选的桥接服务把 Gmail、Outlook、QQ、163 等 IMAP 邮箱接进同一个网页
- **REST API**：兼容 DuckMail，方便脚本和临时邮箱工具调用
- **转发和推送规则**：经 Resend 转发到 Gmail/QQ，推送到 ntfy、Telegram 或 webhook，按收件人、发件人、主题打标签 / 标已读 / 进回收站；来信即触发，在「规则」页面编辑（[文档](docs/mail-router.md)）
- **多域名**：域名数量不限，邮箱可以用到时再自动创建
- **小**：一个静态二进制（约 15 MB）、一个 SQLite 文件，常驻内存约 10 MB；GHCR 有 amd64 / arm64 预构建镜像。MIT 许可，数据留在你自己的服务器上

## 概述

一个 compose 文件，三个容器：

| 容器 | 技术 | 端口 | 作用 |
|:-----|:-----|:-----|:-----|
| **manymail** | Go + SQLite | `:25` `:8080` `:5000` | SMTP 收信、REST API、Web 邮箱、规则引擎 |
| **imap-bridge** | Node.js + imapflow | `:3939`（内部） | 可选：在网页里看外部 IMAP 邮箱 |
| **caddy** | Caddy 2 | `:80` `:443` | HTTPS，证书自动签发 |

<br>

## 架构

```
    互联网                                你的服务器
    ──────                                ──────────
                      ┌────────────────────────────────────────────────┐
   来信         ──────┤►  manymail（一个 Go 进程）                     │
   (SMTP :25)         │   ┌──────────────┐   ┌───────────────────────┐ │
                      │   │ SMTP 收信    │──►│ SQLite                │ │
                      │   │ 规则引擎     │◄─►│ 邮件、附件、          │ │
                      │   │ REST API     │   │ 账户、规则            │ │
                      │   │ Web 邮箱     │   └───────────────────────┘ │
                      │   └──────▲───────┘                             │
   浏览器    ──► Caddy (HTTPS) ──┘   ▲ 新邮件通知                      │
                      │              │                                 │
                      │   imap-bridge (Node.js) ──► Gmail / Outlook /  │
                      │                             QQ / 163 ...       │
                      └────────────────────────────────────────────────┘
```

<br>

## 快速开始

需要一台装了 Docker 的 Linux 服务器（amd64 或 arm64），公网 IPv4 放行入站 TCP 25、80、443，以及一个能改 DNS 的域名。

```bash
curl -fsSL https://raw.githubusercontent.com/margbug01/ManyMail/master/install.sh | bash
```

安装脚本会问你邮件域名、网页用的主机名（默认 `mail.<域名>`）、登录密码（不填就自动生成）和邮件保留多久，然后写好带随机密钥的 `.env`，从 GHCR 拉预构建镜像（`linux/amd64` 和 `linux/arm64`），全部启动，最后跑一遍 DNS 检查，列出还缺的记录。

无人值守：`MANYMAIL_DOMAINS=example.com ./install.sh --yes`。全部选项写在 [`install.sh`](install.sh) 开头。

### 手动安装

```bash
git clone https://github.com/margbug01/ManyMail.git && cd ManyMail
cp .env.example .env     # DOMAINS、SMTP_HOSTNAME、MAIL_WEB_HOST、各种密钥、ACCESS_PASSWORD
docker compose up -d     # 拉镜像；加 --build 则用当前代码构建
```

生产环境先看 [`docs/production-hardening.md`](docs/production-hardening.md)。`ENVIRONMENT=production` 时，如果还有密钥是默认值，程序会拒绝启动。

### 检查

```bash
docker compose ps
docker compose exec -T manymail manymail dnscheck   # 网页上也有：https://<网页主机名>/dns-check
curl http://127.0.0.1:8080/health
```

### 升级

```bash
git fetch --depth 1 origin tag vX.Y.Z && git checkout vX.Y.Z
sed -i 's/^MANYMAIL_VERSION=.*/MANYMAIL_VERSION=X.Y.Z/' .env
docker compose pull && docker compose up -d
```

### 从 1.x（MongoDB 版）升级

2.0 用一个 Go 程序加 SQLite 替换了原来的 Python 服务和 MongoDB，`.env` 不用改。**拉新版本之前**，趁 MongoDB 还在跑，先把数据导出来：

```bash
mkdir -p export
for c in domains accounts messages sent_messages sender_keys routing_rules routing_events; do
  docker compose exec -T mongodb mongoexport --quiet --db mailserver --collection "$c" > "export/$c.json"
done
git pull                                   # 或切到 2.x 的 tag
docker compose run --rm -v "$PWD/export:/export:ro" manymail import /export
docker compose up -d --remove-orphans      # 顺带删掉旧的 mail-service、mail-viewer、router、imap-server、mongodb
```

邮件 id、邮箱密码、网页上保存的 Resend key 和规则都会带过来，导入的旧邮件不会被再次转发。2.x 不再提供给桌面客户端用的 IMAP 服务（993 端口）。确认没问题后，用 `docker volume rm` 删掉旧的 MongoDB 数据卷。

<br>

## DNS 配置

收信必须两条，另外两条建议加：

```dns
; 必需：别的服务器往哪投递，以及要连的主机
yourdomain.com.         IN  MX   10  mail.yourdomain.com.
mail.yourdomain.com.    IN  A        <服务器 IP>

; 建议：不允许任何人以这个域名发信
; （如果经 Resend 发信，改用 Resend 后台给的 SPF 记录）
yourdomain.com.         IN  TXT      "v=spf1 -all"

; 建议：DMARC 策略
_dmarc.yourdomain.com.  IN  TXT      "v=DMARC1; p=quarantine; rua=mailto:dmarc@yourdomain.com"
```

ManyMail 自己不签名外发邮件，所以这里没有 DKIM 密钥要生成。回复和转发都经 Resend 发出，按 Resend 给你域名列出的 DKIM 和 SPF 记录配置即可。

DNS 自检（网页上的 `/dns-check`，或 `manymail dnscheck`）通过公共 DNS 查 MX、MX 主机地址、网页主机名、SPF 和 DMARC，缺什么就直接打印要加的那条记录。

> **STARTTLS**：把证书和私钥放进 `./certs`（只读挂载），在 `.env` 里设置 `SMTP_TLS_CERT` / `SMTP_TLS_KEY`，见 `.env.example`。

<br>

## API 参考

> 地址：`http://127.0.0.1:8080`
>
> 认证：邮箱接口用 `Authorization: Bearer <token>`；`/admin/*` 用 `X-API-Key: <API_KEY>`

### 账户管理

```http
POST /accounts                              # 创建邮箱
POST /token                                 # 登录，返回 JWT（24 小时）
```

### 邮件操作

```http
GET    /messages                            # 收件箱（分页：?offset=0&limit=30）
GET    /messages/{id}                       # 邮件详情，同时标为已读
GET    /messages/{id}/attachments/{aid}     # 下载附件
GET    /messages/search?q=                  # 按主题、发件人、正文搜索
DELETE /messages/{id}                       # 移到回收站
GET    /messages/trash                      # 回收站
POST   /messages/{id}/restore               # 从回收站恢复
DELETE /messages/{id}/permanent             # 彻底删除
POST   /messages/batch                      # {"action": "delete|mark_read|restore|permanent_delete", "ids": [...]}
GET    /sent                                # 已发送
```

### 系统接口

```http
GET  /health                                # 健康检查（无需认证）
GET  /domains                               # 可用域名
GET  /admin/domains · POST · DELETE /{d}    # 管理域名（API key）
GET  /admin/dns-check                       # DNS 自检（API key）
```

规则接口（列出、编辑、试运行、测试推送）在 `/router/*`，用 API key 认证，见 [docs/mail-router.md](docs/mail-router.md)。

<details>
<summary><strong>示例：创建邮箱并查看收件箱</strong></summary>

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
├── main.go                 # 读取配置（.env）并启动；子命令 manymail import / manymail dnscheck
├── smtpd.go, parse.go      # SMTP 收信和 MIME 解析
├── store.go, routestore.go # SQLite 表结构和查询
├── api.go                  # DuckMail 兼容 REST API
├── viewer.go, sanitize.go  # Web 邮箱、HTML 清洗、图片代理、经 Resend 发信
├── rules.go, router.go     # 转发 / 推送规则和规则接口
├── dnscheck.go             # MX / SPF / DMARC 自检
├── migrate.go              # 从 1.x 的 MongoDB 导出导入
├── web/                    # 页面模板和前端文件，编译进二进制
├── imap-bridge/            # 可选的 Node.js 外部 IMAP 邮箱桥接
├── i18n/                   # 界面翻译（tools/build-i18n.cjs 打包）
├── Dockerfile              # 两阶段构建 → alpine，以 uid 10001 运行
├── docker-compose.yml      # manymail + imap-bridge + caddy
├── install.sh              # 交互式安装脚本
└── tools/                  # 界面测试、部署脚本、测试发信
```

<br>

## 安全特性

| 层面 | 措施 |
|:-----|:-----|
| **认证** | JWT（24 小时过期）+ 管理接口用 API key |
| **密码** | bcrypt 哈希 |
| **限流** | API、SMTP、网页登录、自动建号、域名管理、改邮件、发信都按 IP 限流 |
| **SMTP** | IP / 发件人黑名单、灰名单、收件人数和大小限制、可选 STARTTLS、自动回复防回环 |
| **邮件渲染** | 白名单式 HTML/CSS 清洗、沙箱 iframe、外部图片点了才加载 |
| **网络** | 图片代理对每次连接和每次跳转都检查，拒绝内网地址 |
| **存储** | 单个 SQLite 文件；可按 `MESSAGE_TTL_DAYS` 自动清理（默认 3 天，`0` 表示永久保存） |
| **外部 IMAP** | 保存的账户用 `IMAP_ACCOUNT_ENCRYPTION_KEY` 加密 |
| **网页** | 需登录、HttpOnly 会话 Cookie、接口只收 JSON、改 `ACCESS_PASSWORD` 会让所有会话失效 |

更多加固建议见 [`docs/production-hardening.md`](docs/production-hardening.md)。

<br>

## 技术栈

| 组件 | 用到的东西 |
|:-----|:-----------|
| manymail | Go 1.27 · `emersion/go-smtp` · `modernc.org/sqlite`（纯 Go，无 cgo）· `golang.org/x/net/html` · `x/crypto/bcrypt` |
| imap-bridge | Node.js 20 · `express` · `imapflow` · `mailparser` |
| HTTPS | Caddy 2 |

<br>

## 社区

感谢 [linux.do](https://linux.do/)：一个友善的中文技术社区，大家在这里分享想法、项目和自建服务的经验。

<br>

## 更新日志

[CHANGELOG.md](CHANGELOG.md)，另见 [releases](https://github.com/margbug01/ManyMail/releases)。

## 许可证

[MIT](LICENSE)

---

<div align="center">
<sub>为自建而生，掌握你自己的邮件基础设施。</sub>
</div>
