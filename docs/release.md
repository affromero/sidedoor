# Release operations

A `v*` tag starts the release workflow. The tag must match the root package version. Core and native packages have their own versions, and core pins the native version it was tested with. Bump every package whose archive changed and regenerate the lockfile before tagging.

The verification job has no npm publishing credential. It runs the code checks, release-orchestration tests, formatting and installed-consumer tests. It retains the exact verified archives and their SHA512 integrity values for 90 days.

The publishing job downloads those archives and preflights all package versions before its first write. `NPM_TOKEN` must authorize publication of `thesidedoor`, `thesidedoor-core` and `thesidedoor-flock`. Missing authentication, a registry error, an archive mismatch or an internal dependency mismatch stops the release.

Publication proceeds in dependency order: native locking, core, then UI/connectivity. Packages publish with [npm provenance](https://docs.npmjs.com/generating-provenance-statements/). Each archive includes the matching public repository metadata. The script uses the supported tarball input to [`npm publish`](https://docs.npmjs.com/cli/v11/commands/npm-publish/) and does not rebuild the verified archive.

## A partial publication

Publication across packages is not atomic. If a later package fails, keep the retained workflow artifact and rerun the failed publishing job. The script verifies previously published versions against those exact archives before skipping them. A version with different contents is a conflict; do not replace the artifact to bypass it.

If registry propagation delays verification after a successful publish, rerun verification against the same artifact. The script reports each completed package. The concurrency group prevents simultaneous release runs. GitHub Actions may replace an older pending run when another tag arrives, so check each intended tag's workflow status.

## Acceptance

The final job installs the exact public versions in a fresh directory with an empty cache, then performs a clean `npm ci`. It compares the lockfile integrity values, checks native transitive resolution and actual file locking, loads ESM and CommonJS exports, and runs the AI example against a local HTTP fixture. This step receives no npm publication token.

These gates test package distribution. Each consuming application must also pass its own migrations, UI and runtime checks before upgrading its deployment.
