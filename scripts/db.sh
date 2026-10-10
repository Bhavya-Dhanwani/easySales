#!/usr/bin/env sh
# MongoDB backup / restore / restore-verification using the official mongo image (no local tools needed).
#   scripts/db.sh backup  [uri]            -> backups/easysales-<timestamp>.archive.gz
#   scripts/db.sh restore <file> [uri]     -> restores into the database in <uri> (drops existing collections)
#   scripts/db.sh verify  [uri]            -> backs up, restores into <db>_restore_check, compares document counts
set -eu
# Git Bash on Windows rewrites path-like arguments; keep them literal (no-op elsewhere)
export MSYS_NO_PATHCONV=1
URI_DEFAULT="mongodb://host.docker.internal:27017/easysales"
DIR="$(cd "$(dirname "$0")/.." && (pwd -W 2>/dev/null || pwd))/backups"
mkdir -p "$DIR"
mongo() { docker run --rm -v "$DIR:/backups" mongo:7 "$@"; }

counts() { # prints "collection count" lines for a database URI
  docker run --rm mongo:7 mongosh "$1" --quiet --eval 'db.getCollectionNames().sort().forEach(c => print(c + " " + db.getCollection(c).countDocuments()))'
}

case "${1:-}" in
  backup)
    URI="${2:-$URI_DEFAULT}"; FILE="easysales-$(date +%Y%m%d-%H%M%S).archive.gz"
    mongo mongodump --uri="$URI" --gzip --archive="/backups/$FILE"
    echo "$DIR/$FILE" ;;
  restore)
    FILE="$(basename "$2")"; URI="${3:-$URI_DEFAULT}"
    mongo mongorestore --uri="$URI" --gzip --archive="/backups/$FILE" --drop ;;
  verify)
    URI="${2:-$URI_DEFAULT}"; DB="${URI##*/}"; BASE="${URI%/*}"
    FILE="$(basename "$("$0" backup "$URI" | tail -1)")"
    mongo mongorestore --uri="$BASE" --gzip --archive="/backups/$FILE" --drop --nsFrom="$DB.*" --nsTo="${DB}_restore_check.*"
    if [ "$(counts "$URI")" = "$(counts "$BASE/${DB}_restore_check")" ]; then echo "RESTORE OK: $FILE"; else echo "RESTORE MISMATCH: $FILE"; exit 1; fi
    docker run --rm mongo:7 mongosh "$BASE/${DB}_restore_check" --quiet --eval 'db.dropDatabase()' >/dev/null ;;
  *) echo "usage: $0 backup [uri] | restore <file> [uri] | verify [uri]"; exit 2 ;;
esac
