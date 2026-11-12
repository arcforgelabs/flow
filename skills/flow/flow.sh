#!/usr/bin/env bash
# Flow command for an AI assistant (docs/AGENT_ACCESS.md, "AI assistant key").
#   flow.sh setup <https://flow url> save this lab's Flow address, make the key
#                                    once, print only the key's SHA-256
#   flow.sh get    <path>            GET    <FLOW_URL>/api/<path>
#   flow.sh post   <path> [json]     POST   with an optional JSON body
#   flow.sh put    <path> <json>     PUT    with a JSON body
#   flow.sh delete <path>            DELETE
#   flow.sh health                   GET <FLOW_URL>/health (public, no key sent)
# The key stays in FLOW_AGENT_KEY_FILE (mode 600). It never goes on a command
# line or into the output.
set -euo pipefail

KEY_FILE="${FLOW_AGENT_KEY_FILE:-$HOME/.openclaw/credentials/flow-agent-key}"
URL_FILE="${KEY_FILE}.url"

die() { echo "flow.sh: $*" >&2; exit 2; }

# The key goes only to the Flow address saved at setup (or FLOW_URL). There is
# no default address, so a key never goes to another lab's Flow.
flow_url() {
  local url="${FLOW_URL:-}"
  [[ -n "$url" || ! -s "$URL_FILE" ]] || url="$(tr -d '\n' < "$URL_FILE")"
  [[ "$url" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?/?$ ]] || die "no Flow address: run flow.sh setup https://<your Flow>"
  printf '%s' "${url%/}"
}

setup() {
  local url="${1:-}"
  if [[ -n "$url" ]]; then
    [[ "$url" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?/?$ ]] || die "the Flow address must be https://<host>"
    mkdir -p "$(dirname "$URL_FILE")"
    printf '%s\n' "${url%/}" > "$URL_FILE"
  fi
  echo "Flow address: $(flow_url)"
  if [[ ! -s "$KEY_FILE" ]]; then
    mkdir -p "$(dirname "$KEY_FILE")"
    (umask 077 && openssl rand -hex 32 > "$KEY_FILE")
  fi
  chmod 600 "$KEY_FILE"
  echo "FLOW_AGENT_KEY_SHA256=$(tr -d '\n' < "$KEY_FILE" | sha256sum | cut -d' ' -f1)"
}

call() {
  local method="$1" path="${2:-}" body="${3:-}"
  [[ -n "$path" ]] || die "give a path, for example: get invoicing/invoices?status=ready"
  [[ -s "$KEY_FILE" ]] || die "no key yet: run flow.sh setup https://<your Flow> first"
  local args=(-sS -X "$method" -K - -H 'Accept: application/json' -w '\nHTTP %{http_code}\n')
  if [[ -n "$body" ]]; then args+=(-H 'Content-Type: application/json' --data-binary "$body"); fi
  printf 'header = "Authorization: Bearer %s"\n' "$(tr -d '\n' < "$KEY_FILE")" \
    | curl "${args[@]}" "$(flow_url)/api/${path#/}"
}

case "${1:-}" in
  setup) setup "${2:-}" ;;
  get) call GET "${2:-}" ;;
  post) call POST "${2:-}" "${3:-}" ;;
  put) [[ -n "${3:-}" ]] || die "put needs a JSON body"; call PUT "${2:-}" "$3" ;;
  delete) call DELETE "${2:-}" ;;
  health) curl -sS -H 'Accept: application/json' -w '\nHTTP %{http_code}\n' "$(flow_url)/health" ;;
  *) sed -n '2,10p' "$0"; exit 2 ;;
esac
