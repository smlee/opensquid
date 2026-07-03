#!/usr/bin/env bash
set -euo pipefail

# prune-foreign-workgraphs.sh
#
# The opensquid workgraph store (~/.opensquid/workgraph.db) is keyed by a
# per-project namespace. This removes EVERY namespace except the one belonging
# to the given project (its .opensquid/project.json marker), so the DB holds
# only that project's workgraph.
#
# Safe by default: DRY RUN unless --yes is passed, and it always backs up the
# DB before deleting.
#
# Usage:
#   scripts/prune-foreign-workgraphs.sh [PROJECT_DIR] [--yes]
#     PROJECT_DIR  project whose namespace to KEEP (default: current dir)
#     --yes, -y    actually back up + remove (otherwise just show what would go)
#
# Examples:
#   scripts/prune-foreign-workgraphs.sh                 # dry run for cwd's project
#   scripts/prune-foreign-workgraphs.sh . --yes         # remove foreign namespaces
#   scripts/prune-foreign-workgraphs.sh /path/to/proj --yes

DB="${OPENSQUID_HOME:-$HOME/.opensquid}/workgraph.db"
DO_IT=0
PROJECT_DIR="$PWD"
for a in "$@"; do
  case "$a" in
    --yes|-y) DO_IT=1 ;;
    -*)       echo "unknown option: $a" >&2; exit 2 ;;
    *)        PROJECT_DIR="$a" ;;
  esac
done

MARKER="$PROJECT_DIR/.opensquid/project.json"
[ -f "$DB" ]     || { echo "error: no workgraph DB at $DB" >&2; exit 1; }
[ -f "$MARKER" ] || { echo "error: no project marker at $MARKER" >&2; exit 1; }
command -v sqlite3 >/dev/null || { echo "error: sqlite3 not found on PATH" >&2; exit 1; }

# The project uuid to KEEP, read from the marker.
KEEP=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['uuid'])" "$MARKER")
[ -n "$KEEP" ] || { echo "error: could not read uuid from $MARKER" >&2; exit 1; }

echo "DB:   $DB"
echo "KEEP: $KEEP  (from $MARKER)"
echo
echo "Namespaces currently in the DB:"
sqlite3 -header "$DB" "SELECT project, count(*) AS issues FROM wg_issues GROUP BY project;"
echo

FOREIGN=$(sqlite3 "$DB" "SELECT DISTINCT project FROM wg_issues WHERE project != '$KEEP';")
if [ -z "$FOREIGN" ]; then
  echo "No foreign namespaces. Nothing to remove."
  exit 0
fi

echo "Foreign namespaces (would be removed):"
echo "$FOREIGN" | sed 's/^/  - /'
echo

if [ "$DO_IT" -ne 1 ]; then
  echo "DRY RUN. Re-run with --yes to back up the DB and remove the above."
  exit 0
fi

BK="$DB.bak-prune-$(date +%Y%m%d-%H%M%S)"
cp "$DB" "$BK"
echo "backed up -> $BK"
echo

for P in $FOREIGN; do
  echo "removing namespace $P ..."
  sqlite3 "$DB" "DELETE FROM wg_edges  WHERE from_id IN (SELECT id FROM wg_issues WHERE project='$P') OR to_id IN (SELECT id FROM wg_issues WHERE project='$P');"
  sqlite3 "$DB" "DELETE FROM wg_ops    WHERE project='$P';"
  sqlite3 "$DB" "DELETE FROM wg_issues WHERE project='$P';"
done

echo
echo "Namespaces after removal:"
sqlite3 -header "$DB" "SELECT project, count(*) AS issues FROM wg_issues GROUP BY project;"
echo "Done. Restore with: cp \"$BK\" \"$DB\""
