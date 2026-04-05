<div align="center">

# ManyMail

**Lightweight self-hosted mail service — one-click deploy, ready to use**

SMTP Receiver &bull; REST API &bull; Web Viewer &bull; IMAP Bridge

[![Python](https://img.shields.io/badge/Python-3.11-3776AB?logo=python&logoColor=white)](https://python.org)
[![FastAPI](https://img.shields.io/badge/FastAPI-009688?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com)
[![Flask](https://img.shields.io/badge/Flask-000000?logo=flask&logoColor=white)](https://flask.palletsprojects.com)
[![Node.js](https://img.shields.io/badge/Node.js-20-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![MongoDB](https://img.shields.io/badge/MongoDB-7-47A248?logo=mongodb&logoColor=white)](https://www.mongodb.com)
[![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white)](https://docs.docker.com/compose/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**[中文文档](README_CN.md)**

---

<img src="docs/screenshot.jpg" alt="ManyMail Screenshot" width="900">

<sub>*All emails shown in the screenshot are for testing purposes only and have no real-world significance.*</sub>

</div>

## Overview

ManyMail is a complete self-hosted mail solution with three core services:

| Service | Stack | Port | Description |
|:--------|:------|:-----|:------------|
| **mail-service** | FastAPI + aiosmtpd | `:25` `:8080` | SMTP receiver + DuckMail-compatible REST API |
| **mail-viewer** | Flask + bleach | `:5000` | Web mail viewer with search, reply & compose |
| **imap-bridge** | Node.js + imapflow | `:3939` | IMAP bridge for Gmail / Outlook / QQ etc. |

<br>

## Architecture

```
    Internet                              Your Server
    ────────                              ───────────
                      ┌──────────────────────────────────────────────┐
                      │                                              │
   Incoming     ──────┤►  mail-service        ┌───────────────┐     │
   Email              │   (FastAPI+aiosmtpd)  │   MongoDB 7   │     │
   (SMTP :25)         │   ┌──────────────┐    │   ┌─────────┐ │     │
                      │   │ SMTP Handler │────┤►  │ accounts│ │     │
                      │   │ REST API     │◄───┤   │ messages│ │     │
                      │   └──────┬───────┘    │   │ domains │ │     │
                      │          │ :8080      └───┴─────────┘─┘     │
                      │          │                                    │
                      │          ▼                                    │
   Browser    ────────┤►  mail-viewer          imap-bridge           │
   (HTTP :5000)       │   (Flask)              (Node.js)             │
                      │   ┌──────────────┐    ┌──────────────┐      │
                      │   │ Inbox View   │    │ Gmail        │      │
                      │   │ Search       │◄───┤ Outlook      │      │
                      │   │ Reply / Send │    │ QQ / 163     │      │
                      │   │ HTML Sanitize│    │ Yahoo / GMX  │      │
                      │   └──────────────┘    └──────────────┘      │
                      │                         :3939                 │
                      └──────────────────────────────────────────────┘
```

<br>

## Quick Start

### 1. Clone & Configure

```bash
git clone https://github.com/margbug01/ManyMail.git
cd ManyMail
cp .env.example .env
```

Edit `.env` with your actual values:

```env
# Mail Service
JWT_SECRET=your-strong-jwt-secret
API_KEY=your-api-key
SMTP_HOSTNAME=mail.yourdomain.com
DOMAINS=yourdomain.com

# Mail Viewer
ACCESS_PASSWORD=your-viewer-password
SECRET_KEY=random-flask-secret
UNIFIED_PASSWORD=shared-mailbox-password
```

### 2. Deploy

```bash
docker compose up -d
```

### 3. Verify

```bash
# Check all services
docker compose ps

# View logs
docker compose logs -f

# Health check
curl http://127.0.0.1:8080/health
```

<br>

## DNS Setup

Add these DNS records for your domain:

```dns
; MX record — tells other mail servers where to deliver
yourdomain.com.       IN  MX   10  mail.yourdomain.com.

; A record — points to your server IP
mail.yourdomain.com.  IN  A        <your-server-ip>

; SPF record (recommended)
yourdomain.com.       IN  TXT      "v=spf1 ip4:<your-server-ip> -all"
```

<br>

## API Reference

> Base URL: `http://127.0.0.1:8080`
>
> Auth: `Authorization: Bearer <token>` (except `/health`, `/token`, `/accounts`)

### Account

```http
POST /accounts              # Create mailbox account
POST /token                 # Login, returns JWT
```

### Messages

```http
GET  /messages              # List inbox (paginated: ?offset=0&limit=30)
GET  /messages/{id}         # Message detail
GET  /messages/search?q=    # Full-text search
PATCH /messages/{id}        # Mark read / delete
GET  /sent                  # Sent messages
```

### System

```http
GET  /health                # Health check (no auth required)
GET  /domains               # Active domain list
```

<details>
<summary><strong>Example: Create account & read inbox</strong></summary>

```bash
# Create account
curl -X POST http://127.0.0.1:8080/accounts \
  -H "Content-Type: application/json" \
  -d '{"address": "user@yourdomain.com", "password": "secret123"}'

# Get token
TOKEN=$(curl -s -X POST http://127.0.0.1:8080/token \
  -H "Content-Type: application/json" \
  -d '{"address": "user@yourdomain.com", "password": "secret123"}' \
  | jq -r '.token')

# List messages
curl http://127.0.0.1:8080/messages \
  -H "Authorization: Bearer $TOKEN"
```

</details>

<br>

## Project Structure

```
ManyMail/
│
├── mail-service/                # SMTP + REST API
│   ├── app.py                   #   FastAPI main app
│   ├── Dockerfile               #   Python 3.11-slim
│   └── requirements.txt         #   fastapi, aiosmtpd, pymongo, jwt, bcrypt
│
├── mail-viewer/                 # Web Mail Viewer
│   ├── app.py                   #   Flask main app
│   ├── Dockerfile               #   Python 3.11-slim + gunicorn
│   ├── requirements.txt         #   flask, bleach, tinycss2
│   ├── templates/
│   │   ├── index.html           #   Inbox UI
│   │   └── login.html           #   Login page
│   └── imap-mail-app/           #   IMAP Bridge (Node.js)
│       ├── server.js            #     Express REST API
│       ├── client.js            #     ImapFlow wrapper
│       ├── config.js            #     Provider presets
│       └── package.json         #     imapflow, mailparser
│
├── docker-compose.yml           # All 4 services orchestration
├── .env.example                 # Environment variable template
├── deploy.sh                    # Deployment script
├── test_smtp.py                 # SMTP tests
└── test_external_smtp.py        # External SMTP tests
```

<br>

## Security

| Layer | Feature |
|:------|:--------|
| **Auth** | JWT tokens (24h expiry) + API Key for admin endpoints |
| **Password** | bcrypt hashing |
| **Rate Limit** | Per-IP throttling on both API and SMTP |
| **SMTP** | IP blacklist / greylist, recipient limits, size limits |
| **Email Render** | HTML sanitization (bleach + CSSSanitizer), iframe sandbox |
| **Network** | Server-side image proxy (prevents IP leakage) |
| **Storage** | Auto-cleanup via MongoDB TTL index (default 3 days) |
| **Web** | Login-protected viewer, HttpOnly session cookies |

<br>

## Tech Stack

<table>
<tr>
<td align="center" width="150"><br><strong>Python 3.11</strong><br>FastAPI &bull; Flask<br><br></td>
<td align="center" width="150"><br><strong>Node.js 20</strong><br>Express &bull; ImapFlow<br><br></td>
<td align="center" width="150"><br><strong>MongoDB 7</strong><br>pymongo<br><br></td>
<td align="center" width="150"><br><strong>Docker</strong><br>Compose<br><br></td>
</tr>
</table>

| Component | Dependencies |
|:----------|:-------------|
| mail-service | `fastapi` `uvicorn` `aiosmtpd` `pymongo` `PyJWT` `bcrypt` |
| mail-viewer | `flask` `gunicorn` `requests` `bleach` `tinycss2` |
| imap-bridge | `express` `imapflow` `mailparser` `dotenv` |

<br>

## License

[MIT](LICENSE)

---

<div align="center">
<sub>Built for self-hosting. Own your email infrastructure.</sub>
</div>
