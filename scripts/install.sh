#!/usr/bin/env bash
# Instalador de misMEM para Linux.
#
# Deja misMEM funcionando y configurado en los clientes que haya en la máquina, y pide
# sólo lo que es del usuario: dónde va la base y con qué proveedor consolidar. Las claves
# van a ~/.config/mismem/env (600) y nunca a la config de un cliente: los clientes llaman a
# ~/.local/bin/mismem-run, que carga ese fichero y lanza misMEM con la ruta absoluta de
# Node (los clientes de escritorio no heredan el PATH de la terminal).
#
#   bash scripts/install.sh                 # interactivo, desde este repo (lo compila)
#   bash scripts/install.sh --from-npm      # el paquete publicado en npm
#   bash scripts/install.sh --yes --clients claude-code,opencode --no-timer
#
# Sin preguntas (--yes), se leen MISMEM_INSTALL_DB, MISMEM_INSTALL_PROVIDER
# (deepseek|openrouter|openai|compatible|none), MISMEM_INSTALL_API_KEY,
# MISMEM_INSTALL_MODEL, MISMEM_INSTALL_BASE_URL y MISMEM_INSTALL_HOOKS (yes|no).
# La clave nunca va por argumento: quedaría en el historial y en `ps`.
#
# Re-ejecutarlo actualiza en vez de duplicar.
set -euo pipefail

# ---------------------------------------------------------------- argumentos

usage() {
  cat <<'EOF'
Uso: install.sh [opciones]

  --from-npm           Instala el paquete publicado en npm en vez de este repo
                       (puede ir por detrás del repo: sin hooks si su versión no los trae)
  --yes, -y            Sin preguntas: valores por defecto y variables MISMEM_INSTALL_*
  --clients LISTA      claude-code,opencode,claude-desktop,vscode,cursor | all | none
                       (por defecto, los que se detectan en la máquina)
  --timer / --no-timer Consolidación nocturna con systemd de usuario (por defecto pregunta)
  --help               Esta ayuda
EOF
}

# Desde el repo si el script vive en uno (es lo que indica el README); npm es la alternativa.
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FROM_SOURCE=0
[ -f "$REPO/engine/package.json" ] && FROM_SOURCE=1
ASSUME_YES=0
CLIENTS=""
TIMER=""
while [ $# -gt 0 ]; do
  case "$1" in
    --from-source) FROM_SOURCE=1 ;;
    --from-npm) FROM_SOURCE=0 ;;
    --yes | -y) ASSUME_YES=1 ;;
    --clients)
      [ $# -ge 2 ] || { echo "--clients necesita una lista" >&2; exit 64; }
      CLIENTS="$2"
      shift
      ;;
    --timer) TIMER=yes ;;
    --no-timer) TIMER=no ;;
    --help | -h) usage; exit 0 ;;
    *) echo "argumento desconocido: $1" >&2; usage >&2; exit 64 ;;
  esac
  shift
done

# ---------------------------------------------------------------- ayudas

say() { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
warn() { printf '  ! %s\n' "$*" >&2; }

# ask PREGUNTA DEFECTO: con --yes, el defecto.
ask() {
  local answer
  if [ "$ASSUME_YES" = 1 ]; then printf '%s' "$2"; return; fi
  read -r -p "$1 [$2]: " answer </dev/tty || true
  printf '%s' "${answer:-$2}"
}

# confirm PREGUNTA DEFECTO(y|n)
confirm() {
  local answer hint="[S/n]"
  [ "$2" = n ] && hint="[s/N]"
  if [ "$ASSUME_YES" = 1 ]; then [ "$2" = y ]; return; fi
  read -r -p "$1 $hint: " answer </dev/tty || true
  answer="${answer:-$2}"
  case "$answer" in [sSyY]*) return 0 ;; *) return 1 ;; esac
}

# ask_secret PREGUNTA: no se muestra mientras se escribe.
ask_secret() {
  local answer
  read -r -s -p "$1: " answer </dev/tty || true
  printf '\n' >/dev/tty
  printf '%s' "$answer"
}

# ---------------------------------------------------------------- requisitos

[ "$(uname -s)" = Linux ] || { say "Por ahora este instalador es sólo para Linux."; exit 1; }

NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  say "Hace falta Node 22 o superior y no está en el PATH."
  say "Instálalo con tu gestor de versiones (mise, nvm, fnm) o desde https://nodejs.org y vuelve a ejecutar esto."
  exit 1
fi
NODE="$(readlink -f "$NODE")"
NODE_MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  say "misMEM necesita Node 22 o superior; este es $("$NODE" --version)."
  exit 1
fi

DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/mismem"
CONF_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/mismem"
BIN_DIR="$HOME/.local/bin"
ENV_FILE="$CONF_DIR/env"
RUN="$BIN_DIR/mismem-run"

# ---------------------------------------------------------------- 1. instalar

step "Instalando misMEM"
if [ "$FROM_SOURCE" = 1 ]; then
  [ -f "$REPO/engine/package.json" ] || { say "No estoy dentro del repo de misMEM: usa --from-npm."; exit 1; }
  cd "$REPO/engine"
  if command -v pnpm >/dev/null 2>&1; then
    pnpm install --frozen-lockfile >/dev/null
    pnpm build >/dev/null
  else
    npm ci --no-audit --no-fund >/dev/null
    npm run build >/dev/null
  fi
  cd - >/dev/null
  DIST="$REPO/engine/dist"
  say "  desde el repo: $REPO"
else
  mkdir -p "$DATA_DIR/app"
  # npm y no pnpm: viene con Node, y corre la descarga del binario de better-sqlite3 sin
  # tener que autorizar scripts de instalación a mano.
  npm install --prefix "$DATA_DIR/app" --no-audit --no-fund --loglevel=error \
    "@lucasmella/mismem@${MISMEM_INSTALL_VERSION:-latest}" >/dev/null
  DIST="$DATA_DIR/app/node_modules/@lucasmella/mismem/dist"
  say "  desde npm ($("$NODE" -p "require('$DATA_DIR/app/node_modules/@lucasmella/mismem/package.json').version")) en $DATA_DIR/app"
fi
[ -f "$DIST/server.js" ] || { say "No se encontró $DIST/server.js: la instalación falló."; exit 1; }

# ---------------------------------------------------------------- 2. configuración

# Lo que ya había (si se re-ejecuta) es el valor por defecto de cada pregunta.
prev() {
  [ -f "$ENV_FILE" ] || return 0
  (set -a; . "$ENV_FILE"; eval "printf '%s' \"\${$1:-}\"")
}

step "Configuración"
DB="${MISMEM_INSTALL_DB:-$(prev MISMEM_DB)}"
DB="$(ask "Dónde guardar la memoria" "${DB:-$HOME/.mismem/mem.db}")"

PREV_PROVIDER="$(prev MISMEM_LLM_PROVIDER)"
if [ "$ASSUME_YES" = 1 ]; then
  PROVIDER="${MISMEM_INSTALL_PROVIDER:-${PREV_PROVIDER:-none}}"
else
  say "La consolidación resume los episodios en memorias con un LLM. Cada tanda es una llamada"
  say "a la API del proveedor (cuesta dinero según el proveedor y el modelo)."
  say "  1) DeepSeek   2) OpenRouter   3) OpenAI   4) Servidor compatible con OpenAI (p. ej. Ollama)   5) Ninguno por ahora"
  case "$(ask "Proveedor" "${PREV_PROVIDER:-5}")" in
    1 | deepseek) PROVIDER=deepseek ;;
    2 | openrouter) PROVIDER=openrouter ;;
    3 | openai) PROVIDER=openai ;;
    4 | compatible) PROVIDER=compatible ;;
    *) PROVIDER=none ;;
  esac
fi

KEY_VAR=""
case "$PROVIDER" in
  deepseek) KEY_VAR=DEEPSEEK_API_KEY ;;
  openrouter) KEY_VAR=OPENROUTER_API_KEY ;;
  openai) KEY_VAR=OPENAI_API_KEY ;;
  compatible) KEY_VAR=MISMEM_LLM_API_KEY ;;
  none) ;;
  *) say "Proveedor desconocido: $PROVIDER"; exit 64 ;;
esac

API_KEY=""
BASE_URL=""
MODEL="${MISMEM_INSTALL_MODEL:-$(prev MISMEM_CONSOLIDATION_MODEL)}"
if [ -n "$KEY_VAR" ]; then
  PREV_KEY="$(prev "$KEY_VAR")"
  if [ -n "${MISMEM_INSTALL_API_KEY:-}" ]; then
    API_KEY="$MISMEM_INSTALL_API_KEY"
  elif [ "$ASSUME_YES" = 1 ]; then
    API_KEY="$PREV_KEY"
  else
    hint="clave de $PROVIDER"
    [ "$PROVIDER" = compatible ] && hint="clave del servidor (vacía si no pide)"
    [ -n "$PREV_KEY" ] && hint="$hint (Enter para conservar la actual)"
    API_KEY="$(ask_secret "$hint")"
    API_KEY="${API_KEY:-$PREV_KEY}"
  fi
  if [ -z "$API_KEY" ] && [ "$PROVIDER" != compatible ]; then
    warn "Sin clave no se podrá consolidar; puedes volver a ejecutar esto cuando la tengas."
  fi
  if [ "$PROVIDER" = compatible ]; then
    BASE_URL="${MISMEM_INSTALL_BASE_URL:-$(prev MISMEM_LLM_BASE_URL)}"
    BASE_URL="$(ask "URL base del servidor (con /v1)" "${BASE_URL:-http://127.0.0.1:11434/v1}")"
  fi
  # Con OpenAI o un servidor compatible no hay modelo por defecto: es una decisión de coste.
  if [ "$PROVIDER" = openai ] || [ "$PROVIDER" = compatible ]; then
    MODEL="$(ask "Modelo (obligatorio con $PROVIDER)" "$MODEL")"
    [ -n "$MODEL" ] || warn "Sin modelo no se podrá consolidar con $PROVIDER."
  else
    MODEL="$(ask "Modelo (Enter para el de misMEM por defecto)" "$MODEL")"
  fi
fi

# ---------------------------------------------------------------- 3. embeddings

step "Búsqueda semántica"
OLLAMA_URL="${MISMEM_OLLAMA_URL:-http://127.0.0.1:11434}"
EMBEDDINGS_OFF=""
if curl -fsS -m 3 "$OLLAMA_URL/api/tags" >/dev/null 2>&1; then
  if curl -fsS -m 3 "$OLLAMA_URL/api/tags" | grep -q '"nomic-embed-text'; then
    say "  Ollama responde y ya tiene nomic-embed-text."
  elif command -v ollama >/dev/null 2>&1 && confirm "  Ollama responde. ¿Bajar nomic-embed-text (unos 270 MB) para buscar por significado?" y; then
    ollama pull nomic-embed-text
  else
    say "  Sin el modelo de embeddings la búsqueda es sólo por palabras."
  fi
else
  # Sin Ollama cada búsqueda esperaría el timeout del embedder para nada.
  EMBEDDINGS_OFF=1
  say "  Ollama no responde en $OLLAMA_URL: la búsqueda queda sólo por palabras."
  say "  Para activarla: instala Ollama, 'ollama pull nomic-embed-text' y vuelve a ejecutar esto."
fi

# ---------------------------------------------------------------- 4. env y lanzador

step "Guardando la configuración"
mkdir -p "$CONF_DIR" "$BIN_DIR" "$(dirname "$DB")"
(
  umask 077
  tmp="$(mktemp "$CONF_DIR/env.XXXXXX")"
  {
    say "# Generado por scripts/install.sh de misMEM. Lo lee $RUN."
    printf 'MISMEM_DB=%q\n' "$DB"
    printf 'MISMEM_OLLAMA_URL=%q\n' "$OLLAMA_URL"
    printf 'MISMEM_EMBEDDING_MODEL=%q\n' "nomic-embed-text"
    [ -n "$EMBEDDINGS_OFF" ] && printf 'MISMEM_EMBEDDINGS=off\n'
    if [ "$PROVIDER" != none ]; then
      printf 'MISMEM_LLM_PROVIDER=%q\n' "$PROVIDER"
      [ -n "$API_KEY" ] && printf '%s=%q\n' "$KEY_VAR" "$API_KEY"
      [ -n "$BASE_URL" ] && printf 'MISMEM_LLM_BASE_URL=%q\n' "$BASE_URL"
      [ -n "$MODEL" ] && printf 'MISMEM_CONSOLIDATION_MODEL=%q\n' "$MODEL"
    fi
    true
  } >"$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
)
say "  $ENV_FILE (sólo tu usuario puede leerlo)"

cat >"$RUN" <<EOF
#!/usr/bin/env bash
# Generado por scripts/install.sh de misMEM: carga $ENV_FILE y lanza un binario de misMEM.
#   mismem-run mismem | mismem-http | mismem-inject | mismem-used | mismem-consolidate | ...
set -euo pipefail
set -a
[ -f "$ENV_FILE" ] && . "$ENV_FILE"
set +a
cmd="\${1:-mismem}"
[ \$# -gt 0 ] && shift
case "\$cmd" in
  mismem) file=server.js ;;
  mismem-http) file=server-http.js ;;
  mismem-inject) file=inject-cli.js ;;
  mismem-used) file=used-cli.js ;;
  mismem-consolidate) file=consolidate-cli.js ;;
  mismem-forget) file=forget-cli.js ;;
  mismem-stats) file=stats-cli.js ;;
  mismem-embed) file=embed-cli.js ;;
  mismem-ingest) file=ingest-cli.js ;;
  mismem-obsidian) file=obsidian-cli.js ;;
  *) echo "mismem-run: comando desconocido: \$cmd" >&2; exit 64 ;;
esac
exec "$NODE" "$DIST/\$file" "\$@"
EOF
chmod 755 "$RUN"
say "  $RUN"

# ---------------------------------------------------------------- 5. clientes

# json_edit FICHERO: aplica el JS de $EDIT a `config` (el JSON, o {} si no existe) y lo
# escribe de forma atómica. Un JSON roto no se pisa: se avisa y se sigue.
json_edit() {
  FILE="$1" RUN="$RUN" "$NODE" -e '
    const fs = require("fs"), path = require("path");
    const file = process.env.FILE, run = process.env.RUN;
    let config = {};
    if (fs.existsSync(file)) {
      try { config = JSON.parse(fs.readFileSync(file, "utf8")); }
      catch (e) { console.error(`  ! ${file} no es JSON válido; no lo toco.`); process.exit(3); }
    }
    const result = new Function("config", "run", process.env.EDIT)(config, run);
    if (result === "skip") process.exit(4);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.mismem-tmp`;
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n");
    fs.renameSync(tmp, file);
  '
}

detected() {
  case "$1" in
    claude-code) command -v claude >/dev/null 2>&1 ;;
    opencode) command -v opencode >/dev/null 2>&1 || [ -d "$HOME/.config/opencode" ] ;;
    claude-desktop) [ -d "$HOME/.config/Claude" ] ;;
    vscode) [ -d "$HOME/.config/Code" ] ;;
    cursor) [ -d "$HOME/.cursor" ] ;;
  esac
}

ALL_CLIENTS="claude-code opencode claude-desktop vscode cursor"
case "$CLIENTS" in
  all) CLIENTS="$ALL_CLIENTS" ;;
  none) CLIENTS="" ;;
  "")
    CLIENTS=""
    for c in $ALL_CLIENTS; do detected "$c" && CLIENTS="$CLIENTS $c"; done
    ;;
  *) CLIENTS="${CLIENTS//,/ }" ;;
esac

step "Clientes"
[ -n "${CLIENTS// /}" ] || say "  Ninguno detectado. Puedes elegirlos con --clients."
CONFIGURED=""
for client in $CLIENTS; do
  confirm "Configurar misMEM en $client?" y || continue
  case "$client" in
    claude-code)
      if ! command -v claude >/dev/null 2>&1; then
        warn "claude no está en el PATH; no puedo registrar el MCP en Claude Code."
        continue
      fi
      claude mcp remove -s user mismem >/dev/null 2>&1 || true
      claude mcp add -s user mismem -- "$RUN" mismem >/dev/null
      say "  Claude Code: MCP 'mismem' registrado para tu usuario."
      hooks="${MISMEM_INSTALL_HOOKS:-}"
      # La versión de npm puede ir por detrás del repo y no traer los hooks todavía.
      if [ ! -f "$DIST/inject-cli.js" ] || [ ! -f "$DIST/used-cli.js" ]; then
        warn "Esta versión de misMEM no trae los hooks (mismem-inject, mismem-used); instálala desde el repo para tenerlos."
        hooks=no
      fi
      if [ -z "$hooks" ]; then
        say "  Los hooks adelantan recuerdos relevantes en cada prompt (que viajan al modelo) y"
        say "  refuerzan los que la respuesta usa."
        confirm "  ¿Activarlos?" y && hooks=yes || hooks=no
      fi
      if [ "$hooks" = yes ]; then
        EDIT='
          const hooks = (config.hooks ??= {});
          const mine = (h) => (h.hooks ?? []).some((x) => String(x.command ?? "").includes(run));
          const other = (h) => (h.hooks ?? []).some((x) => /mismem-(inject|used|hook)/.test(String(x.command ?? "")) && !mine(h));
          if ([...(hooks.UserPromptSubmit ?? []), ...(hooks.Stop ?? [])].some(other)) return "skip";
          for (const [event, cmd, timeout] of [["UserPromptSubmit", "mismem-inject", 10], ["Stop", "mismem-used", 15]]) {
            hooks[event] = (hooks[event] ?? []).filter((h) => !mine(h));
            hooks[event].push({ hooks: [{ type: "command", command: `"${run}" ${cmd}`, timeout }] });
          }' json_edit "$HOME/.claude/settings.json" && say "  Claude Code: hooks de inyección y refuerzo activados." || {
          [ $? -eq 4 ] && warn "Ya hay hooks de misMEM configurados de otra forma en ~/.claude/settings.json; no los duplico."
          true
        }
      fi
      ;;
    opencode)
      if [ -f "$HOME/.config/opencode/opencode.jsonc" ] && [ ! -f "$HOME/.config/opencode/opencode.json" ]; then
        warn "opencode usa opencode.jsonc (con comentarios): añade a mano en \"mcp\": \"mismem\": {\"type\": \"local\", \"command\": [\"$RUN\", \"mismem\"], \"enabled\": true}"
        continue
      fi
      EDIT='
        const mcp = (config.mcp ??= {});
        const current = JSON.stringify(mcp.mismem?.command ?? null);
        if (mcp.mismem && !current.includes(run) && process.env.REPLACE !== "yes") return "skip";
        mcp.mismem = { type: "local", command: [run, "mismem"], enabled: true };' \
        REPLACE="${REPLACE_EXISTING:-no}" json_edit "$HOME/.config/opencode/opencode.json" && say "  opencode: MCP 'mismem' en opencode.json." || {
        [ $? -eq 4 ] && warn "opencode ya tiene un MCP 'mismem' con otro comando; no lo cambio (REPLACE_EXISTING=yes para reemplazarlo)."
        true
      }
      ;;
    claude-desktop)
      EDIT='(config.mcpServers ??= {}).mismem = { command: run, args: ["mismem"] };' \
        json_edit "$HOME/.config/Claude/claude_desktop_config.json" && say "  Claude Desktop: MCP 'mismem' configurado."
      ;;
    vscode)
      EDIT='(config.servers ??= {}).mismem = { type: "stdio", command: run, args: ["mismem"] };' \
        json_edit "$HOME/.config/Code/User/mcp.json" && say "  VS Code: MCP 'mismem' en mcp.json del usuario."
      ;;
    cursor)
      EDIT='(config.mcpServers ??= {}).mismem = { command: run, args: ["mismem"] };' \
        json_edit "$HOME/.cursor/mcp.json" && say "  Cursor: MCP 'mismem' en ~/.cursor/mcp.json."
      ;;
    *) warn "Cliente desconocido: $client" ; continue ;;
  esac
  CONFIGURED="$CONFIGURED $client"
done

# ---------------------------------------------------------------- 6. consolidación nocturna

if [ "$PROVIDER" != none ] && [ "$TIMER" != no ] && command -v systemctl >/dev/null 2>&1 &&
  systemctl --user show-environment >/dev/null 2>&1; then
  step "Consolidación nocturna"
  if [ -z "$TIMER" ]; then
    confirm "¿Consolidar cada noche a las 4:00 con un timer de systemd de usuario?" n && TIMER=yes || TIMER=no
  fi
  if [ "$TIMER" = yes ]; then
    UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
    mkdir -p "$UNIT_DIR"
    cat >"$UNIT_DIR/mismem-consolidate.service" <<EOF
[Unit]
Description=misMEM: consolidar episodios en memorias

[Service]
Type=oneshot
ExecStart=$RUN mismem-consolidate
EOF
    cat >"$UNIT_DIR/mismem-consolidate.timer" <<'EOF'
[Unit]
Description=misMEM: consolidación nocturna

[Timer]
OnCalendar=*-*-* 04:00
Persistent=true
RandomizedDelaySec=10min

[Install]
WantedBy=timers.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable --now mismem-consolidate.timer >/dev/null
    say "  Timer activo: $(systemctl --user list-timers mismem-consolidate.timer --no-legend | awk '{print $1, $2, $3}')"
  fi
fi

# ---------------------------------------------------------------- 7. comprobación

step "Comprobación"
INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"install.sh","version":"0"}}}'
if printf '%s\n' "$INIT" | timeout 20 "$RUN" mismem 2>/dev/null | grep -q '"serverInfo"'; then
  say "  El servidor MCP responde."
else
  warn "El servidor MCP no respondió al initialize; prueba a mano: $RUN mismem"
fi
"$RUN" mismem-stats >/dev/null 2>&1 && say "  La base abre bien: $DB" || warn "mismem-stats falló; revisa $ENV_FILE"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) say "  Nota: $BIN_DIR no está en tu PATH; los clientes no lo necesitan, pero para usar mismem-run a mano añádelo." ;;
esac

step "Listo"
say "  Clientes configurados:${CONFIGURED:- ninguno}"
say "  Reinícialos para que carguen misMEM. La interfaz: $RUN mismem-http y abre http://127.0.0.1:3200/viewer"
