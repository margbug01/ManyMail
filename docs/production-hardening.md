# Production hardening guide

This guide covers the production controls that require deployment decisions outside the application code.

## Required secrets

Set strong, unique values in `.env` before deploying (`install.sh` generates them):

- `JWT_SECRET`: signs mailbox JWTs.
- `API_KEY`: protects `/admin/*` and the rules API; the IMAP bridge uses it to report new mail.
- `ACCESS_PASSWORD`: the web UI login. Changing it ends every open session.
- `SECRET_KEY`: signs the web UI session cookie and encrypts Resend keys saved in Settings. If it changes, saved keys have to be entered again.
- `UNIFIED_PASSWORD`: default mailbox password used by the web UI.
- `IMAP_ACCOUNT_ENCRYPTION_KEY`: 32+ character key for encrypted external IMAP account persistence. If this is not set, external IMAP accounts are not saved to disk.

With `ENVIRONMENT=production`, `manymail` refuses to start while `JWT_SECRET`, `API_KEY`,
`CORS_ORIGINS`, `SECRET_KEY`, `ACCESS_PASSWORD` or `UNIFIED_PASSWORD` is empty or left at its
default.

## Network exposure

The default Compose file exposes SMTP `25` publicly and binds the REST API `8080` and the
web UI `5000` to `127.0.0.1`; Caddy serves the web UI over HTTPS on `80`/`443`. Keep the API
private (SSH tunnel or internal network) unless you add TLS and authentication at the edge.

- `25/tcp`: inbound mail.
- `80/tcp`, `443/tcp`: Caddy (certificates and the web UI).
- `5000/tcp`, `8080/tcp`, `8090/tcp`: keep private.

The web UI trusts the first `X-Forwarded-For` address for its rate limits. Caddy sets that
header, so do not publish port 5000 directly.

## TLS and DNS

For inbound SMTP STARTTLS, put a certificate and key in `./certs` and set `SMTP_TLS_CERT` and
`SMTP_TLS_KEY`. The container runs as uid 10001, so the key must be readable by that uid
(e.g. `chgrp 10001 privkey.pem && chmod 640 privkey.pem`).

Publish DNS records for production mail:

- `MX` from your receiving domain to `mail.yourdomain.com`.
- `A/AAAA` for `mail.yourdomain.com`.
- `SPF` for the server or sending provider.
- `DKIM` for your sending provider, such as Resend.
- `DMARC`, starting with monitoring/quarantine before reject.

`docker compose exec -T manymail manymail dnscheck` (or `/dns-check` in the web UI) lists
what is missing.

## Account creation and permissions

`AUTO_CREATE_ACCOUNTS` defaults to disabled in production. Leave it disabled unless the web
UI is behind strong access controls and you accept that a web UI user can create mailbox
accounts.

The single `ACCESS_PASSWORD` plus `UNIFIED_PASSWORD` model is convenient, but it is not a
multi-user permission model.

## External IMAP bridge credential storage

The external IMAP bridge never writes plaintext account passwords:

- `IMAP_ACCOUNT_PERSISTENCE=encrypted` with `IMAP_ACCOUNT_ENCRYPTION_KEY`: saves encrypted account data to `ACCOUNTS_FILE`.
- Missing `IMAP_ACCOUNT_ENCRYPTION_KEY`: skips persistence and restores no accounts.
- `IMAP_ACCOUNT_PERSISTENCE=disabled`: disables persistence entirely.

Legacy plaintext `accounts.json` files are refused. Remove them after migrating accounts.

## Mail retention, attachments, and backups

`MESSAGE_TTL_DAYS=3` deletes received messages older than three days (checked every ten
minutes). Set `MESSAGE_TTL_DAYS=0` or `forever` only when you have storage monitoring and
backups.

Messages and attachments live in one SQLite file (`/data/manymail.db` in the `manymail_data`
volume, or the path in `MANYMAIL_DATA`). `SMTP_MAX_MESSAGE_BYTES` (default 10 MB) caps each
message.

Back up:

- The SQLite database. Copy it safely while running with
  `sqlite3 manymail.db ".backup backup.db"`, or stop the container and copy `manymail.db`
  together with its `-wal` file.
- The IMAP bridge volume `imap_mail_data` when persistence is enabled.
- `.env` and TLS certificates through your secret management process, not public source control.

## Operational checks

Before exposing the service:

1. Run the tests: `go test ./...`, `node --test` in `imap-bridge`, `tools/test-ui.sh`.
2. Build: `docker compose build`.
3. Start and confirm `docker compose ps` shows `manymail` as healthy.
4. Run the DNS check above, then send a test message from outside.

## No IMAP server for mail clients

ManyMail 2.x has no IMAP server for Thunderbird or phone mail apps; read mail in the web UI
or through the REST API. The `imap-bridge` container goes the other way: it reads external
mailboxes into the web UI.
