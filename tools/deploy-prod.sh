#!/usr/bin/env bash
# Deploy GitHub master to production. Git is the only source of truth:
# commit + push first, then run this. The server only fast-forwards to
# origin/master and rebuilds the services whose files changed.
#
#   tools/deploy-prod.sh            # deploy
#   tools/deploy-prod.sh --dry-run  # show what would change, touch nothing
#
# Env: DEPLOY_HOST (default oracle-a1), DEPLOY_DIR (default /opt/ManyMail)
set -euo pipefail

HOST="${DEPLOY_HOST:-oracle-a1}"
DIR="${DEPLOY_DIR:-/opt/ManyMail}"
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

cd "$(git rev-parse --show-toplevel)"

# 1. Local must be clean and identical to GitHub.
git fetch -q origin
if [ -n "$(git status --porcelain)" ]; then
  echo "ABORT: local working tree has uncommitted changes. Commit and push first." >&2
  git status -s >&2
  exit 1
fi
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/master)
if [ "$LOCAL" != "$REMOTE" ]; then
  echo "ABORT: local HEAD ($LOCAL) != origin/master ($REMOTE). Push (or pull) first." >&2
  exit 1
fi
echo "local = github = ${LOCAL:0:7}"

# 2. Server: refuse if hand-edited, fast-forward only, rebuild changed services.
ssh "$HOST" "sudo bash -s -- '$DIR' '$REMOTE' '$DRY'" <<'REMOTE_SCRIPT'
set -euo pipefail
DIR="$1"; TARGET="$2"; DRY="$3"
cd "$DIR"

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "ABORT: server has uncommitted edits to tracked files:" >&2
  git status -s --untracked-files=no >&2
  echo "Copy them into the local repo, commit, push, then git checkout -- . on the server." >&2
  exit 1
fi

git fetch -q origin
OLD=$(git rev-parse HEAD)
NEW=$(git rev-parse origin/master)
if [ "$NEW" != "$TARGET" ]; then
  echo "ABORT: server sees origin/master ${NEW:0:7}, expected ${TARGET:0:7}." >&2
  exit 1
fi
if [ "$OLD" = "$NEW" ]; then
  echo "server already at ${NEW:0:7}, nothing to deploy"
  exit 0
fi
if ! git merge-base --is-ancestor "$OLD" "$NEW"; then
  echo "ABORT: server HEAD ${OLD:0:7} is not an ancestor of ${NEW:0:7} (server has its own commits)." >&2
  exit 1
fi

CHANGED=$(git diff --name-only "$OLD" "$NEW")
echo "server ${OLD:0:7} -> ${NEW:0:7}, changed files:"
echo "$CHANGED" | sed 's/^/  /'

# Map files to compose services. Tests and docs never trigger a rebuild.
SERVICES=""
add() { case " $SERVICES " in *" $1 "*) ;; *) SERVICES="$SERVICES $1" ;; esac; }
WARN=""
while IFS= read -r f; do
  [ -z "$f" ] && continue
  case "$f" in
    */tests/*|*/test/*|*.md|docs/*|tools/*|.github/*|.env.example|.gitignore) ;;
    mail-service/*) add mail-service ;;
    forwarder/*) add mail-forwarder; add mail-paypal-forwarder ;;
    mail-viewer/imap-mail-app/public/email-privacy.js) add imap-mail; add mail-viewer ;;
    mail-viewer/imap-mail-app/*) add imap-mail ;;
    mail-viewer/*) add mail-viewer ;;
    docker-compose.yml|Caddyfile|.env.example)
      WARN="$WARN $f" ;;
  esac
done <<< "$CHANGED"

if [ -n "$WARN" ]; then
  echo "ABORT: upstream changed$WARN. Production keeps its own copies (skip-worktree)." >&2
  echo "Merge the change into the server copy by hand, then:" >&2
  echo "  sudo git update-index --no-skip-worktree <file> && sudo git merge --ff-only origin/master" >&2
  echo "  sudo git update-index --skip-worktree <file>" >&2
  exit 1
fi
echo "services to rebuild:${SERVICES:- (none)}"

if [ "$DRY" = "1" ]; then
  echo "dry run: nothing changed on the server"
  exit 0
fi

git merge -q --ff-only "$NEW"
echo "server git now at $(git rev-parse --short HEAD)"

if [ -n "$SERVICES" ]; then
  # shellcheck disable=SC2086
  docker compose up -d --build $SERVICES
  sleep 15
  docker compose ps --format '{{.Name}} {{.Status}}'
  BAD=$(docker compose ps --format '{{.Name}} {{.Status}}' | grep -Ei 'unhealthy|restarting|exited' || true)
  if [ -n "$BAD" ]; then
    echo "WARNING: unhealthy after deploy:" >&2
    echo "$BAD" >&2
    echo "Rollback: cd $DIR && sudo git reset -q --keep $OLD && sudo docker compose up -d --build$SERVICES" >&2
    exit 1
  fi
fi
ROLLBACK="cd $DIR && sudo git reset -q --keep $OLD"
[ -n "$SERVICES" ] && ROLLBACK="$ROLLBACK && sudo docker compose up -d --build$SERVICES"
echo "deploy OK. Rollback if needed: $ROLLBACK"
REMOTE_SCRIPT
