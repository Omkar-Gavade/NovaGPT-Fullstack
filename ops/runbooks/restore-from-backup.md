# Runbook — Restore from backup

**Not an alert.** This is the procedure for data loss: a dropped collection, a
bad migration, or a lost cluster.

## Before you touch anything

**Stop writes first.** Restoring underneath a running application produces a
database that is neither the backup nor the current state, and nothing will tell
you which rows are which.

```bash
kubectl -n novagpt-production scale deployment/novagpt-api --replicas=0
```

The catalog goes down with it. That is the correct trade: serving reads from a
database you are about to overwrite is worse than a maintenance page.

## Confirm you have a good backup

```bash
BACKUP_KEY=… ops/backup/verify-restore.sh /var/backups/novagpt/nova-<stamp>.archive.enc
```

This restores into a **scratch** database and counts rows and indexes. It is the
same script that runs after every backup, so a failure here means the last
verification also failed and was missed — check the backup job's logs before
reaching for an older archive.

Pick the newest archive that verifies. An older archive that verifies beats a
newer one that does not.

## Restore

```bash
mongorestore --uri="$MONGODB_URI" --archive=<decrypted> --gzip --drop
```

`--drop` replaces each collection. Without it, a restore *merges* into whatever
is there, which is how a restore produces duplicate conversations and an
inconsistent audit log.

## Verify before letting traffic back

1. Row counts are in the right order of magnitude for the backup's timestamp.
2. Indexes exist — `db.threads.getIndexes()` should show the compound sidebar
   index. A restore without indexes technically worked and practically did not.
3. Scale to **one** replica and run the smoke test:
   `ops/deploy/smoke.sh https://api.novagpt.example`

## Verify recovery

Smoke test green, then scale back to normal. Watch the error rate for ten
minutes: a restore that lost a unique index shows up as duplicate-key errors
under real traffic and nowhere else.

## Afterwards

Write down the window of data that was lost — between the backup's timestamp and
the incident — and tell affected users. A silent gap is discovered later by
someone whose conversation vanished.
