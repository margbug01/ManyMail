# ManyMail

Lightweight self-hosted email server with Docker: SMTP, IMAP, webmail, and REST API. Disposable / temp mail and multi-domain inboxes without Postfix or Mailcow.

<div align="center">

<img src="docs/banner.svg" alt="ManyMail — lightweight self-hosted email server" width="700">

**One `docker compose up` — SMTP receiver, webmail, IMAP, REST API**

[![Python](https://img.shields.io/badge/Python-3.11-3776AB?logo=python&logoColor=white)](https://python.org)
[![FastAPI](https://img.shields.io/badge/FastAPI-009688?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com)
[![Flask](https://img.shields.io/badge/Flask-000000?logo=flask&logoColor=white)](https://flask.palletsprojects.com)
[![Node.js](https://img.shields.io/badge/Node.js-20-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![MongoDB](https://img.shields.io/badge/MongoDB-7-47A248?logo=mongodb&logoColor=white)](https://www.mongodb.com)
[![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white)](https://docs.docker.com/compose/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Stars](https://img.shields.io/github/stars/margbug01/ManyMail?style=flat)](https://github.com/margbug01/ManyMail/stargazers)

**[Website](https://margbug01.github.io/ManyMail/)** · **[中文文档](README_CN.md)**

---

<img src="docs/screenshot.jpg" alt="ManyMail webmail inbox — self-hosted email UI" width="900">

<sub>*All emails shown in the screenshot are for testing purposes only and have no real-world significance.*</sub>

</div>

## Why ManyMail

Mailcow, docker-mailserver and Mail-in-a-Box are full mail platforms. ManyMail is a small Docker stack for **inboxes you host yourself**: verification-code mail, disposable addresses, and a few domains — with a browser UI and an API.

| You want | Use |
|:---------|:----|
| Catch-all / temp addresses on your own domain | ManyMail |
| Webmail + REST API + IMAP, one compose file | ManyMail |
| Small VPS or ARM box, no Postfix/Dovecot | ManyMail |
| Company mail, CalDAV, ActiveSync, Rspamd | Mailcow / docker-mailserver / Mail-in-a-Box |

## Features

- **Self-hosted SMTP** — receive mail for your domain on port 25; a built-in DNS check tells you which MX, SPF and DMARC records are missing
- **Webmail** — search, read, reply, compose; HTML is sanitized before it renders
- **IMAP** — Thunderbird and phone apps; optional bridge for Gmail, Outlook, QQ, 163
- **REST API** — DuckMail-compatible endpoints for scripts and disposable-mail tools
- **Forwarding and push rules** — forward to Gmail/QQ via Resend, push to ntfy, Telegram or a webhook, tag / mark read / trash by recipient, sender or subject, edited on a Rules page; new mail in external IMAP accounts can be pushed too ([docs](docs/mail-router.md))
- **Multi-domain** — more than one domain; prefixes can be created when you need them
- **One-command install** — `install.sh` plus prebuilt amd64 / arm64 images on GHCR; FastAPI + Flask + Node.js + MongoDB in Docker Compose. MIT licensed, data stays on your server

## Overview

Four services in one compose file:

| Service | Stack | Port | Description |
|:--------|:------|:-----|:------------|
| **mail-service** | FastAPI + aiosmtpd | `:25` `:8080` | SMTP receiver + DuckMail-compatible REST API |
| **mail-viewer** | Flask + bleach | `:5000` | Web mail viewer with search, reply & compose |
| **imap-bridge** | Node.js + imapflow | `:3939` | IMAP bridge for Gmail / Outlook / QQ etc. |
| **mail-router** | Python | — | Forwarding and push-notification rules for incoming mail |

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

You need a Linux server (amd64 or arm64) with Docker, a public IPv4 with inbound TCP 25, 80
and 443 open, and a domain whose DNS you control.

```bash
curl -fsSL https://raw.githubusercontent.com/margbug01/ManyMail/master/install.sh | bash
```

The installer asks for your mail domain(s), the host name for the web UI (default
`mail.<domain>`), a password (or generates one) and how long to keep mail. It writes `.env`
with random secrets, pulls the prebuilt images from GHCR (`linux/amd64` and `linux/arm64`),
starts everything, and finishes with a DNS check that prints the records still missing.

Unattended: `MANYMAIL_DOMAINS=example.com ./install.sh --yes`. All options are listed at the
top of [`install.sh`](install.sh).

### Manual setup

```bash
git clone https://github.com/margbug01/ManyMail.git && cd ManyMail
cp .env.example .env     # DOMAINS, SMTP_HOSTNAME, MAIL_WEB_HOST, secrets, ACCESS_PASSWORD
docker compose up -d     # pulls images; add --build to build from this checkout
```

For production, review `docs/production-hardening.md` and run
`python tools/check_production_config.py` after editing `.env`.

### Check

```bash
docker compose ps
docker compose exec -T mail-service python dnscheck.py   # also at https://<web host>/dns-check
curl http://127.0.0.1:8080/health
```

### Update

```bash
git fetch --depth 1 origin tag v1.2.0 && git checkout v1.2.0
sed -i 's/^MANYMAIL_VERSION=.*/MANYMAIL_VERSION=1.2.0/' .env
docker compose pull && docker compose up -d
```

<br>

## DNS Setup

Receiving needs two records; the other two are recommended:

```dns
; Required: where other servers deliver mail, and the host they connect to
yourdomain.com.         IN  MX   10  mail.yourdomain.com.
mail.yourdomain.com.    IN  A        <your-server-ip>

; Recommended: nobody may send as this domain
; (if you send through Resend, publish the SPF record Resend shows instead)
yourdomain.com.         IN  TXT      "v=spf1 -all"

; Recommended: DMARC policy
_dmarc.yourdomain.com.  IN  TXT      "v=DMARC1; p=quarantine; rua=mailto:dmarc@yourdomain.com"
```

ManyMail does not sign outgoing mail, so there is no DKIM key to generate here. Replies and
forwards go out through Resend; add the DKIM and SPF records Resend lists for your domain.

The DNS self-check (`/dns-check` in the web UI, or `dnscheck.py`) looks up MX, the MX host's
address, the web host, SPF and DMARC through public resolvers and prints the exact record
to add for anything missing.

> **STARTTLS**: ManyMail supports STARTTLS. Mount your TLS certificate and key via `docker-compose.yml` and set `SMTP_TLS_CERT` / `SMTP_TLS_KEY` in `.env`. See `.env.example` for details.

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
│   ├── dnscheck.py              #   DNS self-check (MX, SPF, DMARC)
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
├── router/                      # Forwarding / notification rules
│   ├── app.py                   #   Rule loop over new mail
│   ├── rules.py                 #   Matching and validation
│   ├── actions.py               #   forward, ntfy, telegram, webhook, tag, ...
│   └── cli.py                   #   list / add / dry-run / test rules
│
├── docker-compose.yml           # All services (GHCR images, or build from source)
├── install.sh                   # Interactive installer
├── .env.example                 # Environment variable template
└── tools/                       # Ops and manual test scripts
    ├── send_test_smtp.py        #   Send a test mail to local SMTP
    └── send_test_external_smtp.py # Send a test mail via external SMTP
```

<br>

## Security

| Layer | Feature |
|:------|:--------|
| **Auth** | JWT tokens (24h expiry) + API Key for admin endpoints |
| **Password** | bcrypt hashing |
| **Rate Limit** | Per-IP throttling on API, SMTP, viewer login, auto-create, domain admin, mail mutation, and send paths |
| **SMTP** | IP blacklist / greylist, recipient limits, size limits, optional STARTTLS |
| **Email Render** | HTML sanitization (bleach + CSSSanitizer), iframe sandbox |
| **Network** | Server-side image proxy with private-address rejection |
| **Storage** | Auto-cleanup via MongoDB TTL index (default 3 days; set `MESSAGE_TTL_DAYS=0` to keep indefinitely) |
| **External IMAP** | Account persistence is encrypted with `IMAP_ACCOUNT_ENCRYPTION_KEY`; plaintext legacy account files are refused |
| **Web** | Login-protected viewer, HttpOnly session cookies, production-safe auto-create default |

Additional hardening guidance: `docs/production-hardening.md`.

<br>

## Tech Stack

<table>
<tr>
<td align="center" width="150"><br><strong>Python 3.11</strong><br>FastAPI · Flask<br><br></td>
<td align="center" width="150"><br><strong>Node.js 20</strong><br>Express · ImapFlow<br><br></td>
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

## Community

ManyMail appreciates [linux.do](https://linux.do/) — a friendly Chinese tech community where people share ideas, projects, and practical self-hosting experience.

<br>

## Changelog

[CHANGELOG.md](CHANGELOG.md) — see also the [releases](https://github.com/margbug01/ManyMail/releases).

## License

[MIT](LICENSE)

---

<div align="center">
<sub>Built for self-hosting. Own your email infrastructure.</sub>
</div>
