# Production hardening guide
This guide covers the production controls that require deployment decisions outside the application code.
## Required secrets
Set strong, unique values in `.env` before deploying:
- `JWT_SECRET`: signs mailbox JWTs for `mail-service`.
- `API_KEY` and `DUCKMAIL_API_KEY`: protect admin endpoints and viewer-to-service admin calls. In the default Compose setup these should match.
- `ACCESS_PASSWORD`: protects the Web viewer.
- `SECRET_KEY`: protects Flask session cookies.
- `UNIFIED_PASSWORD`: default mailbox password used by the viewer.
- `IMAP_ACCOUNT_ENCRYPTION_KEY`: 32+ character key for encrypted external IMAP account persistence. If this is not set, external IMAP accounts are not saved to disk.
Run `python tools/check_production_config.py` after creating `.env`.
## Network exposure
The default Compose file exposes SMTP `25` and IMAPS `993` publicly, but binds the REST API `8080` and Web viewer `5000` to `127.0.0.1`. Keep API/UI behind a reverse proxy or SSH tunnel unless you have added independent authentication, TLS, and rate limiting at the edge.
Recommended public exposure:
- `25/tcp`: SMTP inbound mail.
- `993/tcp`: IMAPS only when you have real certificates and need desktop/mobile clients.
- `5000/tcp` and `8080/tcp`: keep private; expose through Nginx/Caddy with HTTPS if needed.
## TLS and DNS
For inbound SMTP STARTTLS, mount a certificate/key and set `SMTP_TLS_CERT` and `SMTP_TLS_KEY`. For IMAPS, set `IMAP_CERTS_PATH` to a directory containing `fullchain.pem` and `privkey.pem`.
Publish DNS records for production mail:
- `MX` from your receiving domain to `mail.yourdomain.com`.
- `A/AAAA` for `mail.yourdomain.com`.
- `SPF` for the server or sending provider.
- `DKIM` for your sending provider, such as Resend.
- `DMARC`, starting with monitoring/quarantine before reject.
## Account creation and permissions
`AUTO_CREATE_ACCOUNTS` defaults to disabled in production. Leave it disabled unless the Web viewer is behind strong access controls and you accept that a viewer user can create mailbox accounts.
Use separate operational passwords where possible. The single `ACCESS_PASSWORD` plus `UNIFIED_PASSWORD` model is convenient, but it is not a multi-user permission model.
## External IMAP bridge credential storage
The external IMAP bridge no longer writes plaintext account passwords. Persistence behavior:
- `IMAP_ACCOUNT_PERSISTENCE=encrypted` with `IMAP_ACCOUNT_ENCRYPTION_KEY`: saves encrypted account data to `ACCOUNTS_FILE`.
- Missing `IMAP_ACCOUNT_ENCRYPTION_KEY`: skips persistence and restores no accounts.
- `IMAP_ACCOUNT_PERSISTENCE=disabled`: disables persistence entirely.
Legacy plaintext `accounts.json` files are refused. Remove them after migrating accounts.
## Mail retention, attachments, and backups
`MESSAGE_TTL_DAYS=3` deletes old received messages through MongoDB TTL. Set `MESSAGE_TTL_DAYS=0` or `forever` only when you have storage monitoring and backups.
Attachments are stored inside MongoDB message documents. `SMTP_MAX_MESSAGE_BYTES` defaults to 10 MB, the same as the SMTP server's own data limit; decoded attachments then stay below MongoDB's 16 MB document cap. Do not raise it further without moving attachments to GridFS/object storage, and watch disk usage when `MESSAGE_TTL_DAYS=0` keeps mail forever.
Back up:
- MongoDB volume `mongo_data`.
- IMAP bridge encrypted account volume `imap_mail_data` when persistence is enabled.
- `.env` and TLS certificates through your secret management process, not public source control.
## Operational checks
Before exposing the service:
1. Run `python tools/check_production_config.py`.
2. Run tests and lint: `python -m pytest mail-service/tests mail-viewer/tests`, `python -m ruff check mail-service mail-viewer/app.py tools`.
3. Run Node tests in both Node packages: `npm test` in `mail-viewer/imap-mail-app` and `imap-server`.
4. Build containers: `docker compose build`.
5. Confirm `docker compose ps` health checks pass.
## IMAP compatibility scope
`imap-server` is a lightweight IMAP4rev1 subset. It supports common mailbox listing, selection, fetch, search, flag, copy/move, expunge, and idle flows, but it is not a full replacement for a mature IMAP server. Test your target clients, especially Outlook and mobile clients, before relying on it for production workflows.
