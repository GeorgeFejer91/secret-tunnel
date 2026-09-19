# Secret Tunnel

A small Tauri desktop app that exposes one selected local folder to ChatGPT through a stable zrok MCP tunnel.

## Licence

Secret Tunnel is released under the [MIT Licence](LICENSE).

It redistributes third-party components under their own licences, notably [gpt-repo-mcp](https://github.com/CAHN91/gpt-repo-mcp), [zrok](https://zrok.io/), and Node.js. See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## Credits

The repository MCP server is based on **gpt-repo-mcp** by Promptiva AB. The vendored source lives in `app/vendor/gpt-repo-mcp/`; Secret Tunnel wraps it with a desktop launcher, local runtime management, and a zrok tunnel.

## Repository layout

| Path | Contents |
| --- | --- |
| `app/` | Tauri application source, Rust backend, build scripts, and vendored MCP server. |
| `docs/` | Static project website. |
| `outputs/checksums/` | Small release checksum metadata. |

Generated verification evidence, local MCP receipts, build products, and retired AI-planning material are intentionally not part of the source tree.

## Download

Windows installers for the current version are published as assets on the
[Releases page](https://github.com/GeorgeFejer91/secret-tunnel/releases). The
installer carries its own Node and zrok runtimes; nothing else has to be
installed first.

## Build

Run from `app/`:

```powershell
npm.cmd install
npm.cmd run prepare:runtime
npm.cmd run build
npm.cmd run tauri build
```

The build prepares the bundled Node/zrok/runtime resources before packaging the desktop app.

## Runtime

Secret Tunnel launches the local MCP server, scopes it to the folder selected in the desktop app, and publishes that MCP endpoint through zrok. GitHub-related capabilities are exposed by the bundled MCP when the GitHub bridge is present and the app is running in the corresponding access mode.

For implementation details, see `app/README.md` and the code itself.
