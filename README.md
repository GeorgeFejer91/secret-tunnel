# Secret Tunnel

A small Tauri desktop app that exposes one selected local folder to ChatGPT through a stable zrok MCP tunnel.

**Website: <https://georgefejer91.github.io/secret-tunnel/>**

## Where the code is

Each version lives on its own branch, so a version's source, its page and its
downloads all name the same version. This branch (`main`) carries only the
website, which is why the source links below are the ones to follow.

| Version | Source | Page | Downloads |
| --- | --- | --- | --- |
| **v1** — released | [`v1` branch](https://github.com/GeorgeFejer91/secret-tunnel/tree/v1) | [/v1/](https://georgefejer91.github.io/secret-tunnel/v1/) | [v0.1.0 installers](https://github.com/GeorgeFejer91/secret-tunnel/releases/tag/v0.1.0) |
| **v2** — current | [`v2` branch](https://github.com/GeorgeFejer91/secret-tunnel/tree/v2) | [/v2/](https://georgefejer91.github.io/secret-tunnel/v2/) | none yet — builds from source |

`main` holds no application code on purpose. GitHub Pages serves a single
branch, so the site has to live on one branch while the versions live on
others; keeping a copy of the current version's code here as well would give
that code two homes and let them drift apart.

## Building a version

Check out the branch you want, then run from `app/`:

```powershell
npm.cmd install
npm.cmd run prepare:runtime
npm.cmd run build
npm.cmd run tauri build
```

The build prepares the bundled Node/zrok/runtime resources before packaging the
desktop app.

## Runtime

Secret Tunnel launches the local MCP server, scopes it to the folder selected in
the desktop app, and publishes that MCP endpoint through zrok. GitHub-related
capabilities are exposed by the bundled MCP when the v2 GitHub bridge is present
and the app is running in the corresponding access mode.

## Credits and licence

Released under the [MIT Licence](LICENSE). Each version branch carries its own
`THIRD-PARTY-NOTICES.md` covering the components that version redistributes,
notably [gpt-repo-mcp](https://github.com/CAHN91/gpt-repo-mcp),
[zrok](https://zrok.io/) and Node.js.

The repository MCP server is based on **gpt-repo-mcp** by Promptiva AB. The
vendored source lives in `app/vendor/gpt-repo-mcp/` on each version branch;
Secret Tunnel wraps it with a desktop launcher, local runtime management, and a
zrok tunnel.
