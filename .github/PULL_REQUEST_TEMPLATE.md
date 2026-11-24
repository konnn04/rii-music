## Summary
<!-- Briefly describe what this change does and why it is needed. -->

## Type of change
- [ ] Feature
- [ ] Bug fix
- [ ] Refactor / improvement
- [ ] Docs / CI

## Changes
- 

## Checklist
- [ ] `go vet ./...`
- [ ] `go test ./...`
- [ ] `cd web && pnpm typecheck`
- [ ] `vi` and `en` locale keys kept in sync (for UI changes)
- [ ] Updated `docs/architecture.md` / `apiDocs` in `internal/server/docs.go` (when changing behavior or adding routes)
- [ ] No edits to shipped migrations; no secrets / `.env` committed
- [ ] (If touching `desktop/`) `cd desktop/src-tauri && cargo check`

## Deployment notes (if any)
<!-- New environment variables, GitHub Secrets, migrations, or post-deploy steps. -->
