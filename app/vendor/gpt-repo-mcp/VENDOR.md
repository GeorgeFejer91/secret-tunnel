# Vendored: gpt-repo-mcp

This directory is **not original work**. It is a vendored copy of the
`gpt-repo-mcp` MCP server, which is the component that actually exposes a folder
to ChatGPT. Secret Tunnel is the launcher and tunnel around it.

| | |
|---|---|
| Original project | <https://github.com/CAHN91/gpt-repo-mcp> |
| Author | Promptiva AB |
| Licence | MIT — see [LICENSE](./LICENSE) |
| Upstream commit | `986f2135f00959f8e0d214ed8d173a7054f4cea1` |
| Fork carrying the changes below | <https://github.com/GeorgeFejer91/gpt-repo-mcp/tree/sandbox-containment-hardening> (`ca6d7b5`) |

The MIT licence and the original copyright notice are retained in `LICENSE` and
must stay with any copy or redistribution of this directory.

## Why it is vendored

The build previously cloned upstream at build time. That made the shipped
installer depend on whatever upstream `HEAD` happened to be, and it silently
diverged from the binary that had actually been tested: the working, verified
build on the developer's machine contained an uncommitted local fix that no
clean clone would ever produce. Vendoring makes the bundled server exactly the
reviewed source, recorded in git alongside the launcher that ships it.

## The modifications

All are pushed to the fork above so they can be offered upstream as pull
requests; none is intended as a permanent divergence. Each has regression tests
in the fork that fail without the corresponding fix.

### 1. Read-only mode actually removes write tools

`src/register.ts` honours `GPT_REPO_READ_ONLY_SURFACE=1` by filtering the tool
catalogue to tools whose annotations declare `readOnlyHint`.

Without it, "Read" mode still registered every tool, so `tools/list` advertised
21 write-capable tools — including `repo_write_file`, `repo_write_commit` and
`repo_apply_patchset` — to a client that had been told it had read-only access.
Secret Tunnel's Read mode depends entirely on this filter being applied.

### 2. Containment holds across filesystem roots

`isWithin` (path-sandbox) and `assertWithinRoot` (file-writer) decided
containment by looking for `..` in the output of `relative()`. When the two
paths share no common root — on Windows, any cross-drive pair such as `C:\repo`
against `D:\elsewhere` — `relative()` returns an absolute path containing no
`..` at all, so an entirely different drive was judged to be inside the
repository. Both now reject an absolute result.

The same change stops a file named `..config` being mistaken for traversal.

### 3. Absolute-path detection covers the awkward forms

`validateRepoPath` now also rejects NUL bytes, UNC paths on POSIX hosts, and
drive-**relative** paths such as `C:file` — which `win32.isAbsolute` reports as
relative, yet Windows resolves against that drive's current directory rather
than the repository.

### 4. Literal replacement is literal

`String.prototype.replace` with a string replacement expands `$&`, `` $` ``,
`$'`, `$1` and `$$`. A caller asking to replace one literal string with another
got the matched text re-inserted instead of the characters it supplied. The
replacement is now passed as a function.

## Updating this copy

1. Pull the change into the fork and rebase it on the newer upstream commit.
2. Re-copy `src/`, `package.json`, `package-lock.json`, `tsconfig.json` and
   `LICENSE` here.
3. Update `upstreamCommit` and `forkCommit` in `VENDOR.json`; they are recorded
   into the runtime manifest that ships inside the installer, so they must
   describe the code actually bundled.
4. Run `npm run prepare:runtime` and `npm run smoke:mcp` from `app/`.

Tests, docs, scripts and CI config are deliberately not vendored — only what is
needed to build `dist/server.js`. Run the full suite in the fork instead.

## Local MCP bridge overlay, 17 September 2026

The fork publication statements above describe the earlier upstream/fork changes, not this new local overlay. The current VENDOR.json records base fork 93274e2 and a separate localMcpBridgeOverlay with source hashes. This workstream has not pushed these changes to that fork.

The existing github-bridge.ts now imports a bounded github-broker-client.mjs with a TypeScript declaration. It pins the loopback origin and three routes, rejects redirects, bounds responses/deadlines/concurrency, projects sanitized DTO fields, retains local approval authority and advertises only the currently implemented local-commit action. register.ts remains the existing registration point.

Isolated client/handler checks: 96 passed. The real SDK/type gate is not established here. The test fixtures are supplied in the separate reviewed verification package because the repository secret guard refused their write; the verifier deliberately fails when required inputs are missing. See For-AI/PROTOCOLS/github-bridge-verification.md from the repository root.

The existing runtime preparation code does not automatically enforce or emit this overlay record. Before release, either integrate and re-vendor a full reviewed fork revision or explicitly include/verify the overlay source and final server.js hashes. Do not describe the modified source as exactly equal to the older fork merely because its base forkCommit field remains unchanged.
