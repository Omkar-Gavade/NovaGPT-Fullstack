#!/usr/bin/env bash
# Take a backup.
#
# Encrypted with a key that is **not** the database's own
# (docs/backend/11-observability.md, docs/backend/10-security.md#encryption): a
# backup readable by whoever compromised the database is not a backup, it is a
# second copy of the breach.
set -euo pipefail

MONGODB_URI="${MONGODB_URI:?MONGODB_URI is required}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/novagpt}"
BACKUP_KEY="${BACKUP_KEY:?BACKUP_KEY is required — an unencrypted backup is a liability}"
RETAIN_DAYS="${RETAIN_DAYS:-30}"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ARCHIVE="${BACKUP_DIR}/nova-${STAMP}.archive"

mkdir -p "$BACKUP_DIR"

echo "Dumping to ${ARCHIVE}.gz.enc"

# `--archive` plus `--gzip` streams a single compressed file rather than a
# directory tree, so the whole thing is one atomic artefact to move and verify.
mongodump --uri="$MONGODB_URI" --archive="$ARCHIVE" --gzip --quiet

# AES-256 with a key derived by PBKDF2. `-salt` is on by default in modern
# OpenSSL and is stated here anyway, because a saltless backup encrypted with a
# reused key is vulnerable to comparison across snapshots.
openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
  -in "$ARCHIVE" -out "${ARCHIVE}.enc" -pass "pass:${BACKUP_KEY}"
rm -f "$ARCHIVE"

# A checksum recorded at write time. Without it, a restore cannot tell a corrupt
# archive from a wrong decryption key — the failure looks identical.
sha256sum "${ARCHIVE}.enc" > "${ARCHIVE}.enc.sha256"

SIZE=$(du -h "${ARCHIVE}.enc" | cut -f1)
echo "Wrote ${ARCHIVE}.enc ($SIZE)"

# A backup that has never been restored is a hypothesis. This runs a real
# restore into a scratch database on every backup, so the discovery that the
# procedure is broken happens on an ordinary Tuesday rather than during an
# incident (docs/backend/13-deployment.md).
if [[ "${VERIFY:-1}" == "1" ]]; then
  echo "Verifying by restoring into a scratch database"
  BACKUP_KEY="$BACKUP_KEY" "$(dirname "$0")/verify-restore.sh" "${ARCHIVE}.enc"
fi

# Prune only *verified* backups: deleting an old one to make room for a new one
# that was never checked is how a retention policy destroys the last good copy.
find "$BACKUP_DIR" -name 'nova-*.archive.enc' -mtime "+${RETAIN_DAYS}" -print -delete
echo "Done."
