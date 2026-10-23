#!/usr/bin/env bash
# Envoltorio para los hooks de misMEM contra un servidor remoto.
#
# Saca la URL y el header de autorización de la config MCP del cliente, donde la
# credencial ya vive, en vez de copiarla a otro archivo o a settings.json. Nunca
# la imprime: el valor sólo viaja en el entorno del hook.
#
#   mismem-hook.sh inject   # UserPromptSubmit
#   mismem-hook.sh used     # Stop
#
# Config: MISMEM_HOOK_CONFIG (default ~/.claude.json), MISMEM_HOOK_SERVER
# (nombre del server MCP, default "mismem"), MISMEM_DIST (default el dist de este repo).
set -euo pipefail

cmd="${1:-}"
case "$cmd" in
  inject|used) ;;
  *) echo "uso: $(basename "$0") inject|used" >&2; exit 0 ;;
esac

config="${MISMEM_HOOK_CONFIG:-$HOME/.claude.json}"
server="${MISMEM_HOOK_SERVER:-mismem}"
dist="${MISMEM_DIST:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../engine/dist" && pwd)}"

# Busca el server por nombre en cualquier nivel: la config puede ser global o por proyecto.
read_config() {
  python3 - "$config" "$server" <<'PY'
import json, sys
path, server = sys.argv[1], sys.argv[2]
try:
    data = json.load(open(path, encoding="utf-8"))
except Exception:
    sys.exit(0)

def walk(node):
    if isinstance(node, dict):
        entry = node.get(server)
        if isinstance(entry, dict) and "url" in entry:
            return entry
        for value in node.values():
            found = walk(value)
            if found:
                return found
    elif isinstance(node, list):
        for value in node:
            found = walk(value)
            if found:
                return found
    return None

entry = walk(data)
if not entry:
    sys.exit(0)
url = str(entry["url"]).rstrip("/")
# El cliente del hook le agrega /mcp, así que acá se saca.
if url.endswith("/mcp"):
    url = url[: -len("/mcp")]
auth = ""
for name, value in (entry.get("headers") or {}).items():
    if name.lower() == "authorization":
        auth = str(value)
        break
print(url)
print(auth)
PY
}

mapfile -t parsed < <(read_config)
# Sin config utilizable el hook sigue: usa la base local y no rompe el turno.
if [ "${#parsed[@]}" -ge 1 ] && [ -n "${parsed[0]}" ]; then
  export MISMEM_HOOK_URL="${parsed[0]}"
  [ "${#parsed[@]}" -ge 2 ] && [ -n "${parsed[1]}" ] && export MISMEM_HOOK_AUTH_HEADER="${parsed[1]}"
fi

entry="$dist/${cmd}-cli.js"
# Si el repo se movió o no está compilado, callarse: un hook que falla en cada
# prompt es peor que un hook que no hace nada.
if [ ! -f "$entry" ]; then
  echo "mismem-hook: falta $entry (¿compilaste el engine?)" >&2
  exit 0
fi
if ! command -v node >/dev/null 2>&1; then
  echo "mismem-hook: node no está en PATH" >&2
  exit 0
fi

exec node "$entry" "${@:2}"
