# Versions and releases

- `VERSION` holds the major and minor number (e.g. `1.0`).
- Every push to a branch and every pull request runs CI (`.github/workflows/ci.yml`): web build, `go vet` and the Go tests against a PostgreSQL service.
- Every push or merge to `main` runs `.github/workflows/release.yml`: tests, then release `v<major.minor>.<run number>` (e.g. `v1.0.42`) with binaries for Linux (amd64, arm64), Windows (amd64) and macOS (Intel, Apple Silicon), `SHA256SUMS.txt`, and a Docker image on GHCR.
- The running version is shown in Settings → About, by `rii_music -version` and by `/api/health`. Local builds report `dev`.

To bump the major or minor version, edit `VERSION`; the patch number comes from the workflow run.
