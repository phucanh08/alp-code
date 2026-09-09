# Native binary v0.10.0 — release readiness

- Date: 2026-09-09 (Asia/Ho_Chi_Minh)
- Branch: `feature/native-binary-distribution`
- Base commit: `610e395ceebe36de7d76db39b3cc2efae607cfee`
- Compiler pin: Bun `1.4.2` (`.bun-version`)
- Local host: Apple M4, arm64, macOS 26.5.2 / Darwin 25.5.0

This record describes local validation artifacts from a dirty implementation worktree. They
are not release assets and must not be uploaded. A release build must come from the reviewed,
clean v0.10.0 source commit so `sourceCommit` and checksums bind the published source.

## Gate evidence

| Gate | Command/evidence | Result |
|---|---|---|
| TypeScript | `npm run typecheck` | pass |
| Build | `npm run build` | pass |
| Unit/integration/E2E | isolated `npm test` | 50 files, 509 tests pass |
| Script regression | every `scripts/test-*.cjs`, isolated HOME | pass; Windows runtime test skipped off-Windows |
| Bun compatibility | `node scripts/test-bun-compat.cjs` | pass |
| Host native black-box | `node scripts/test-binary.cjs` | darwin-arm64 version/state/help/hooks/doctor outside repo, Node absent from PATH |
| POSIX installer | `node scripts/test-installer.cjs` | fresh/repeat/checksum rollback, fake Node/npm fail if called |
| npm wrapper | `node scripts/test-npm-wrapper.cjs` | exact version, safe cache, offline reuse, stable handoff, exit 17 preserved |
| v0.9 migration fixture | `node scripts/test-binary-migration.cjs` | memory/mode hashes preserved; project hook repaired; second run byte-stable |
| Reproducibility | `node scripts/test-binary-build.cjs` | two independent host archives byte-identical |
| Performance | 30 measured launches after 5 warmups | p50 13.45 ms, p95 14.05 ms; gate p95 < 40 ms |
| Cross-build | `build-binary.cjs --all` | five archive structures produced and checksummed |

## Target runtime status

| Target | Cross-build | Matching-host execution | Release status now |
|---|---:|---:|---|
| `darwin-arm64` | pass | pass locally | candidate stable |
| `darwin-x64` | pass | pending `macos-15-intel` CI | withhold stable claim |
| `linux-x64-gnu` | pass | pending `ubuntu-24.04` CI | withhold stable claim |
| `linux-arm64-gnu` | pass | pending `ubuntu-24.04-arm` CI | withhold stable claim |
| `windows-x64` | pass | pending `windows-2025` CI, including junction replacement/uninstall locks | withhold stable claim |

`.github/workflows/native-binary.yml` runs the five matching-host jobs. GitHub's current hosted
runner labels used here are `macos-15`, `macos-15-intel`, `ubuntu-24.04`,
`ubuntu-24.04-arm`, and `windows-2025`.

## Local validation artifact SHA-256

```text
e532c4539e4dc4ad2efbbdeaff11f1f80ddcce69ffa1ded3ea499a210f70bcb2  alp-code-v0.10.0-darwin-arm64.tar.gz
f0c3c42ce3a5a34cb15be43b159d54e0fd93bba89ff9b1872f5e1ae669b8dfbc  alp-code-v0.10.0-darwin-x64.tar.gz
3dfa3b300ad4ad323d8b02598ad7364366d2a708f97adb17d6a9f9985c08f124  alp-code-v0.10.0-linux-arm64-gnu.tar.gz
8622ada2714e96a2fa169e4f73ec4fc1be2d7372653eb93c3b285b758ffae66a  alp-code-v0.10.0-linux-x64-gnu.tar.gz
e47242f586d5772379933ca6a2e6403f2330f2822010b91b1e79097e556163b2  alp-code-v0.10.0-windows-x64.tar.gz
```

## Known limitations / remaining release gates

- Matching-host CI has not run from this local session for darwin-x64, Linux or Windows.
- Windows atomic junction replacement and locked-running-executable cleanup have static/unit
  coverage but need the real `windows-2025` job before release.
- Migration test uses a faithful v0.9 state/project fixture; a registry-backed real
  `npm i -g alp-code@0.9.0` migration remains a release-candidate environment gate.
- Real Claude/Codex invocation is credential/environment dependent and was not performed by
  the no-Node artifact test; adapters and hook contracts are covered by unit/E2E fake runtimes.
- Linux musl, Windows arm64, macOS signing/notarization, Homebrew and size optimization are
  explicitly deferred.

## Publish boundary

No tag, GitHub Release, asset upload, or npm publish was performed. After review, the required
sequence is: commit clean source → run the native matrix → mark only matching-host passes stable
→ build from that exact commit → verify recorded checksums → obtain principal authorization for
tag/publish/upload.
