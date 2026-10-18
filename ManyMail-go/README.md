# ManyMail (Go)

One process that replaces `mail-service`, `mail-viewer`, `mail-router` and MongoDB:
SMTP receiver, DuckMail-compatible REST API, web UI and the forwarding/push rules engine,
stored in a single SQLite file. It reads the same `.env` as the Python version.

The IMAP server (`imap-server`, port 993) is not ported. The IMAP bridge
(`mail-viewer/imap-mail-app`, external mailboxes in the web UI's IMAP tab) keeps running
as its own container and talks to this process.

## Ports

| Port | What | Env |
|---|---|---|
| 25 | SMTP (STARTTLS when `SMTP_TLS_CERT`/`SMTP_TLS_KEY` are set) | `SMTP_PORT` |
| 8080 | REST API, rules API under `/router/*` | `API_PORT` |
| 5000 | Web UI | `VIEWER_PORT` |
| 8090 | Rules API at the old mail-router address (IMAP bridge); 0 = off | `ROUTER_API_PORT` |

New variables: `DB_PATH` (default `data/manymail.db`). Everything else keeps its old name.

## Build and test

```sh
go test ./...
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -ldflags="-s -w" -o manymail .
docker build -t manymail-go:1 .
```

Race detector on Windows needs a C compiler, e.g.
`CC=C:/Strawberry/c/bin/gcc.exe CGO_ENABLED=1 go test -race ./...`.

## Deploy (oracle-a1)

`docker-compose.yml` here is the production file (`/opt/manymail-go/docker-compose.yml`).
The container joins `manymail_mail-net` with the aliases `mail-service`, `mail-viewer` and
`mail-router`, so Caddy and the IMAP bridge need no changes. Data lives in `/opt/manymail-go/data`.

The STARTTLS certificate is copied from Caddy by `/opt/ManyMail/tools/refresh-mail-cert.sh`
(cron), which restarts the `manymail` container; the key must be readable by uid 10001.

## Import from MongoDB

```sh
mongoexport --db mailserver --collection <name> --out <dir>/<name>.json   # domains accounts messages sent_messages sender_keys routing_rules routing_events
DB_PATH=/data/manymail.db manymail import <dir>
```

Only into an empty database. Ids, password hashes and attachments are kept; imported mail is
never forwarded or pushed again.

## Rollback to the Python stack

```sh
cd /opt/manymail-go && docker compose down
docker update --restart=unless-stopped mail-service mail-viewer mail-router mail-imap-server
docker start mail-service mail-viewer mail-router mail-imap-server
```

Mail received by the Go version is not in MongoDB.
