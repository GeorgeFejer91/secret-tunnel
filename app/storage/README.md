# Storage Box module

One optional Hetzner SFTP connection in a V3 tab (slot 6). No peer network, mount,
automatic sync, provider framework, public storage API, or background full scan.
The existing MCP URL stays the entry point. The desktop owns the credentials.

## What is implemented

- Configure a Box account, test SSH identity/authentication/read access, then
  explicitly enable ChatGPT access. Defaults grant no access.
- Browse one directory in bounded pages. The directory snapshot detects changes
  between pages; pagination is over a bounded remote enumeration, not a remote database.
- Read UTF-8 ranges directly, including ranges from files larger than 128 KiB.
  Only a complete read returns a whole-file SHA-256.
- Create or replace UTF-8 files up to 128 KiB. Replacement needs that SHA-256,
  stages and verifies data, retains the previous version, then verifies the result.
- Copy one regular file, including binary files, between the Box and an approved
  local folder. Sources are retained; existing destinations are refused at preflight.
- Persistent operation IDs and receipts. Submitted/running is not completed.
  Interrupted or uncertain writes are never automatically replayed.

Tools: `storage_status`, `storage_list`, `storage_read`, `storage_write`,
`storage_copy`, `storage_job`. They are registered in the existing MCP process;
write/copy tools are omitted on its read-only surface. The desktop independently
checks the current global mode, storage grants, and revision for each operation.
Copies also require the separate local-transfer grant. A folder removed from the
Folders tab cannot remain a transfer destination via stale managed configuration.

## Setup

1. Install a current native rclone executable from its official distribution.
   This optional dependency is selected locally; the app does not silently download
   or execute an installer. Keep it outside every folder exposed to ChatGPT.
2. Use a dedicated Hetzner subaccount when access must be restricted to one folder.
   **The module exposes the account's server-side root**, not a cosmetic subfolder
   selector. A main account grants broad access. Set appropriate permissions at Hetzner.
3. Verify Hetzner's SSH host fingerprint independently and create a trusted OpenSSH
   `known_hosts` entry. Port 23 normally uses `[hostname]:23`. Do not blindly trust
   `ssh-keyscan` output. The verified file is mandatory; verification cannot be disabled.
4. In **Storage Box → Configure**, enter the main Box hostname
   `u123456.your-storagebox.de`, username (main or `u123456-sub1`), and port 23 or 22.
   Port 23 requires extended SSH enabled at Hetzner. Choose the rclone executable,
   known_hosts file, and either a password or an unencrypted private-key file.
   Credentials and runtime files must remain outside all exposed local roots.
5. Save, Test, and Enable. Test is read-only and does **not** claim remote write
   permission. Saving/changing the connection disables access until retested.
6. To write, enable the module's write checkbox and the Overview's global
   Read+write mode. Enable transfers separately when local↔Box copies are needed.
   The remote account's own permissions remain authoritative.

Passwords are Windows user-scoped DPAPI-protected using the app's existing helper.
On other platforms that helper uses a permission-restricted **unencrypted** file;
the UI states this. Key files remain at their selected location. Passwords, keys,
rclone configuration, and broker credentials never enter model tool arguments.
The rclone child receives a clean, explicit environment, not the caller's remotes,
proxy settings or SSH agent. Its raw stderr is not returned or logged.

The current core app still needs its normal selected local folder/tunnel startup.
This module does not add a separate storage-only startup mode. The laptop and app
must stay running for ChatGPT access.

## Implementation map

- `../index.html`: the `panel-storage` panel, the `tab-storage` button and the
  three modal sheets, written in directly like every other module. Slot 6 was the
  first free one; slots 3-5 are Security Center, Network and System Prompt. There
  is no build-time HTML injection and no second module script. Actions window
  untouched.
- `../src/storage.ts`: controls, text editor and operation receipts, exported as
  `wireStorage(fit)` and called from `main.ts`. Status labels are marked
  `data-fit` and measured by the application's shared fitter rather than a second
  copy of it. Styles live in `../src/styles.css`. Fixed window geometry unchanged.
- `../src-tauri/src/storage.rs`: Tauri command, protected settings, current grants,
  private loopback broker and one-operation journal. Broker failure is not fatal
  to the rest of the app. No configuration endpoint is exposed over MCP.
- `worker.mjs`: private stdin/stdout worker invoking fixed rclone commands. No shell
  interpreter, unrestricted rclone RC server, remote execution, or delete/sync tool.
- `../vendor/gpt-repo-mcp/src/storage-bridge.ts`: six tools and explicit descriptions.
- `tauri.conf.json`: packages this worker alongside the existing runtime resources.

One operation at a time keeps the first version predictable. rclone is limited
  to three connections with one checker and one transfer; two can deadlock that
  combination. Large transfers run outside the lifetime of an MCP tool response.
A small write may also return a job ID: always inspect its final receipt.

## Deliberate limits and concurrency contract

- **Not a distributed transaction.** Expected-hash checks are optimistic, not
  atomic compare-and-swap. Do not run competing external writers against the same
  paths. Use versioned names or a single-writer workflow for contested files.
- SFTP symlinks are omitted from listings and existing path components are checked.
  Those preflights do not defeat a hostile same-account writer racing path changes.
  Server-side subaccount confinement, not `skip_links`, is the real remote boundary.
- Credential/internal filename exclusions are defense in depth, not content scanning.
  Authorized text is returned as data; it is not redacted or treated as instructions.
- Binary documents can be copied, but this module does not convert PDFs, DOCX, PPTX,
  images or spreadsheets into model-readable text. Partial text previews cannot be
  submitted by the editor as whole-file replacements.
- One regular file per copy; no recursive folder transfer, sync, source deletion,
  byte-range resume, SSH-agent authentication, or passphrase dialog in this version.
  Parent directories must already exist. Local download completion uses a same-volume
  hard-link/no-clobber creation; unsupported filesystems return an error.
- Verification reads back data, including large files, which costs bandwidth.
  Receipts name `sha256_readback`, not an assumed server checksum.
- Previous text versions live under `.secret-tunnel-history/<requestId>`.
  Interrupted staging files use `.secret-tunnel-part-<requestId>`. These are excluded
  from the model surface. Inspect/clean them manually after reconciling receipts;
  no automatic retention or deletion service has been added.
- Disconnect revokes the grant. An operation interrupted around a remote commit may
  have an unknown outcome. Inspect its destination; do not create a new retry ID blindly.
- The app must run its packaged Node/worker outside folders editable through MCP.
  Developer-mode testing should expose a separate disposable folder, not the runtime.

## Verification and local build

From `app/`:

```powershell
node --test storage/worker.test.mjs storage/integration.test.mjs
npm ci
npm run prepare:runtime
npm run build
cd src-tauri
cargo fmt --all
cargo check --locked --all-targets
cargo test --locked
cd ..
npm run tauri build
```

The dependency-free tests exercise a simulated SFTP filesystem, actual child-process
argument/environment handling, binary copies in temporary local folders, path rules,
UTF-8 bounds, conflicts, revocation, UI wiring and MCP response handling. They are not
proof of a real Hetzner round trip or a compiled Tauri installation.

Before release, verify the **installed** Windows build with a disposable subaccount:
list/read, create, replace with correct/stale hashes, upload/download a binary file,
restart during an operation, disconnect, read-only denials, and path escapes. Inspect
host-key rejection with a deliberately wrong known_hosts fixture. Confirm all six MCP
tools after rebuilding/restarting the app and refreshing its ChatGPT tool definitions.
Never use production files for destructive/interrupt tests.

## Primary references

- https://rclone.org/sftp/ — authentication, known_hosts, link limitations and connection budget.
- https://rclone.org/commands/rclone_obscure/ — stdin password input; obscuring is not encryption.
- https://rclone.org/docs/ — copy/immutable/backup behavior and concurrency limitations.
- https://docs.hetzner.com/storage/storage-box/access/access-sftp-scp/ — provider access and fingerprints.
