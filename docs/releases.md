# Versions and releases

## Branches

- `feat/*`: one feature each, branched from `dev` (or `main`).
- `dev`: the beta line; finished features are merged here and tested on a beta install before release. CI runs on every push, and the desktop workflow builds every platform: the installers are in the run's artifacts (Actions → Desktop → the run → Artifacts), nothing is published.
- `main`: releases. Merging `dev` into `main` (by pull request, after review) publishes the server image and the desktop app (`desktop-v<version>` + the `desktop-latest` update manifest). If one desktop platform fails to build — e.g. GitHub has no macOS arm64 runner free — the others are still published and the update manifest lists only those; re-run the failed job or push again.

## Releases

- `VERSION` holds the major and minor number (e.g. `1.0`).
- Every push to a branch and every pull request runs CI (`.github/workflows/ci.yml`): web build, `go vet` and the Go tests against a PostgreSQL service.
- Every push or merge to `main` runs `.github/workflows/release.yml`: tests, then release `v<major.minor>.<run number>` (e.g. `v1.0.42`) with binaries for Linux (amd64, arm64), Windows (amd64) and macOS (Intel, Apple Silicon), `SHA256SUMS.txt`, and a Docker image on GHCR.
- The running version is shown in Settings → About, by `rii_music -version` and by `/api/health`. Local builds report `dev`.

To bump the major or minor version, edit `VERSION`; the patch number comes from the workflow run.
