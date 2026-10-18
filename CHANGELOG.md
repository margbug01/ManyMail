# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed — 2.0: one Go binary instead of four services

- `mail-service`, `mail-viewer`, `mail-router` and MongoDB are replaced by a single Go
  program (`manymail`) with SQLite: SMTP on 25, REST API on 8080, web UI on 5000, rules
  engine inside. Same environment variables, same DuckMail-compatible API, same web UI;
  existing JWTs, bcrypt password hashes and saved Resend keys keep working. On the
  maintainer's server memory use dropped from about 575 MB to about 10 MB
- Rules run the moment a message is stored instead of every 5 seconds, and their state is
  saved after each action, so a restart never repeats one that already went out
- `manymail import <dir>` loads a `mongoexport` of a 1.x installation (see the README);
  `manymail dnscheck` replaces `dnscheck.py`
- Repository layout: the Go code is at the root, the IMAP bridge moved to `imap-bridge/`,
  translations to `i18n/`

### Removed

- The IMAP server for desktop and phone clients (`imap-server`, port 993)
- `router/cli.py` (the Rules page and the rules API cover it) and
  `tools/check_production_config.py` (the server checks its own configuration)

### Fixed

- Resend keys saved on the Settings page were shown as in use but never used for sending
- A message nesting attached messages thousands deep took minutes of CPU to parse

### Added

- Seven more interface languages: Traditional Chinese, Japanese, Korean, Spanish, French,
  German and Russian, picked from a menu behind the language button (also on the login page).
  Dates follow the language, IMAP folder names are translated, and without a saved choice
  the browser language is used (falling back to English)
- `tools/test-i18n.cjs` fails when a page gains a string that a translation lacks;
  translations live in `i18n/*.json` and `tools/build-i18n.cjs` bundles them
  into the shared `i18n.js`

### Fixed

- Switching language left the open message's buttons and field labels in the old language
  until another message was opened
- The message list header no longer wraps in languages with longer labels
- The "External images blocked" button above a message only knew Chinese and English and
  kept its old language after switching
- Switching IMAP accounts moved the left-hand highlight only after the account list was
  fetched again, a beat after the mail list had already changed
- On desktop the mail columns ran 24px past the bottom of the window (bottom border cut off)
  and ended lower than the IMAP view; both now share one bottom gap and line up
- A blank area grew under the message body every time it was refitted (images loading,
  resizing, phone rotation or the address bar collapsing); wide messages scaled to fit
  the column now shrink from the top-left instead of the centre

## [1.3.0] - 2026-10-13

Forwarding and push rules get a page in the webmail, new mail in external IMAP accounts can
be pushed to your phone, and each sending domain can have its own Resend key set from
Settings. No breaking changes.

### Added

- Rules page in the webmail (`/rules`, linked from Settings): list, create, edit, enable /
  disable and delete routing rules, dry-run a draft against the last 100 messages, send a
  test push, and see recently routed mail. Rules from `.env` are shown read-only
- mail-router serves a JSON API on port 8090 inside the compose network (`X-API-Key`),
  which the webmail proxies after login; the CLI and the API share the same code
- Push notifications for new mail in external IMAP accounts: the IMAP bridge reports the
  sender and subject of each new INBOX message to mail-router, and rules with
  `"source": ["imap"]` push them through ntfy, Telegram or a webhook
- Resend keys per sending domain in Settings: paste a key next to each domain; it is checked
  against Resend (full or sending-only access) before saving, encrypted with a key derived
  from `SECRET_KEY`, stored by mail-service as ciphertext, and shown only as `re_…1234`.
  Sending uses it ahead of `RESEND_API_KEY_*` / `RESEND_API_KEY` from `.env`. Every domain
  shows the masked key it currently sends with and where it comes from

### Changed

- Rules match only mail received here unless their `source` includes `imap`, so existing
  rules behave as before

## [1.2.0] - 2026-10-13

Self-hosting gets a one-command installer and prebuilt images, and incoming mail can now be
forwarded and pushed to your phone by rules. No breaking changes; the old forwarder
variables keep working.

### Added

- `install.sh`: checks Docker and ports 25/80/443, asks for domain, web host, password and
  mail retention, writes `.env` with random secrets, starts the stack and runs a DNS check.
  Works through `curl | bash` and unattended with `--yes` and `MANYMAIL_*` variables
- Multi-arch images (`linux/amd64`, `linux/arm64`) on GHCR for mail-service, mail-viewer,
  the IMAP bridge and mail-router, published on every release tag. Compose pulls them and
  falls back to building from source; `MANYMAIL_VERSION` pins the tag
- DNS self-check (`mail-service/dnscheck.py`, `GET /admin/dns-check`, and a `/dns-check`
  page linked from the settings dialog): MX, the MX host's address, web host, SPF, DMARC and
  PTR, with the exact record to add for anything missing
- `mail-router` with forwarding and push-notification rules: match on recipient / sender
  globs, subject, body, or attachments; forward through Resend, push to ntfy, Telegram or
  a signed webhook, tag, mark read, or trash. Per-action retry with backoff, a CLI for
  listing, adding, dry-running, and testing rules. See `docs/mail-router.md`.

### Changed

- `mail-router` replaces `mail-forwarder` and `mail-paypal-forwarder`; the `FORWARD_*` and
  `PAYPAL_FORWARD_*` variables become rules. The hard-coded forward subject prefix is now
  `FORWARD_SUBJECT_PREFIX` / `PAYPAL_FORWARD_SUBJECT_PREFIX` (empty by default).
- The SMTP loop guard also treats every forward target in the router rules as a
  forwarding address.
- README quick start and DNS setup rewritten around the installer; the DKIM instructions
  were removed because ManyMail does not sign outgoing mail (Resend does)
- Shell scripts are linted with ShellCheck in CI and kept at LF line endings

## [1.1.0] - 2026-10-13

Mostly IMAP and webmail work: faster account switching, live inbox updates, a reworked
mobile layout, and tighter tracking protection. No breaking changes.

### Added

- IMAP server auto-detection from the email address (built-in presets, Thunderbird ISPDB,
  MX provider lookup, then a TLS probe of `imap.` / `mail.` hosts)
- Live inbox updates in the IMAP view: a read-only IDLE watcher bumps a version counter,
  the page polls `/api/changes` and refreshes quietly when something arrives or is deleted
- Reloading the page restores the open tab, mailbox, folder, and message (both the webmail
  and the IMAP view)
- Copy-address button on the recent-mailbox pills
- Link cleanup in mail bodies: tracking parameters (`utm_*`, `fbclid`, `gclid`, …) are
  stripped and redirect wrappers (Google, Outlook Safe Links, Facebook, LinkedIn) are
  unwrapped; the link title shows the real target
- `tools/deploy-prod.sh` deploys `master` to production, with a UI test gate
  (`tools/test-ui.sh`, Playwright) and `npm test` inside the rebuilt IMAP container

### Changed

- IMAP account and folder switching is much faster: folder lists are cached and refreshed
  in the background on a separate stats connection, message lists render from a session
  cache first, other accounts' inboxes are prefetched
- Saved IMAP accounts are restored in parallel at startup (about 16 s down to 3 s); an
  account whose login fails is no longer removed from `accounts.json`
- Navigation reworked: the navbar switches between Mail and IMAP, folder buttons live in
  the list header; the IMAP page is redesigned for reading density
- Mobile layout: compact navbar, short timestamps, icon-only actions, fullscreen compose,
  message-first IMAP layout; iOS Safari no longer tints the bottom toolbar black
- Column headers stay on one row in narrow windows (container queries collapse folder
  tabs to icons)
- Unified thin scrollbars that only show on hover or while scrolling
- Front-end split into separate CSS / JS files with content-hashed URLs; the IMAP page is
  split the same way and the proxy forwards ETag / 304
- Message size limit is 10 MB (`SMTP_MAX_MESSAGE_BYTES`) in both the SMTP server and the
  compose fallback
- The forwarding loop guard only drops auto-replies from forward targets; ordinary mail
  and automated notifications from them are stored

### Fixed

- Mail could be silently lost when a MIME part decoded to bytes
- Attached messages, bounces, and calendar invites are kept as attachments; attachment-only
  mail is accepted; undeclared UTF-8 is decoded
- Remote image proxy follows redirects manually and checks the peer IP on every hop when
  the socket connects (no SSRF through 302s or DNS rebinding); responses are
  `Cache-Control: private`
- Message previews no longer trigger automatic tracking requests
- After a delete in the IMAP view, the next new mail was not noticed
- Favicon 404 (static files were not copied into the image)

### Removed

- Obsolete `deploy.sh` (use `tools/deploy-prod.sh`); manual SMTP scripts moved to `tools/`

## [1.0.0] - 2026-08-22

First tagged release. ManyMail has been running in production since April 2026; this is the
point where the feature set and the deployment story are stable enough to pin a version to.

### Mail service — FastAPI + aiosmtpd

- SMTP receiver on port 25 for any domain pointed at the host, with optional STARTTLS
- DuckMail-compatible REST API on port 8080, so existing disposable-mail scripts work unchanged
- Multiple domains from one instance, with prefixes created on demand for catch-all use
- Message retention through `MESSAGE_TTL_DAYS`, or kept indefinitely
- Abuse controls: per-IP and per-sender rate limits, recipient and message size caps,
  IP and sender blacklists, optional greylisting

### Webmail viewer — Flask

- Search, read, reply, reply-all, forward, and compose with attachments
- Mail HTML passes an allowlist sanitizer; `<style>` blocks are rewritten against a CSS
  allowlist that blocks `url()`, `@import`, and script protocols
- Remote images load through a proxy that refuses private and link-local addresses
- Verification codes extracted from incoming mail, one click to copy
- Inbox, sent, and trash with soft delete, restore, and batch actions
- Attachment download and `.eml` export where the upstream API provides it
- Responsive layout with a master-detail drill-down on phones
- Chinese and English interface

### IMAP

- IMAP4rev1 server on port 993 backed by MongoDB, for Thunderbird and phone clients
- Optional bridge that pulls in external Gmail, Outlook, QQ, and 163 accounts

### Deployment

- One `docker compose up` brings up FastAPI, Flask, Node.js, and MongoDB
- MX, SPF, DKIM, and DMARC records documented in the README
- Production hardening guide in `docs/production-hardening.md`
- CI runs Ruff, Python tests, Node tests, and a Docker build on every push

[1.3.0]: https://github.com/margbug01/ManyMail/releases/tag/v1.3.0
[1.2.0]: https://github.com/margbug01/ManyMail/releases/tag/v1.2.0
[1.1.0]: https://github.com/margbug01/ManyMail/releases/tag/v1.1.0
[1.0.0]: https://github.com/margbug01/ManyMail/releases/tag/v1.0.0
