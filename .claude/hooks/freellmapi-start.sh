#!/bin/bash
# SessionStart hook: start a localhost-only FreeLLMAPI before the agent's first
# turn in a Claude Code cloud session. Safe to run repeatedly (startup, resume,
# clear, compact): it reuses a healthy server instead of starting another.
#
# Inputs come from the cloud environment's variables, never from files in git:
#   ENCRYPTION_KEY        required, 64 hex chars; encrypts provider keys at rest
#   FREEAPI_CONFIG_JSON   optional; declarative admin account + provider keys,
#                         re-applied on every boot (see docs/en/install/01-install.md)
#   FREEAPI_DB_BACKUP_URL optional; encrypted DB backup/restore so the database
#   FREEAPI_DB_BACKUP_TOKEN  (and with it the unified API key) survives sessions
#   FREELLMAPI_PORT       optional, default 3001
#
# Nothing here prints a secret. Claude Code's own API endpoint is left alone.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}"

PORT="${FREELLMAPI_PORT:-3001}"
BASE_URL="http://127.0.0.1:${PORT}"
DATA_DIR="server/data"
LOG="${DATA_DIR}/server.log"
PID_FILE="${DATA_DIR}/server.pid"
SECRETS_DIR="${HOME}/.config/freellmapi-hub"

say() { echo "[freellmapi] $*" >&2; }
fail() { say "ERROR: $*"; exit 1; }
ping_ok() { curl -fsS --noproxy '*' -m 2 -o /dev/null "${BASE_URL}/api/ping" 2>/dev/null; }
# Startup output minus anything that could carry a secret: the one-time setup
# code, and the full NO_PROXY list (noise, not secret).
show_log_tail() { tail -n 25 "$LOG" 2>/dev/null | grep -v -i -E 'setup code|^[[:space:]]+[A-Z0-9]{8,}[[:space:]]*$|NO_PROXY' >&2 || true; }

case "${ENCRYPTION_KEY:-}" in
  "") fail "ENCRYPTION_KEY is not set. Add it as an environment variable in the cloud environment settings." ;;
esac
[[ "$ENCRYPTION_KEY" =~ ^[0-9a-fA-F]{64}$ ]] || fail "ENCRYPTION_KEY must be exactly 64 hex characters."

mkdir -p -m 700 "$DATA_DIR" "$SECRETS_DIR"

# 1. Dependencies: install only when a manifest changed since the last success.
hashes=node_modules/.session-start.sha256
if ! sha256sum --check --status "$hashes" 2>/dev/null; then
  rm -f "$hashes"
  say "installing dependencies"
  npm ci --no-audit --no-fund >&2
  sha256sum .claude/hooks/freellmapi-start.sh package.json package-lock.json \
    shared/package.json server/package.json client/package.json cli/package.json > "$hashes"
fi

# 2. Build: only when tracked sources (or uncommitted edits to them) changed.
stamp=server/dist/.build-stamp
want="$( { git ls-files -s shared server client cli package-lock.json; git diff HEAD -- shared server client cli; } | sha256sum | cut -d' ' -f1)"
if [ "$(cat "$stamp" 2>/dev/null)" != "$want" ] || [ ! -f server/dist/index.js ] || [ ! -f client/dist/index.html ]; then
  say "building server, cli and dashboard"
  npm run build >&2
  echo "$want" > "$stamp"
fi

# 3. Start once. A healthy server on the port is reused; a busy port that does
#    not answer /api/ping is someone else's and is an error, not ours to kill.
if ping_ok; then
  say "already running at ${BASE_URL} (pid $(cat "$PID_FILE" 2>/dev/null || echo unknown))"
else
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    say "previous server (pid $(cat "$PID_FILE")) is alive but not answering; waiting for it"
  elif (exec 3<>"/dev/tcp/127.0.0.1/${PORT}") 2>/dev/null; then
    fail "port ${PORT} is in use by something that is not FreeLLMAPI. Set FREELLMAPI_PORT."
  else
    if [ -z "${FREEAPI_DB_BACKUP_URL:-}${FREEAPI_DB_BACKUP_TARGET:-}${FREEAPI_DB_BACKUP_PATH:-}" ]; then
      say "WARNING: no FREEAPI_DB_BACKUP_URL; the database and unified key last only as long as this container"
    fi
    say "starting on ${BASE_URL}"
    echo "----- $(date -u +%FT%TZ) session start -----" >> "$LOG"
    # HOST/PORT are forced here so neither a stray .env nor an inherited
    # variable can widen the bind. setsid detaches it from the hook's process
    # group so it outlives the hook.
    HOST=127.0.0.1 PORT="$PORT" NODE_ENV=production \
      setsid nohup node server/dist/index.js >> "$LOG" 2>&1 < /dev/null &
    echo $! > "$PID_FILE"
  fi

  for _ in $(seq 1 60); do
    ping_ok && break
    if ! kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      show_log_tail
      fail "server exited during startup; see ${LOG}"
    fi
    sleep 1
  done
  ping_ok || { show_log_tail; fail "server did not answer ${BASE_URL}/api/ping within 60s"; }
  say "ready at ${BASE_URL}"
fi

# 4. Refuse to continue if anything widened the bind beyond loopback.
port_hex="$(printf '%04X' "$PORT")"
if awk -v p=":${port_hex}" 'NR>1 && $4=="0A" && $2 ~ p"$" && $2 !~ /^0100007F/' /proc/net/tcp 2>/dev/null | grep -q .; then
  fail "port ${PORT} is listening on a non-loopback address"
fi

# 5. Fetch the unified key into a 0600 file (never printed), using the admin
#    account from FREEAPI_CONFIG_JSON. The key rotates with a fresh database,
#    so it is re-read every session rather than stored anywhere durable.
key_file="${SECRETS_DIR}/unified-key"
rm -f "$key_file"
if [ -n "${FREEAPI_CONFIG_JSON:-}" ]; then
  if node --input-type=module -e '
    const cfg = JSON.parse(process.env.FREEAPI_CONFIG_JSON);
    if (!cfg.admin) process.exit(3);
    const base = process.argv[1];
    const post = await fetch(base + "/api/auth/login", { method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: cfg.admin.email, password: cfg.admin.password }) });
    if (!post.ok) { console.error("login HTTP " + post.status); process.exit(1); }
    const { token } = await post.json();
    const res = await fetch(base + "/api/settings/api-key", { headers: { authorization: "Bearer " + token } });
    if (!res.ok) { console.error("api-key HTTP " + res.status); process.exit(1); }
    const { apiKey } = await res.json();
    (await import("node:fs")).writeFileSync(process.argv[2], apiKey + "\n", { mode: 0o600 });
  ' "$BASE_URL" "$key_file"; then
    chmod 600 "$key_file"
    say "unified key written to ${key_file}"
  else
    say "WARNING: could not read the unified key with the admin from FREEAPI_CONFIG_JSON"
  fi
else
  say "no FREEAPI_CONFIG_JSON; add an admin and provider keys there to configure this server"
fi

# 6. Prove the API is reachable from this process tree, authenticated if we can.
if [ -s "$key_file" ]; then
  code="$(curl -sS --noproxy '*' -m 5 -o /dev/null -w '%{http_code}' \
    -H @<(printf 'Authorization: Bearer %s\n' "$(cat "$key_file")") "${BASE_URL}/v1/models")"
  [ "$code" = 200 ] || fail "GET /v1/models with the unified key returned HTTP ${code}"
  say "GET /v1/models: 200"
fi

# Non-secret pointers for later tools. Deliberately no ANTHROPIC_* variables:
# Claude Code keeps its normal endpoint until the gateway is switched on by hand.
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  {
    echo "export FREELLMAPI_URL=${BASE_URL}"
    echo "export FREELLMAPI_KEY_FILE=${key_file}"
  } >> "$CLAUDE_ENV_FILE"
fi
