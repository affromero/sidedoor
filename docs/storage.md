# Storage

Sidedoor gives local filesystem storage, Cloudflare R2 and generic S3 the same
ownership and cleanup contract. The application chooses and configures the backend.
Sidedoor records which physical destination owns each reference and which application
rows consume it.

## Backend choices

| Backend                         | Captured identity                                                      | Typical use                                       |
| ------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------- |
| Local filesystem                | Canonical root, device, inode and binding hash                         | One host with a persistent volume or mounted disk |
| Cloudflare R2                   | Endpoint, bucket, credential revision, signing region and URL encoding | S3-compatible object storage without AWS regions  |
| Amazon S3 or compatible service | Endpoint, bucket, credential revision, signing region and URL encoding | Versioned or unversioned object storage           |

Local storage is a production backend. Mount its root on persistent media and share
that volume with every process that reads or writes files. Sidedoor rejects a missing,
replaced or symlinked historical root instead of reading another directory.

R2 and S3 use the object adapter. The app supplies a client for the captured endpoint,
bucket and credential revision. Cleanup supports unfinished multipart uploads. The S3
port can also enumerate and remove object versions and deletion markers.

## Write contract

Register the backend and prepare the asset before external I/O. The prepared record
contains an immutable operation ID, physical key, application reference, consumers
and erasure scopes. Commit the write intent in the same Serializable transaction that
authorizes the operation. Publish the application reference only after the backend
confirms the write.

Every reader resolves the stored reference through its retained backend registration.
Changing the active backend affects new writes. Existing references continue to use
their captured local root or object destination until an explicit migration publishes
replacement references.

## Migration

A migration inventories current consumers and their captured source backend. It copies
each asset to a prepared destination, verifies the result, and replaces all consumers
in one transaction. Shared assets move as one unit. Stale consumers, unknown URLs,
changed ownership and missing scope proof stop publication.

## Deletion and recovery

Application deletion first creates a cleanup job, forbids new writes for the subject,
retires its consumers and records exact attributed targets. These changes commit with
the application row deletion. Physical I/O begins after commit.

The runner holds a dedicated lock for every physical backend binding. It collects at
most 1,000 targets per page, deletes them, scans again to verify absence and then marks
the job complete. A lost response or backend disconnect leaves an unconfirmed
execution. `CleanupExecutionJournal.current(binding)` returns the execution that owns
the gate. Resume only after evidence establishes that its remote operations settled
or stopped before dispatch.

Do not implement account deletion with a raw prefix scan or best-effort `Promise`
cleanup. Those paths can delete a shared asset, miss a historical backend or report
success while files remain. Use the reference registry, cleanup journal and runner for
profiles, courses, factory resets and any product-specific erasure scope.
