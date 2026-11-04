#!/usr/bin/env bash
# Backup / restore of a Blackbox installation.
#
#   scripts/backup.sh backup  [OUT_DIR]   # → OUT_DIR/blackbox-<timestamp>.tar.gz (default OUT_DIR: backups/)
#   scripts/backup.sh restore ARCHIVE     # stop Blackbox first; the current DATA_DIR is kept aside
#
# The archive holds what cannot be recreated:
#   - the database: SQLite snapshot (VACUUM INTO, safe while running) or `pg_dump -Fc` when DATABASE_URL is Postgres;
#   - agent-home/  agent sessions (needed to resume conversations), git/ (local provider repositories),
#     attachments/, secrets.key (encrypts application secrets when SECRETS_KEY is not set).
# Not included: workspaces/ (re-cloned on demand) and kubeconfig-local.
#
# Settings come from the environment, else from .env: DATA_DIR (default ./data), DATABASE_URL.
# With Postgres, pg_dump/pg_restore must match the server's major version (override with PG_DUMP / PG_RESTORE,
# e.g. PG_DUMP="docker run --rm -i --network host postgres:17-alpine pg_dump").
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
from_env_file() { [ -f "$ROOT/.env" ] && grep -E "^$1=" "$ROOT/.env" | tail -1 | cut -d= -f2- || true; }
DATA_DIR="${DATA_DIR:-$(from_env_file DATA_DIR)}"
DATA_DIR="${DATA_DIR:-$ROOT/data}"
DATABASE_URL="${DATABASE_URL:-$(from_env_file DATABASE_URL)}"
PG_DUMP="${PG_DUMP:-pg_dump}"
PG_RESTORE="${PG_RESTORE:-pg_restore}"
KEEP=(agent-home git attachments secrets.key)
staging="" # temp dir, global so the EXIT trap can clean it up

is_postgres() { [[ "$DATABASE_URL" == postgres* ]]; }

backup() {
  local out="${1:-$ROOT/backups}" stamp archive
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "$out"
  staging="$(mktemp -d)"
  trap 'rm -rf -- "${staging:?}"' EXIT
  mkdir -p "$staging/db"
  if is_postgres; then
    echo "→ dumping Postgres"
    $PG_DUMP --format=custom --no-owner "$DATABASE_URL" > "$staging/db/postgres.dump"
  else
    echo "→ snapshotting SQLite ($DATA_DIR/blackbox.db)"
    node -e 'const [src, dst] = process.argv.slice(1); new (require("node:sqlite").DatabaseSync)(src).prepare("VACUUM INTO ?").run(dst)' \
      "$DATA_DIR/blackbox.db" "$staging/db/blackbox.db"
  fi
  for item in "${KEEP[@]}"; do
    [ -e "$DATA_DIR/$item" ] && cp -a "$DATA_DIR/$item" "$staging/"
  done
  archive="$out/blackbox-$stamp.tar.gz"
  tar -C "$staging" -czf "$archive" .
  echo "✓ $archive ($(du -h "$archive" | cut -f1))"
}

restore() {
  local archive="${1:?usage: backup.sh restore ARCHIVE}" aside
  [ -f "$archive" ] || { echo "✗ $archive not found" >&2; exit 1; }
  staging="$(mktemp -d)"
  trap 'rm -rf -- "${staging:?}"' EXIT
  tar -C "$staging" -xzf "$archive"
  if [ -d "$DATA_DIR" ] && [ -n "$(ls -A "$DATA_DIR")" ]; then
    aside="$DATA_DIR.before-restore-$(date -u +%Y%m%dT%H%M%SZ)"
    mv "$DATA_DIR" "$aside"
    echo "→ current data moved to $aside"
  fi
  mkdir -p "$DATA_DIR"
  for item in "${KEEP[@]}"; do
    [ -e "$staging/$item" ] && cp -a "$staging/$item" "$DATA_DIR/"
  done
  if [ -f "$staging/db/postgres.dump" ]; then
    is_postgres || { echo "✗ the archive holds a Postgres dump: set DATABASE_URL" >&2; exit 1; }
    echo "→ restoring Postgres (existing objects are replaced)"
    $PG_RESTORE --clean --if-exists --no-owner --dbname "$DATABASE_URL" < "$staging/db/postgres.dump"
  else
    cp "$staging/db/blackbox.db" "$DATA_DIR/blackbox.db"
  fi
  echo "✓ restored into $DATA_DIR — start Blackbox again (workspaces are re-cloned on the next run)"
}

case "${1:-}" in
  backup) backup "${2:-}" ;;
  restore) restore "${2:-}" ;;
  *) sed -n '2,15p' "$0"; exit 1 ;;
esac
