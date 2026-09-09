# Spike: bun compile vs Node SEA — số đo thật

**Ngày:** 2026-09-07 · **Máy:** darwin arm64, macOS 25.5 · **Repo:** alp-code v0.9.0 @ `610e395`

Mọi con số dưới đây đo bằng lệnh ghi kèm, không suy diễn. Đây là bằng chứng cho §1 và §2 của
[`../plan.md`](../plan.md).

## Môi trường

```
claude → ~/.local/share/claude/versions/2.1.261        Mach-O arm64   190 MB
codex  → ~/.codex/packages/standalone/…/bin/codex      Mach-O arm64   210 MB
alp    → ~/.npm-global/lib/node_modules/alp-code/…     node script    8.9 MB
node   → /usr/local/Cellar/node/26.3.0/bin/node        Mach-O x86_64  37 KB
```

Node ở đây là launcher 37 KB link động vào `libnode.147.dylib` (72 MB) + ~12 dylib Homebrew,
**x86_64 chạy Rosetta trên máy arm64**:

```console
$ otool -L /usr/local/Cellar/node/26.3.0/bin/node | head -2
	@rpath/libnode.147.dylib
$ lipo -info /usr/local/Cellar/node/26.3.0/bin/node
Non-fat file: … is architecture: x86_64
$ node -p "[process.platform, process.arch].join(' ')"
darwin x64
```

Đây là môi trường của một máy, không phải của mọi máy. Nhưng nó minh hoạ đúng vấn đề: Node đến
từ đâu và ở kiến trúc nào nằm ngoài tầm kiểm soát của ALP, còn `claude`/`codex` thì không.

## Bundle

```console
$ ./node_modules/.bin/esbuild scripts/alp.cjs --bundle --platform=node --format=cjs
  59.1kb          ← CLI KHÔNG có trong đây; require(entry) là đường dẫn động
$ ./node_modules/.bin/esbuild src/cli/alp.ts --bundle --platform=node --format=cjs
  735.8kb         ← không một cảnh báo
$ … --minify
  429.5kb
```

## bun compile

```console
$ bun build --compile --minify --target=bun-darwin-arm64 src/cli/alp.ts --outfile alp-bun
  bundle  149 modules
  compile alp-bun
$ ./alp-bun --version
alp 0.9.0                ← chạy được ngay lần đầu
```

Cross-compile, tất cả từ máy macOS này:

| target | kết quả | size |
|---|---|---|
| `bun-darwin-arm64` | OK | 59.5 MB (62.1 với `--bytecode`) |
| `bun-darwin-x64` | OK | 66.3 MB |
| `bun-linux-x64` | OK | 77.7 MB |
| `bun-linux-arm64` | OK | 77.7 MB |
| `bun-windows-x64` | OK | 82.3 MB |

## Node SEA

```console
$ cat sea.json
{ "main": "cli.min.cjs", "output": "sea-prep.blob", "disableExperimentalSEAWarning": true }
$ node --experimental-sea-config sea.json
Wrote single executable preparation blob to sea-prep.blob
```

Inject vào node **có sẵn trên máy** → binary chết:

```console
$ cp "$(command -v node)" alp-sea && npx postject alp-sea NODE_SEA_BLOB sea-prep.blob …
$ ./alp-sea --version
dyld[…]: Library not loaded: @rpath/libnode.147.dylib
```

Phải tải node chính thức (144 MB) mới build được:

```console
$ curl -fsSLO https://nodejs.org/dist/v26.3.0/node-v26.3.0-darwin-arm64.tar.gz
$ cp node-v26.3.0-darwin-arm64/bin/node alp-sea && chmod u+w alp-sea
$ codesign --remove-signature alp-sea
$ npx postject alp-sea NODE_SEA_BLOB sea-prep.blob \
    --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 \
    --macho-segment-name NODE_SEA
💉 Injection done!
$ codesign --sign - alp-sea
$ ./alp-sea --version
ERROR     cannot locate alp-code repository root     ← §2.1 của plan
$ ALP_REPO_ROOT=… ./alp-sea --version
alp 0.9.0
```

## Startup (10 lần, `--version`, ms/run)

```
alp (npm, node x64/Rosetta)  233
node -e 0 (baseline)         109
Node SEA (node 26, arm64)     44
bun compile                   33
bun compile --bytecode        25
claude (tham chiếu)           18
codex  (tham chiếu)           16
```

## Kết luận

| | bun | SEA |
|---|---|---|
| size | **59.5 MB** | 136.7 MB |
| startup | **25–33 ms** | 44 ms |
| cross-compile 5 target từ 1 máy | **có** | không (codesign phải chạy đúng OS) |
| build cần gì | `bun` | esbuild + node chính thức 144 MB/target + `postject` + `codesign` |
| runtime | JavaScriptCore + node-compat ⚠️ | V8 + Node, y hệt bản đang chạy |

Chọn **bun**. Rủi ro duy nhất là node-compat, và nó được đóng bằng gate NB-0. SEA giữ làm đường
lùi, dùng chung đúng cái bundle mà NB-1 tạo ra.

## Lỗi tìm được, đúng cho cả hai đường

1. `findRepoRoot(__dirname)` — `src/cli/alp.ts:170` — gãy trong binary (SEA báo thẳng; bun chạy
   được do bunfs tình cờ resolve trúng, không đáng tin).
2. Bundle từ `scripts/alp.cjs` ra 59 KB thay vì > 400 KB — `require(entry)` đường dẫn động,
   `scripts/alp.cjs:84`.
3. Require runtime bằng đường dẫn dựng lúc chạy: `delegate.ts:106`, `update-check.ts:67`.
4. Bảy chỗ spawn `process.execPath` coi nó là Node — xem plan §2.
