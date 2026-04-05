# Self-Hosted Mail

自建邮箱服务 —— SMTP 收件 + REST API + Web 查看器。

## 架构

```
                    外部邮件
                      │
                      ▼
┌─────────────────────────────────────────┐
│  mail-service (FastAPI + aiosmtpd)      │
│  SMTP :25  |  REST API :8080            │
│  MongoDB 存储 | JWT 鉴权 | 速率限制      │
└──────────────┬──────────────────────────┘
               │ HTTP API
               ▼
┌─────────────────────────────────────────┐
│  mail-viewer (Flask :5000)              │
│  邮件列表/详情/搜索 | HTML 安全渲染      │
│  图片代理 | 发信(Resend) | 登录保护      │
│  ├── imap-mail (Node.js :3939)          │
│  │   IMAP 桥接 Gmail/Outlook/QQ 等      │
└─────────────────────────────────────────┘
```

## 快速开始

```bash
# 1. 复制环境变量
cp .env.example .env
# 编辑 .env 填入实际值

# 2. 启动所有服务
docker compose up -d

# 3. 查看日志
docker compose logs -f
```

服务端口：
- **SMTP**: `25` — 接收外部邮件
- **API**: `127.0.0.1:8080` — REST API (内部)
- **Web**: `127.0.0.1:5000` — 邮件查看器

## DNS 配置

为你的域名添加 MX 记录，指向运行此服务的服务器：

```
yourdomain.com.  MX  10  mail.yourdomain.com.
mail.yourdomain.com.  A  <your-server-ip>
```

## API 端点

### 账户管理
| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/accounts` | 创建邮箱账户 |
| POST | `/token` | 登录获取 JWT |

### 邮件操作
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/messages` | 查询收件箱（分页） |
| GET | `/messages/{id}` | 邮件详情 |
| GET | `/messages/search?q=` | 搜索邮件 |
| PATCH | `/messages/{id}` | 标记已读/删除 |
| GET | `/sent` | 已发送邮件 |

### 系统
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 健康检查 |
| GET | `/domains` | 可用域名列表 |

所有邮件 API 需要 `Authorization: Bearer <token>` 头。

## 目录结构

```
self-hosted-mail/
├── mail-service/          # SMTP + REST API 服务
│   ├── app.py             # FastAPI 主程序 (SMTP + API)
│   ├── Dockerfile
│   └── requirements.txt
├── mail-viewer/           # Web 邮件查看器
│   ├── app.py             # Flask 主程序
│   ├── Dockerfile
│   ├── requirements.txt
│   ├── templates/         # HTML 模板
│   └── imap-mail-app/     # Node.js IMAP 桥接服务
│       ├── server.js
│       ├── client.js
│       ├── config.js      # IMAP 预设配置
│       └── package.json
├── docker-compose.yml     # 统一编排 (MongoDB + 3 服务)
├── .env.example           # 环境变量示例
├── deploy.sh              # 部署脚本
├── test_smtp.py           # SMTP 测试
└── test_external_smtp.py  # 外部 SMTP 测试
```

## 技术栈

- **Mail Service**: Python 3.11 / FastAPI / aiosmtpd / PyJWT / bcrypt
- **Mail Viewer**: Python 3.11 / Flask / bleach (HTML 安全过滤)
- **IMAP Bridge**: Node.js 20 / imapflow / mailparser
- **Database**: MongoDB 7
- **容器化**: Docker Compose

## 安全特性

- JWT Token 鉴权（24h 过期）
- API Key 保护管理端点
- bcrypt 密码哈希
- IP 速率限制（API + SMTP）
- SMTP 黑名单/灰名单
- 邮件 HTML 安全过滤 (bleach + CSSSanitizer)
- 图片服务端代理（防止 IP 泄露）
- iframe sandbox 渲染邮件内容
- 邮件 TTL 自动清理

## License

MIT
