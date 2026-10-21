# Contributing

Thanks for looking. Bug reports, docs fixes, and patches are all welcome.

For anything security-related, go through [SECURITY.md](SECURITY.md) instead of a public issue.

## Layout

| Path | What runs there |
|:-----|:----------------|
| `*.go` | the `manymail` server: SMTP on `:25`, REST API on `:8080`, web UI on `:5000`, rules engine |
| `web/` | templates and front-end files, embedded into the binary |
| `frontend/` | the main mail UI (SolidJS 2 + TypeScript, Vite); `npm run build` writes `web/static/app` |
| `imap-bridge/` | Node.js bridge to external IMAP accounts on `:3939` |
| `i18n/` | UI translations; `node tools/build-i18n.cjs` bundles them into both copies of `i18n.js` |
| `tools/` | UI tests, deploy script, test senders |
| `docs/` | documentation and the GitHub Pages landing page |

## Running it

```bash
cp .env.example .env      # fill in the secrets before anything else
docker compose up -d --build
docker compose logs -f
```

Without Docker, the server is one Go binary. It embeds the main UI, so build that first
(Node 22.12+, only at build time):

```bash
(cd frontend && npm ci && npm run build)
go build -o manymail .
DB_PATH=./dev.db SMTP_PORT=2525 DOMAINS=test.local ACCESS_PASSWORD= ./manymail
```

`ACCESS_PASSWORD=` empty disables the web login in development (UI on `:5000`, API on
`:8080`). `ENVIRONMENT=production` refuses to start without the secrets.

## Tests

Same checks CI runs, so run them before opening a PR:

```bash
gofmt -l .                       # must print nothing
(cd frontend && npm ci && npm run typecheck && npm run build)
go vet ./... && go test ./...    # viewer_test.go checks the built UI is served
(cd imap-bridge && npm ci && node --test)
node tools/build-i18n.cjs --check && node tools/test-i18n.cjs
tools/test-ui.sh                 # builds frontend/, then headless-browser UI tests with stubbed APIs
```

`go test -race ./...` needs cgo; on Windows set `CC` to a MinGW gcc.

## Pull requests

- One topic per PR.
- Say what breaks if the change is wrong, and how you checked that it does not.
- Add a test when you fix a bug. `api_test.go` and `viewer_test.go` show how to run the
  server against a temporary database.
- Keep the existing style of the file you are editing. The main mail page is the SolidJS app
  in `frontend/src` (state and API calls in `state.ts`, one component per screen area); the
  rules, login and DNS pages are still plain JavaScript in `web/static/js` and Go templates
  in `web/templates`. Dependency versions in `frontend/package.json` are pinned exactly.
- Main-page strings go in `frontend/src/langs.ts`; other pages keep their `LANGS` / `TEXT` objects.
- User-facing strings need `zh` and `en` entries in the page's dictionary, plus the
  other languages in `i18n/*.json`.
- `web/shared/*.js` are copies of `imap-bridge/public/*.js`; change both (the i18n test
  checks that they match).
- Touching the mail HTML sanitizer (`sanitize.go`) means adding a test that proves the
  payload no longer gets through.

## Reporting a bug

Open an issue with the component, the commit, what you expected, and what happened. Logs from `docker compose logs <service>` help more than a description of the logs.
