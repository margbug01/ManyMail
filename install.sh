#!/usr/bin/env bash
# ManyMail installer: checks the host, writes .env, starts the stack and prints the DNS
# records still missing.
#
#   curl -fsSL https://raw.githubusercontent.com/margbug01/ManyMail/master/install.sh | bash
#   ./install.sh            # from inside a checkout
#
# Unattended:
#   MANYMAIL_DOMAINS=example.com MANYMAIL_WEB_HOST=mail.example.com ./install.sh --yes
#
# Options:
#   --yes, -y     take defaults / MANYMAIL_* variables instead of asking
#   --no-start    write .env but do not start containers
#   --build       build images from this checkout instead of pulling them
#
# Variables: MANYMAIL_DOMAINS, MANYMAIL_WEB_HOST, MANYMAIL_PASSWORD, MANYMAIL_TTL_DAYS,
#            MANYMAIL_PUBLIC_IP, MANYMAIL_DIR (default ./ManyMail), MANYMAIL_REF (git tag/branch)
set -euo pipefail

REPO_URL="https://github.com/margbug01/ManyMail"
ASSUME_YES=0
START=1
BUILD=0
for arg in "$@"; do
  case "$arg" in
    -y|--yes) ASSUME_YES=1 ;;
    --no-start) START=0 ;;
    --build) BUILD=1 ;;
    -h|--help) sed -n '2,20p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

say()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
warn() { printf '\033[1;33m !\033[0m  %s\n' "$*" >&2; }
die()  { printf '\033[1;31m x\033[0m  %s\n' "$*" >&2; exit 1; }

# Piped through curl, stdin is this script; questions are read from the terminal instead.
TTY=""
if [ "$ASSUME_YES" = 0 ]; then
  if [ -t 0 ]; then TTY=/dev/stdin
  elif (: < /dev/tty) 2>/dev/null; then TTY=/dev/tty
  fi
fi

# ask VAR "question" default  (a preset VAR wins; without a terminal the default is taken)
ask() {
  local var=$1 question=$2 default=${3-} answer=""
  if [ -n "${!var-}" ]; then return 0; fi
  if [ -n "$TTY" ]; then
    read -r -p "    $question${default:+ [$default]}: " answer < "$TTY" || true
  fi
  printf -v "$var" '%s' "${answer:-$default}"
}

random_hex() {  # random_hex BYTES
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex "$1"
  else head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

# set_env KEY VALUE: replace KEY=... in .env, or append it. Values are taken literally.
set_env() {
  K="$1" V="$2" awk 'BEGIN { k = ENVIRON["K"]; v = ENVIRON["V"] }
    index($0, k "=") == 1 { if (!done) print k "=" v; done = 1; next }
    { print }
    END { if (!done) print k "=" v }' .env > .env.tmp && mv .env.tmp .env
}

get_env() { sed -n "s/^$1=//p" .env | tail -n 1; }

# ---- 1. Docker ------------------------------------------------------------------------

say "Checking Docker"
command -v docker >/dev/null 2>&1 || die "Docker is not installed. Install it first: curl -fsSL https://get.docker.com | sh"
DOCKER="docker"
if ! docker info >/dev/null 2>&1; then
  if command -v sudo >/dev/null 2>&1 && sudo docker info >/dev/null 2>&1; then
    DOCKER="sudo docker"
  else
    die "Cannot talk to the Docker daemon. Start it, or add your user to the docker group."
  fi
fi
$DOCKER compose version >/dev/null 2>&1 || die "Docker Compose v2 is missing (the 'docker compose' plugin)."
note "$($DOCKER --version), $($DOCKER compose version --short 2>/dev/null || echo compose v2)"
case "$(uname -m)" in
  x86_64|amd64|aarch64|arm64) ;;
  *) warn "No prebuilt images for $(uname -m); they will be built locally."; BUILD=1 ;;
esac

# ---- 2. Source ------------------------------------------------------------------------

if [ -f docker-compose.yml ] && grep -q 'mail-router' docker-compose.yml; then
  say "Using the checkout in $(pwd)"
else
  DIR="${MANYMAIL_DIR:-ManyMail}"
  if [ -f "$DIR/docker-compose.yml" ]; then
    say "Using the existing checkout in $DIR"
  else
    REF="${MANYMAIL_REF:-}"
    if [ -z "$REF" ] && command -v git >/dev/null 2>&1; then
      REF=$(git ls-remote --tags --refs "$REPO_URL" 'v*' 2>/dev/null | sed 's#.*refs/tags/##' | sort -V | tail -n 1 || true)
    fi
    REF="${REF:-master}"
    say "Downloading ManyMail $REF into $DIR"
    if command -v git >/dev/null 2>&1; then
      git -c advice.detachedHead=false clone -q --depth 1 --branch "$REF" "$REPO_URL.git" "$DIR"
    else
      mkdir -p "$DIR"
      curl -fsSL "$REPO_URL/archive/$REF.tar.gz" | tar -xz --strip-components=1 -C "$DIR"
    fi
  fi
  cd "$DIR"
fi

# Image tag that matches this checkout: v1.2.0 -> 1.2.0, anything else -> latest.
VERSION="latest"
if command -v git >/dev/null 2>&1 && git rev-parse --git-dir >/dev/null 2>&1; then
  TAG=$(git describe --tags --exact-match 2>/dev/null || true)
  case "$TAG" in v[0-9]*) VERSION="${TAG#v}" ;; esac
fi

# ---- 3. Ports -------------------------------------------------------------------------

RUNNING=$($DOCKER ps --format '{{.Names}}' 2>/dev/null | grep -cx 'mail-service' || true)
if [ "$RUNNING" = 0 ] && command -v ss >/dev/null 2>&1; then
  say "Checking ports 25, 80, 443"
  BUSY=""
  for port in 25 80 443; do
    if ss -Htln "sport = :$port" 2>/dev/null | grep -q .; then BUSY="$BUSY $port"; fi
  done
  if [ -n "$BUSY" ]; then
    warn "Already in use:$BUSY. ManyMail needs 25 (SMTP) and 80/443 (web, certificates)."
    [ "$ASSUME_YES" = 1 ] || [ -z "$TTY" ] || { ask CONTINUE "Continue anyway? (y/N)" "n"; case "$CONTINUE" in y|Y|yes) ;; *) exit 1 ;; esac; }
  else
    note "free"
  fi
fi

# ---- 4. Public IP ---------------------------------------------------------------------

PUBLIC_IP="${MANYMAIL_PUBLIC_IP:-}"
if [ -z "$PUBLIC_IP" ]; then
  PUBLIC_IP=$(curl -4 -fsS --max-time 8 https://api.ipify.org 2>/dev/null || curl -4 -fsS --max-time 8 https://ifconfig.me/ip 2>/dev/null || true)
fi
case "$PUBLIC_IP" in
  *.*.*.*) ;;
  *) PUBLIC_IP=""; warn "Could not detect the public IPv4; set MANYMAIL_PUBLIC_IP to check DNS against it." ;;
esac

# ---- 5. .env --------------------------------------------------------------------------

GENERATED_PASSWORD=""
if [ -f .env ]; then
  say "Keeping the existing .env"
  WEB_HOST=$(get_env MAIL_WEB_HOST)
else
  say "Configuring"
  MANYMAIL_DOMAINS="${MANYMAIL_DOMAINS:-}"
  while :; do
    ask MANYMAIL_DOMAINS "Mail domain(s), comma separated (e.g. example.com)" ""
    MANYMAIL_DOMAINS=$(printf '%s' "$MANYMAIL_DOMAINS" | tr 'A-Z' 'a-z' | tr -d ' ')
    if printf '%s' "$MANYMAIL_DOMAINS" | grep -Eq '^([a-z0-9-]+\.)+[a-z]{2,}(,([a-z0-9-]+\.)+[a-z]{2,})*$'; then break; fi
    [ -n "$TTY" ] || die "Set MANYMAIL_DOMAINS, e.g. MANYMAIL_DOMAINS=example.com"
    warn "That does not look like a domain list."
    MANYMAIL_DOMAINS=""
  done
  FIRST_DOMAIN="${MANYMAIL_DOMAINS%%,*}"

  ask MANYMAIL_WEB_HOST "Host name for the web UI and the MX record" "mail.$FIRST_DOMAIN"
  WEB_HOST=$(printf '%s' "$MANYMAIL_WEB_HOST" | tr 'A-Z' 'a-z' | tr -d ' ')

  while :; do
    ask MANYMAIL_PASSWORD "Web UI password (leave empty to generate one)" ""
    if [ -z "$MANYMAIL_PASSWORD" ]; then
      GENERATED_PASSWORD=$(random_hex 9)
      MANYMAIL_PASSWORD="$GENERATED_PASSWORD"
      break
    fi
    # Compose interpolates $ and treats " #" as a comment, so keep passwords to safe characters.
    if printf '%s' "$MANYMAIL_PASSWORD" | grep -Eq '^[A-Za-z0-9._@%+=:,!~^*-]{8,}$'; then break; fi
    [ -n "$TTY" ] || die "MANYMAIL_PASSWORD needs 8+ characters from A-Z a-z 0-9 . _ @ % + = : , ! ~ ^ * -"
    warn "Use 8 or more characters from A-Z a-z 0-9 . _ @ % + = : , ! ~ ^ * -"
    MANYMAIL_PASSWORD=""
  done

  ask MANYMAIL_TTL_DAYS "Delete mail after how many days? (0 = keep forever)" "0"
  case "$MANYMAIL_TTL_DAYS" in ''|*[!0-9]*) MANYMAIL_TTL_DAYS=0 ;; esac

  umask 077
  cp .env.example .env
  API_KEY=$(random_hex 24)
  set_env MANYMAIL_VERSION "$VERSION"
  set_env PUBLIC_IP "$PUBLIC_IP"
  set_env DOMAINS "$MANYMAIL_DOMAINS"
  set_env SMTP_HOSTNAME "$WEB_HOST"
  set_env MAIL_WEB_HOST "$WEB_HOST"
  set_env VIEWER_PUBLIC_URL "https://$WEB_HOST"
  set_env MESSAGE_TTL_DAYS "$MANYMAIL_TTL_DAYS"
  set_env JWT_SECRET "$(random_hex 32)"
  set_env API_KEY "$API_KEY"
  set_env DUCKMAIL_API_KEY "$API_KEY"
  set_env ACCESS_PASSWORD "$MANYMAIL_PASSWORD"
  set_env SECRET_KEY "$(random_hex 32)"
  set_env UNIFIED_PASSWORD "$(random_hex 16)"
  set_env IMAP_ACCOUNT_ENCRYPTION_KEY "$(random_hex 32)"
  chmod 600 .env  # set_env replaces the file, so the mode is set last
  note "wrote .env (mode 600)"
fi

if [ "$START" = 0 ]; then
  say "Done. Start later with: $DOCKER compose up -d"
  exit 0
fi

# ---- 6. Start -------------------------------------------------------------------------

if [ "$BUILD" = 1 ]; then
  say "Building images (a few minutes)"
  $DOCKER compose up -d --build
else
  say "Pulling images"
  # Images that cannot be pulled (a fork, an unreleased version) are built from the checkout.
  $DOCKER compose pull --quiet --ignore-buildable 2>/dev/null || $DOCKER compose pull --quiet 2>/dev/null || warn "Some images could not be pulled; building them instead."
  say "Starting"
  $DOCKER compose up -d
fi

say "Waiting for mail-service"
STATUS=""
for _ in $(seq 1 60); do
  STATUS=$($DOCKER inspect -f '{{.State.Health.Status}}' mail-service 2>/dev/null || true)
  [ "$STATUS" = "healthy" ] && break
  sleep 3
done
if [ "$STATUS" != "healthy" ]; then
  $DOCKER compose ps
  die "mail-service did not become healthy; see: $DOCKER compose logs mail-service"
fi
note "healthy"

# ---- 7. DNS ---------------------------------------------------------------------------

say "Checking DNS"
# </dev/null: under `curl | bash` exec would otherwise eat the rest of this script from stdin.
$DOCKER compose exec -T mail-service python dnscheck.py ${PUBLIC_IP:+--ip "$PUBLIC_IP"} < /dev/null || true

# ---- 8. Summary -----------------------------------------------------------------------

echo
say "ManyMail is running"
note "Web UI:     https://$WEB_HOST   (needs the A record above; certificates are issued automatically)"
if [ -n "$GENERATED_PASSWORD" ]; then
  note "Password:   $GENERATED_PASSWORD   (ACCESS_PASSWORD in .env)"
else
  note "Password:   ACCESS_PASSWORD in .env"
fi
note "REST API:   http://127.0.0.1:8080   (X-API-Key: API_KEY in .env)"
note "Directory:  $(pwd)"
echo
note "Next:"
note "- Open TCP 25, 80 and 443 in your firewall / cloud security group. Some providers"
note "  block inbound 25 by default."
note "- Add the DNS records marked FAIL/WARN above, then re-check on https://$WEB_HOST/dns-check"
note "- Forwarding and push notifications: docs/mail-router.md"
