# Oracle production synchronization

Production source snapshot: oracle-a1 /opt/ManyMail, HEAD a8bf8dc5dca36a046910651ca64f8c9638dcf843 plus its working-tree changes, read after the rollback on 2026-10-08 (Asia/Shanghai). GitHub master before this synchronization: 3c504fc440a06816d80da16abecaa6981b738d81. The rolled-back production application source is authoritative. The UI/privacy and mobile-layout deployments after 18:00 remain reverted; this synchronization does not redeploy them. GitHub history and public documentation/tests are preserved. No production files, Git metadata, containers, configuration, or data are changed by this synchronization.

## Public deployment differences

- Compose uses environment variables instead of hardcoded forwarding API credentials and private destination addresses. Populate the blank forwarding variables in your own local environment; no real environment files are distributed. The domain-specific Resend setting remains compatible with production.
- Enable the main forwarder with `docker compose --profile forwarding up -d`; enable the second with `--profile paypal-forwarding`. They are opt-in because incomplete forwarding configuration exits immediately. The original forwarding source, including its subject prefix, is unchanged.
- Caddy exposes only the mail viewer via `MAIL_WEB_HOST`. Unrelated production sites, proxy tunnels, upstreams and routing paths are intentionally omitted. Set `CADDY_HTTPS_BIND=127.0.0.1:8443` to reproduce the server HTTPS binding; the public default is `443`.
- Private shared external networks are omitted. Compose creates project-scoped volumes rather than requiring existing host-specific external volumes. **Do not apply this public Compose file directly to the production server**: existing volume names and external networking must be retained in a separate local override to avoid an apparently empty database or account store.
- The standalone `imap-server` service is absent from production Compose and is therefore absent here; its source and tests remain available. Existing README IMAP deployment instructions describe an optional service that now requires an explicit Compose override. Production Compose defaults automatic account creation to enabled; the public `.env.example` explicitly keeps it disabled for safer setup.
- The certificate mount matches the server; optional TLS paths are documented in `.env.example`. Certificate renewal/watch scripts are private host-specific operations, not required to build the application, and are excluded. Certificates, data, logs and backups are not included.

## Known production risks retained

- The SMTP loop guard acknowledges and discards every message marked `Auto-Submitted: auto-generated` or `auto-replied`, and messages from a configured forwarding target. Legitimate automated notifications/reports can therefore be dropped without storage. This synchronization does not change that production policy.
- Attachment-only mail with no subject or readable body still meets the empty-message rejection condition, even if an attachment was extracted.
- Forwarding state and idempotency keys are per message rather than per forwarding destination; overlapping forwarding rules are not independent.
- Production Compose contained a hardcoded API credential. It is not committed here; the owner should rotate it and remove it from the server configuration separately. No credential rotation or server edits were performed.

## Verification scope

Tests use mock MongoDB/HTTP and dummy credentials. No external SMTP scripts, real Resend requests, or production writes are permitted during this synchronization. Existing body-decoding regressions are retained; the viewer missing-key test supplies valid fields to reach the new domain-key check, and mocked tests cover domain-specific and fallback key selection.

Post-rollback validation on 2026-10-08: mail-service 45 tests passed, mail-viewer 26 passed, and both Node packages 4 passed each. Ruff passed for the three Python applications; `git diff --cached --check` and `bash -n deploy.sh` passed. Node tests were run directly because the Windows npm test shell did not resolve Node; missing bridge dependencies were installed locally for testing. No production rebuild or deployment was performed. The public deployment templates were reused from the previously validated synchronization, not copied from private server configuration. SMTP regressions use mock MongoDB and cover binary attachments, spam-to-trash behavior, and the retained automated-message discard risk. Application files are checked against production by SHA-256; public configuration, tests and documentation are intentionally not byte-identical to the production checkout.
