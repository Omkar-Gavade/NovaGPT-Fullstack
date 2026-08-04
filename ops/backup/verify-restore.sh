#!/usr/bin/env bash
# Restore a backup into a scratch database and prove it is usable.
#
# **This is the deliverable, not the backup script.** Taking backups is easy and
# every system does it; the failure mode is discovering during an incident that
# the archive is truncated, the key is wrong, or `mongorestore` refuses the
# format. Rehearsing the restore is what converts a hypothesis into a fact.
set -euo pipefail

ARCHIVE="${1:?usage: verify-restore.sh <archive.enc>}"
BACKUP_KEY="${BACKUP_KEY:?BACKUP_KEY is required}"
SCRATCH_URI="${SCRATCH_URI:-mongodb://127.0.0.1:27017}"
SCRATCH_DB="${SCRATCH_DB:-nova_restore_check_$$}"

WORK="$(mktemp -d)"
cleanup() {
  rm -rf "$WORK"
  # The scratch database goes away whether the check passed or failed. A
  # half-restored database left behind is the one someone later mistakes for
  # real data.
  mongosh "$SCRATCH_URI" --quiet --eval "db.getSiblingDB('${SCRATCH_DB}').dropDatabase()" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "  checksum"
if [[ -f "${ARCHIVE}.sha256" ]]; then
  sha256sum -c "${ARCHIVE}.sha256" >/dev/null || { echo "  CHECKSUM MISMATCH — the archive is corrupt"; exit 1; }
else
  echo "  (no checksum recorded; skipping)"
fi

echo "  decrypt"
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
  -in "$ARCHIVE" -out "$WORK/nova.archive" -pass "pass:${BACKUP_KEY}" \
  || { echo "  DECRYPT FAILED — wrong key, or the archive is damaged"; exit 1; }

echo "  restore into ${SCRATCH_DB}"
mongorestore --uri="$SCRATCH_URI" --archive="$WORK/nova.archive" --gzip --quiet \
  --nsFrom='nova.*' --nsTo="${SCRATCH_DB}.*" --drop \
  || { echo "  RESTORE FAILED"; exit 1; }

# A restore that produces an empty database "succeeds". Counting rows is what
# distinguishes a real restore from a no-op.
echo "  smoke-test the restored data"
COUNTS=$(mongosh "$SCRATCH_URI" --quiet --eval "
  const db = db.getSiblingDB('${SCRATCH_DB}');
  JSON.stringify({
    threads: db.threads.countDocuments(),
    users: db.users.countDocuments(),
    indexes: db.threads.getIndexes().length,
  });
")
echo "  restored: $COUNTS"

THREADS=$(sed -n 's/.*"threads":\([0-9]*\).*/\1/p' <<<"$COUNTS")
INDEXES=$(sed -n 's/.*"indexes":\([0-9]*\).*/\1/p' <<<"$COUNTS")

if [[ "${THREADS:-0}" -lt 1 ]]; then
  echo "  RESTORE PRODUCED NO CONVERSATIONS — the archive is not usable"
  exit 1
fi

# Indexes are part of a usable restore. A restored database without them
# answers every sidebar query with a collection scan, which is a restore that
# technically worked and practically did not.
if [[ "${INDEXES:-0}" -lt 2 ]]; then
  echo "  RESTORE IS MISSING INDEXES — queries would fall back to collection scans"
  exit 1
fi

echo "  restore verified"
