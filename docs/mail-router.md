# Forwarding and push rules

The rules engine inside `manymail` runs rules against every message received after it
first started. A rule says which mail it applies to and what to do with it: forward it
through Resend, push a notification to ntfy / Telegram / a webhook, or tag, mark read, or
trash it. Rules run the moment a message is stored.

It also hears about new mail in the external accounts added on the IMAP page (Gmail, QQ,
Outlook, ...): the IMAP bridge reports each new message's sender and subject, and rules
with `"source": ["imap"]` can push a notification for it.

The `FORWARD_*` and `PAYPAL_FORWARD_*` variables in `.env` still work: they show up as
read-only rules named `env-forward` and `env-paypal-forward`.

## Managing rules

Rules are stored in the SQLite database. The easiest way to manage them is the **Rules**
page of the web UI (`/rules`, linked from Settings): create and edit rules, switch them on
and off, dry-run a rule against the last 100 messages, and send a test push.

The same operations are available through the API (see below), for example:

```bash
KEY=$(grep '^API_KEY=' .env | cut -d= -f2-)
curl -s -H "X-API-Key: $KEY" http://127.0.0.1:8080/router/rules                       # list
curl -s -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
     -d @rule.json http://127.0.0.1:8080/router/rules                                  # add or replace
curl -s -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
     -d "{\"rule\": $(cat rule.json), \"limit\": 100}" http://127.0.0.1:8080/router/dry-run
curl -s -H "X-API-Key: $KEY" 'http://127.0.0.1:8080/router/status?limit=20'          # last 20 routed mails
```

Changes apply to the next message that arrives; no restart needed.

## Rule format

```json
{
  "_id": "otp-push",
  "name": "Push verification codes",
  "order": 10,
  "stop": false,
  "match": {
    "to": ["otp-*@example.com"],
    "subject": ["code", "verification", "验证码"]
  },
  "actions": [
    {"type": "ntfy", "topic": "my-private-topic-8f2c"},
    {"type": "tag", "tags": ["otp"]}
  ]
}
```

`_id` is optional (derived from `name`). Rules run in `order` (lower first, default 100);
`"stop": true` keeps later rules from running on a message this rule matched.

### Match

Every key that is present must hold; inside a list, any entry may match. An empty `match`
takes all mail that is not spam.

| Key | Meaning |
|:----|:--------|
| `to` | Recipient globs, e.g. `hello@example.com`, `*@example.com`, `otp-*@example.com` |
| `from` | Sender globs, e.g. `*@github.com` |
| `subject` | Substrings of the subject, case-insensitive |
| `subject_regex` | Regex searched in the subject, case-insensitive ([RE2 syntax](https://github.com/google/re2/wiki/Syntax): no lookarounds or backreferences) |
| `body` | Substrings of the plain-text body |
| `has_attachments` | `true` or `false` |
| `include_spam` | Also run on mail the spam filter put in the trash (default `false`) |
| `source` | `smtp` (mail received here, the default) and/or `imap` (new mail in external IMAP accounts) |

For `imap` mail only the sender, recipient (the account address) and subject are known,
so `body` never matches it and it counts as having no attachments; only `ntfy`, `telegram`
and `webhook` actions run; the others are recorded as skipped.

### Actions

| Type | Fields | Notes |
|:-----|:-------|:------|
| `forward` | `to` (list), `from`, `subject_prefix`, `api_key_env` | Sent through Resend; `from` must be on a verified domain. Key from `api_key_env`, else `RESEND_API_KEY`. Reply-To is the original sender; attachments are included. |
| `ntfy` | `topic`, `server` (default `https://ntfy.sh`), `token_env`, `priority` | Title is the subject; body has sender, recipient, the 6-digit code if any, and a preview. Tapping opens `VIEWER_PUBLIC_URL`. |
| `telegram` | `chat_id`, `bot_token_env` (default `TELEGRAM_BOT_TOKEN`) | Same content as ntfy. |
| `webhook` | `url`, `secret_env` | POSTs JSON `{event, rule, message}`; with a secret, `X-ManyMail-Signature: sha256=<hmac of the body>`. |
| `tag` | `tags` (list) | Adds to the message's `tags`. |
| `mark_read` | — | |
| `trash` | — | Soft delete, restorable from the trash. |

Secrets are never stored in rules: rules name an environment variable (`*_env`) and the
value lives in `.env`. ntfy topics on the public server are readable by anyone who knows
the name, so pick a long random one or use your own server with `token_env`.

## Examples

Push everything sent to one domain, except newsletters handled by an earlier rule:

```json
{"name": "newsletters", "order": 1, "stop": true,
 "match": {"from": ["*@substack.com", "*@mailchimpapp.net"]},
 "actions": [{"type": "tag", "tags": ["news"]}, {"type": "mark_read"}]}
```

```json
{"name": "push all", "order": 50,
 "match": {"to": ["*@example.com"]},
 "actions": [{"type": "ntfy", "topic": "example-mail-3b9d1e"}]}
```

Forward invoices to an accounting inbox:

```json
{"name": "invoices",
 "match": {"to": ["billing@example.com"], "has_attachments": true},
 "actions": [{"type": "forward", "to": ["books@gmail.com"], "from": "Billing <billing@example.com>",
              "subject_prefix": "[Invoice]"}]}
```

Push new mail from an external Gmail account, but only from your bank:

```json
{"name": "bank via gmail",
 "match": {"source": ["imap"], "to": ["me@gmail.com"], "from": ["*@mybank.com"]},
 "actions": [{"type": "ntfy", "topic": "bank-3b9d1e", "priority": 4}]}
```

## How delivery works

- On first start (or when a 1.x export is imported) the engine records the current time;
  older mail is never replayed. On a fresh database `ROUTER_START_FROM` overrides that, as a
  date (`2026-10-01`) or timestamp (`2026-10-01T08:00:00+08:00`).
- Each message records which rules matched (fixed at first sight) and the result of each
  action. The state is saved after every action, so a restart never repeats one that
  already went out.
- A failed action is retried alone, with exponential backoff starting at
  `ROUTER_RETRY_SECONDS` (default 60, capped at an hour), up to `ROUTER_MAX_ATTEMPTS`
  (default 12). Resend calls carry an idempotency key per message and action.
- The SMTP loop guard treats every `forward` target as a forwarding address: auto-replies
  from it are dropped instead of being stored and forwarded again.

## API

The rules API is served under `/router/*` on the API port (8080), and also at the root of
port 8090 (`ROUTER_API_PORT`, set `0` to turn it off), the address the IMAP bridge uses.
Every call except `GET /health` needs `X-API-Key: $API_KEY`.

| Method | Path | |
|:-------|:-----|:-|
| GET | `/rules` | all rules, each with `problems` from validation |
| POST | `/rules` | create (or replace by `_id`) |
| PUT / DELETE | `/rules/<id>` | replace / delete (rules from `.env` answer 409) |
| POST | `/rules/<id>/enabled` | `{"enabled": false}` |
| POST | `/rules/<id>/test`, `/test` | sample push through a saved rule / `{"rule": {...}}` |
| POST | `/dry-run` | `{"rule": {...}, "limit": 100}` |
| GET | `/status?limit=20` | recently routed mail and IMAP events |
| POST | `/events/imap` | used by the IMAP bridge: `{"account", "uidvalidity", "messages": [{"uid", "from", "subject"}]}` |

The IMAP bridge reports through this API when `ROUTER_URL` and `ROUTER_API_KEY` are set,
which `docker-compose.yml` does. It keeps track of the highest UID it has seen in each
account's INBOX, so it never reports old mail, and after a reconnect it reports what came in
meanwhile (at most 20 messages). IMAP events are kept for 30 days.
