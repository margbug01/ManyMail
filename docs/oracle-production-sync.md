# How production differs from this repository

The maintainer's server (oracle-a1) runs the Go version since 2026-10-18. Its checkout in
`/opt/ManyMail` follows `master`; `tools/deploy-prod.sh` fast-forwards it and rebuilds the
containers whose files changed. A few files on the server are local and marked
`git update-index --skip-worktree`, so they are not overwritten:

- `docker-compose.yml`: existing external volumes (`mail-viewer_caddy_data`,
  `mail-viewer_caddy_config`, `mail-viewer_imap_mail_data`), Caddy joined to the other
  projects' networks, and HTTPS bound to `127.0.0.1:8443`.
- `Caddyfile`: also serves unrelated sites on the same host.

During the switch to Go, `manymail` was started from a separate compose project in
`/opt/manymail-go` (database in `/opt/manymail-go/data`) with the network aliases
`mail-service`, `mail-viewer` and `mail-router`, so the server's Caddyfile and IMAP bridge
kept working unchanged. Until the server's local compose file takes over that service,
deploy Go changes by building the image there and recreating the container in
`/opt/manymail-go`.

The STARTTLS certificate is copied from Caddy's storage by a server-local cron script
(`tools/refresh-mail-cert.sh`, ignored by git), which restarts `manymail` when the
certificate changes.

Never apply the public `docker-compose.yml` to that server directly: the volume names differ
and Caddy would start with an empty certificate store.
