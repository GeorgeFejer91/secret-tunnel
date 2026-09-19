import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const [
  html,
  css,
  mainTs,
  mainLib,
  commandsRs,
  processRs,
  settingsRs,
  tauriConfigRaw,
  defaultCapabilitiesRaw,
  flowSvg,
  liveE2e,
  cleanRelease,
  prepareMcp,
  workflow,
] = await Promise.all([
  read("index.html"),
  read("src/styles.css"),
  read("src/main.ts"),
  read("src-tauri/src/lib.rs"),
  read("src-tauri/src/commands.rs"),
  read("src-tauri/src/process.rs"),
  read("src-tauri/src/settings.rs"),
  read("src-tauri/tauri.conf.json"),
  read("src-tauri/capabilities/default.json"),
  read("public/secret-tunnel-flow.svg"),
  read("scripts/smoke-live-e2e.mjs"),
  read("scripts/clean-release-bundle.mjs"),
  read("scripts/prepare-gpt-repo-mcp.mjs"),
  // The workflow lives at the repository root, one level above app/.
  read("../.github/workflows/build.yml"),
]);

const tauriConfig = JSON.parse(tauriConfigRaw);
const defaultCapabilities = JSON.parse(defaultCapabilitiesRaw);
const mainWindow = tauriConfig.app?.windows?.[0];
const bundle = tauriConfig.bundle ?? {};

assertIncludes(html, 'src="/secret-tunnel-cloud.svg"', "static cloud art must render immediately");
assertIncludes(html, 'id="hero-flow-art"', "animated flow art element must exist");
assertIncludes(html, 'data-src="/secret-tunnel-flow.svg"', "animated SVG must be lazy-loaded by status");
assertIncludes(html, 'id="zrok-token"', "zrok enable token field must be built into first-run setup");
assertIncludes(
  html,
  '<main class="shell" data-tauri-drag-region="deep">',
  // On the body, not the header: the window has no native title bar, so it has
  // to be draggable by any part of itself. "deep" rather than a bare attribute
  // because bare is self-only in Tauri 2.11 - it drags on direct clicks on that
  // one element, which its children cover completely. Clickable descendants
  // still block dragging, so buttons, inputs and the tabs keep working.
  "the whole body must be a subtree-wide native drag region",
);
assertIncludes(html, 'id="window-minimize"', "frameless main window must expose minimize control");
assertIncludes(html, 'id="window-close"', "frameless main window must expose close control");
// Outside every panel: a hidden panel leaves the layout entirely, so controls
// placed inside one would vanish on every tab but the first - and there is no
// native title bar left to close the window with.
assertFalse(
  html.indexOf('id="window-minimize"') > html.indexOf('id="panel-overview"'),
  "window controls must sit outside the tab panels so they survive tab switches",
);
assertFalse(/\bStart\b/.test(html), "manual Start button must not return to the UI");

assertIncludes(css, "overflow: hidden;", "window content must remain fixed without scroll UI");
assertIncludes(css, "body.needs-folder .folder-button", "folder chooser must prompt when no folder is selected");
assertIncludes(css, "animation: folder-halo", "folder chooser prompt must breathe");
assertIncludes(css, "body.running.flow-ready .hero-art-static", "static art must hide only after running animation is ready");
assertIncludes(css, "body.running.flow-ready .hero-art-flow", "animated art must show only after running animation is ready");
assertIncludes(css, "animation: cloud-breathe", "running art must breathe after successful initialization");

assertMatch(
  mainTs,
  /document\.body\.classList\.toggle\("running",\s*status\.running\)/,
  "frontend must derive running class from native status",
);
assertMatch(
  mainTs,
  /renderFlowArt\(status\.running\)/,
  "frontend must pass native running state into animation loader",
);
assertMatch(
  mainTs,
  /function renderFlowArt\(running: boolean\)[\s\S]*if \(running\)[\s\S]*elements\.flowArt\.src = src[\s\S]*elements\.flowArt\.removeAttribute\("src"\)/,
  "animated SVG must only load while running and unload while stopped",
);

// get_status is an observation path: webview polling must never drive service
// startup. Retries belong to the backend supervisor, which honours an explicit
// stop; a poll-driven start ignores it and restarts what the user just stopped.
assertNoMatch(
  commandsRs,
  /pub fn get_status[\s\S]*?request_autostart_if_configured/,
  "status polling must not start services",
);
assertMatch(
  processRs,
  /pub fn start_supervisor\(&self\)/,
  "the backend must own startup retries",
);
assertMatch(
  commandsRs,
  /pub fn choose_workspace_folder[\s\S]*sync_services_after_settings_change\(&state\)\?/,
  "folder picker must start or restart services after selection",
);
assertMatch(
  commandsRs,
  /pub fn set_workspace_path[\s\S]*sync_services_after_settings_change\(&state\)\?/,
  "typed folder path save must start or restart services",
);
assertMatch(
  commandsRs,
  /pub fn enable_zrok[\s\S]*state\.start_if_configured\(\)\?/,
  "zrok enable must start services after successful setup",
);

// Health colouring. The green state must be earned by a verified public MCP
// handshake, not by a spawned process: "running" has repeatedly been true while
// the endpoint answered 502 or 503, and a green light that can lie is worse
// than no light at all.
assertIncludes(html, 'id="public-state"', "UI must report whether ChatGPT can reach the app");
assertIncludes(html, 'id="diag-reason"', "UI must have a place to explain a red state");
assertIncludes(html, 'id="open-instructions"', "UI must offer setup instructions");
assertIncludes(html, 'id="open-about"', "UI must explain what the app does");
assertIncludes(html, '<dialog id="instructions"', "instructions must open as a dialog");
assertIncludes(html, '<dialog id="about"', "about must open as a dialog");
assertIncludes(css, ".state-ok", "UI must define a healthy state colour");
assertIncludes(css, ".state-warn", "UI must define an in-progress state colour");
assertIncludes(css, ".state-bad", "UI must define a blocked state colour");
assertMatch(
  mainTs,
  /publicProtocol\.status === "verified"[\s\S]*level: "ok"/,
  "reachability may only go green on a verified public MCP handshake",
);
assertMatch(
  mainTs,
  /cleanupBlockedReason[\s\S]*level: "bad"/,
  "a cleanup block must surface as a red state instead of being silent",
);

assertMatch(
  processRs,
  /fn status_probe_path_from_environment[\s\S]*SECRET_TUNNEL_STATUS_FILE/,
  "native runtime must support an opt-in status file for live E2E verification",
);
assertMatch(
  processRs,
  /fn write_status_document[\s\S]*"running"[\s\S]*"workspaceConfigured"[\s\S]*"failureCode"/,
  "status document must write sanitized running-state and failure fields",
);
assertMatch(
  processRs,
  /pub fn enable_zrok_from_environment_if_present[\s\S]*zrok_enable_token_from_environment\(\)[\s\S]*enable_zrok_environment\(&token\)/,
  "launch environment token must be able to enable zrok without storing it in settings",
);
assertMatch(
  processRs,
  /fn zrok_enable_token_from_environment\(\)[\s\S]*SECRET_TUNNEL_ZROK_ENABLE_TOKEN[\s\S]*ZROK_ENABLE_TOKEN/,
  "zrok launch token helper must support managed setup environment variables",
);
assertIncludes(processRs, 'bundled_executable("node")', "MCP must use bundled Node");
assertIncludes(processRs, "Command::new(bundled_zrok_command()?)", "zrok must use bundled zrok2");
assertIncludes(processRs, 'command.env("GPT_REPO_READ_ONLY_SURFACE", "1")', "read mode must expose read-only MCP tools only");
assertIncludes(processRs, "CREATE_NO_WINDOW", "Windows child processes must remain backgrounded");

assertMatch(
  mainLib,
  /apply_launch_environment_overrides\(&paths\)/,
  "app launch must apply managed environment settings before startup",
);
assertMatch(
  settingsRs,
  /pub fn apply_launch_environment_overrides[\s\S]*SECRET_TUNNEL_WORKSPACE_PATH[\s\S]*SECRET_TUNNEL_ACCESS_MODE[\s\S]*SECRET_TUNNEL_ZROK_NAME[\s\S]*SECRET_TUNNEL_PUBLIC_PATH_TOKEN/,
  "settings must support explicit launch environment overrides",
);
assertMatch(
  liveE2e,
  /verifyDisabledZrokPackagedLaunch[\s\S]*zrok_not_enabled/,
  "live E2E smoke must verify disabled-zrok packaged launch",
);
assertMatch(
  liveE2e,
  /waitForAppRunningStatus\(\)[\s\S]*waitForMcpToolSurface\(mcpUrl\)/,
  "live E2E smoke must verify app running state before the public MCP tool surface",
);
assertMatch(
  cleanRelease,
  /"bundle"[\s\S]*"binaries"[\s\S]*"resources"/,
  "release cleanup must remove stale bundle and runtime resource directories",
);
assertMatch(
  prepareMcp,
  /SECRET_TUNNEL_REQUIRE_CLEAN_MCP_SOURCE[\s\S]*SECRET_TUNNEL_REQUIRE_PINNED_MCP_SOURCE[\s\S]*GPT_REPO_MCP_REPO_REF/,
  "MCP runtime prep must support strict clean and pinned source release gates",
);
assertMatch(
  workflow,
  /SECRET_TUNNEL_REQUIRE_CLEAN_MCP_SOURCE/,
  "release workflow must require clean MCP source during runtime prep",
);
assertMatch(
  workflow,
  /run_live_e2e[\s\S]*Live zrok E2E[\s\S]*github\.event_name == 'workflow_dispatch'[\s\S]*windows-latest[\s\S]*SECRET_TUNNEL_ZROK_ENABLE_TOKEN[\s\S]*npm run smoke:live/,
  "release workflow must require clean MCP source and keep live zrok E2E manual, Windows-scoped, and secret-backed",
);
assertMatch(
  mainLib,
  /if launched_in_background\(\)[\s\S]*window\.minimize\(\)/,
  "autostart background launches must minimize the app window",
);
assertMatch(
  mainLib,
  /enable_zrok_from_environment_if_present\(\)[\s\S]*start_if_configured\(\)/,
  "launch setup must try zrok auto-enable before starting configured services",
);

// 636, not 580: the content column is still the 580px it was designed at, and
// the cabinet rail down the right edge is the extra 56. The window grew by the
// width of the rail rather than the content shrinking to make room for it.
assertEqual(mainWindow.width, 636, "window width must stay fixed");
// 704, not 648: the connect flow adds a transient row for the device code, and
// the window is unresizable, so it has to be tall enough for that state. Text
// is fitted to its box rather than the window growing per string - see the
// Pretext rule in For-AI/README.md - but a whole extra UI row is a layout
// decision, made once, here.
assertEqual(mainWindow.height, 704, "window height must stay fixed");
assertEqual(mainWindow.resizable, false, "window must not be resizable");
assertEqual(mainWindow.decorations, false, "custom silhouette must not retain the rectangular native title bar");
assertEqual(mainWindow.transparent, true, "window must expose transparent pixels around the custom silhouette");
assertEqual(mainWindow.shadow, false, "undecorated window must not regain a rectangular native shadow");
assertArrayIncludes(defaultCapabilities.permissions, "core:window:allow-minimize", "custom minimize control must be permitted");
assertArrayIncludes(defaultCapabilities.permissions, "core:window:allow-close", "custom close control must be permitted");
assertArrayIncludes(defaultCapabilities.permissions, "core:window:allow-start-dragging", "custom drag region must be permitted");
assertMatch(
  css,
  /min-height:\s*704px/,
  "body min-height must match the fixed window height so nothing is clipped",
);
assertMatch(
  css,
  /min-width:\s*636px/,
  "body min-width must match the fixed window width so the rail is never clipped",
);
assertIncludes(html, 'class="tab-rail"', "the cabinet rail must exist");
// The deck is not pinned to a count. It divides the rail between however many
// sheets there are and the hue wheel is divided the same way, so this asserts
// the relationship rather than a number - a deck reused with a different set of
// modules has to pass the same contract.
const tabCount = (html.match(/class="cabinet-tab"/g) ?? []).length;
assertFalse(tabCount < 1, "the rail must carry at least one tab");
assertEqual(
  (html.match(/class="tab-panel/g) ?? []).length,
  tabCount,
  "every tab must have a panel to open",
);
assertFalse(
  /id="panel-overview"[^>]*\shidden/.test(html),
  "the overview panel must be the one open before any script runs",
);
// The deck must sit flush against both ends of the body. Any padding on the
// rail pushes the first sheet down or lifts the last one, and the silhouette
// gets a notch at that end instead of one straight stroke across it.
assertMatch(
  css,
  /\.tab-rail\s*\{[^}]*padding: 0;/,
  "the tab rail must have no padding, so the deck stays symmetric top to bottom",
);
// One module per tab, and the tab is named for the module rather than for its
// place in the rail: a tab that moves must not change what its code is called.
// Undefined slots are the exception and carry their number until they get one.
for (const control of html.matchAll(/aria-controls="(panel-[a-z0-9-]+)"/g)) {
  assertIncludes(html, `id="${control[1]}"`, `${control[1]} must exist for the tab that opens it`);
}
assertFalse(
  /id="(tab|panel)-(one|two|three|four|five|six|seven|eight|nine|ten|eleven)"/.test(html),
  "a named module's tab must not be identified by its position in the rail",
);
assertEqual(mainWindow.maximizable, false, "window must not be maximizable");
assertResourceIncludes(bundle.resources, "binaries/", "installer must carry complete runtime binaries directory");
assertResourceIncludes(bundle.resources, "resources/", "installer must carry complete bundled MCP resources directory");
assertResourceIncludes(
  bundle.resources,
  "../storage/worker.mjs",
  "installer must carry the packaged Storage Box worker",
);
assertEqual(
  bundle.windows?.webviewInstallMode?.type,
  "offlineInstaller",
  "Windows installer must include offline WebView2 runtime support",
);
assertEqual(
  bundle.windows?.webviewInstallMode?.silent,
  true,
  "Windows WebView2 setup must be silent",
);

assertIncludes(flowSvg, 'id="flow-animation"', "flow SVG must include named animation");
assertIncludes(flowSvg, "stroke-dashoffset", "flow SVG must animate dash movement");
assertMatch(flowSvg, /dur="7\.2s"/, "flow SVG must use the faster running-state timing");

// Named v3 placeholders reuse the real SVG assets, not decorative substitutes.
const moduleSymbols = await read("public/v3-assets/icons/symbols.svg");
const moduleUses = [...html.matchAll(/<use\s+href="\/v3-assets\/icons\/symbols\.svg#([a-z0-9-]+)"/g)];
for (const [, symbol] of moduleUses) {
  assertIncludes(moduleSymbols, `id="${symbol}"`, `referenced module symbol ${symbol} must exist`);
}
for (const symbol of ["folder-presets", "folder-access", "security-center", "access-key", "activity-log", "network-devices", "peer-pairing", "storage-box", "system-prompt", "builtin-prompt", "custom-prompt", "skill-links"]) {
  assertFalse(!moduleUses.some(([, id]) => id === `st-${symbol}`), `${symbol} must be integrated into its page or tab`);
}
for (const [name, symbol] of [["folders", "folder-presets"], ["security", "security-center"], ["network", "network-devices"], ["system-prompt", "system-prompt"]]) {
  const tab = html.match(new RegExp(`<button\\s+id="tab-${name}"[\\s\\S]*?</button>`))?.[0] ?? "";
  assertIncludes(tab, `aria-controls="panel-${name}"`, `${name} must open its named panel`);
  assertIncludes(tab, `#st-${symbol}`, `${name} must use its assigned glyph`);
}
for (const name of ["security"]) {
  const panel = html.match(new RegExp(`<div id="panel-${name}"[^>]*>[\\s\\S]*?</div>`))?.[0] ?? "";
  assertIncludes(panel, `aria-labelledby="tab-${name}" hidden`, `${name} must be labelled and initially hidden`);
  assertIncludes(panel, "Planned", `${name} must disclose its placeholder state`);
  assertIncludes(panel, "not implemented yet", `${name} must not claim a working backend`);
  assertNoMatch(panel, /<(?:button|input|select|textarea)\b|\bstate-ok\b/, `${name} must not expose fake actions or success states`);
}
assertNoMatch(html, /id="(?:tab|panel)-slot-[345]"/, "named modules must replace their numbered slots");
assertIncludes(html, 'id="add-folder"', "the real folder picker must remain");
assertIncludes(html, 'id="folder-list"', "the real folder list must remain");

// Smart folders is a second section of the Folders tab, not a tab of its own,
// and every layer it spans has to be there for the restriction to be real.
const smartTs = await read("src/smart-folders.ts");
const smartRs = await read("src-tauri/src/smart_folders.rs");
const defineTool = await read("vendor/gpt-repo-mcp/src/tools/define-tool.ts");
const gitExec = await read("vendor/gpt-repo-mcp/src/services/git-exec.ts");
const processExec = await read("vendor/gpt-repo-mcp/src/services/process-exec.ts");
const registerTs = await read("vendor/gpt-repo-mcp/src/register.ts");
const brokerRs = await read("src-tauri/src/github/broker.rs");
const actionsRs = await read("src-tauri/src/actions.rs");
const storageRs = await read("src-tauri/src/storage.rs");

assertFalse(/id="(?:tab|panel)-smart/.test(html), "Smart folders must live inside Folders, not take a tab");
const foldersPanel = html.match(/<div id="panel-folders"[\s\S]*?\n      <\/div>/)?.[0] ?? "";
assertIncludes(foldersPanel, 'id="folder-list"', "the folders panel extraction must have found the real panel");
for (const id of ["smart-project-list", "smart-name", "smart-refresh", "smart-preview", "smart-apply", "smart-restore", "smart-state"]) {
  assertIncludes(foldersPanel, `id="${id}"`, `Smart folders control ${id} must exist inside the Folders panel`);
}
// Restoring full access is a deliberate desktop action and must stay one.
assertIncludes(foldersPanel, "Restore full-project access", "clearing the scope must be an explicit, named action");
// This slice scans one level. The label has to say so rather than implying a
// recursive search the code does not do.
assertIncludes(foldersPanel, "Project-level folders", "the panel must disclose that discovery is one level deep");

// Long paths and long names must not set the width of anything.
for (const selector of [".smart-preview-path", ".smart-project-name", ".smart-state"]) {
  assertMatch(css, new RegExp(`\\${selector}[^}]*min-width:\\s*0`), `${selector} must be allowed to shrink inside its row`);
}
assertMatch(css, /\.smart-preview[^}]*max-height/, "many matches must scroll inside the section, not grow the window");
assertMatch(css, /\.smart-project-list[^}]*max-height/, "many projects must scroll inside the section, not grow the window");
assertIncludes(smartTs, "fit()", "the Smart folders state line must use the shared bounded fitter");

// Choosing a name or refreshing is a preview. Only the two buttons change what
// is served, and the frontend never decides what is approved.
const scanFn = smartTs.match(/async function runScan[\s\S]*?\n  \}/)?.[0] ?? "";
assertIncludes(scanFn, "smart_folders_scan", "refresh must call the read-only scan");
assertNoMatch(scanFn, /smart_folders_apply|smart_folders_clear/, "refreshing must not change permissions");
assertIncludes(smartTs, 'invoke<SmartFoldersStatus>(command', "apply and restore must render the backend's own status");

// The backend decides. An arbitrary path from the window is not authority.
assertMatch(smartRs, /pub fn resolve\(/, "apply must resolve its own scope in the backend");
assertIncludes(smartRs, "registered_projects", "approved folders must be validated against registered project roots");
assertIncludes(smartRs, "approved_child", "each approved folder must be re-proved as an immediate child");
assertMatch(settingsRs, /pub fn effective_roots\(/, "one resolver must produce the roots every caller uses");
assertMatch(settingsRs, /pub smart_scope: Option<SmartScope>/, "the scope must be one optional setting");
assertMatch(settingsRs, /#\[serde\(default\)\]\s*\n\s*pub smart_scope/, "older settings files must still parse");
assertMatch(
  settingsRs,
  /pub fn write_managed_mcp_config[\s\S]*effective_roots\(settings\)\?/,
  "the managed MCP config must be written from the shared resolver",
);
assertMatch(settingsRs, /fn smart_repo_id[\s\S]*path_repo_id\("smart"/, "smart roots must get ids of their own, never the workspace id");
assertMatch(
  settingsRs,
  /fn settings_revision[\s\S]*smart_scope/,
  "a scope change must move the revision, so sessions started under the old one are invalidated",
);
assertIncludes(storageRs, "effective_roots", "Storage Box local roots must come from the same resolver");

// Capabilities that cannot be confined to a child folder refuse, and refuse at
// execution rather than by being hidden.
assertIncludes(brokerRs, "guard_broad_capability", "the app-mediated GitHub routes must refuse under a scope");
assertMatch(brokerRs, /path\.starts_with\("\/github\/"\)[\s\S]{0,200}guard_broad_capability/, "the GitHub refusal must cover every GitHub route, credential handout included");
assertIncludes(actionsRs, "guard_broad_capability", "task execution must refuse under a scope");
assertIncludes(await read("src-tauri/src/github/coordinator.rs"), "guard_broad_capability", "desktop GitHub mutations must refuse under a scope");
assertIncludes(processRs, 'command.env("GPT_REPO_SMART_SCOPE", "1")', "the MCP child must be told the endpoint is restricted");
assertIncludes(processRs, 'command.env_remove("GPT_REPO_SMART_SCOPE")', "the flag must never be left over from a previous configuration");
assertIncludes(defineTool, "assertAllowedInSmartScope", "every catalogue tool must be checked when it is called");
assertIncludes(gitExec, "assertCapabilityAllowedInSmartScope", "Git must refuse at the point of execution, whichever tool asked");
assertIncludes(processExec, "assertCapabilityAllowedInSmartScope", "running an executable must refuse at the point of execution");
assertMatch(registerTs, /if \(!restricted\) \{[\s\S]*registerDirectGitHubTools/, "neither GitHub path may be offered under a scope");
// Network now has a native backend; keep its contract separate from placeholders.
for (const id of ["network-mode", "network-create", "network-copy-link", "network-copy-code", "network-incoming", "network-roots", "network-write", "network-join", "network-revoke", "network-leave"]) {
  assertIncludes(html, `id="${id}"`, `Network control ${id} must exist`);
}
assertIncludes(html, 'aria-labelledby="tab-network" hidden', "Network must remain an accessible, initially hidden tab");
assertIncludes(await read("src/network.ts"), "not shared-URL failover", "portable transfer must not claim endpoint redundancy");
assertIncludes(html, 'id="network-confirm-import"', "credential import requires explicit local acceptance");
assertNoMatch(html, /id="network-write"[^>]*\bchecked\b/, "peer writes must default off");
const networkUi = await read("src/network.ts");
const networkRs = await read("src-tauri/src/network.rs");
assertIncludes(networkUi, "network_request", "Network UI must invoke the native backend");
assertIncludes(networkUi, "selectedOptions", "sharing must require selected approved roots");

// Connection purpose is one three-way choice, not three switches: one shared
// radio group, exactly one of them checked before any script runs, and the
// three backend values unchanged. "dependent" is the persistent peer - the
// visible caption says "Persistent", the contract does not.
const purposeChoice = html.match(/<fieldset id="network-mode"[\s\S]*?<\/fieldset>/)?.[0] ?? "";
assertMatch(purposeChoice, /<legend>/, "the purpose choice must be a labelled group, not three loose controls");
assertNoMatch(html, /<select id="network-mode"/, "the purpose dropdown must be gone, not hidden behind the pictures");
assertEqual(
  (purposeChoice.match(/type="radio"/g) ?? []).length,
  3,
  "the purpose choice must offer exactly three native radios",
);
assertEqual(
  new Set(purposeChoice.match(/name="[a-z-]+"/g) ?? []).size,
  1,
  "all three must share one radio group, so the choice is mutually exclusive",
);
assertEqual(
  (purposeChoice.match(/\bchecked\b/g) ?? []).length,
  1,
  "exactly one purpose must be selected before any script runs",
);
for (const [value, art, name] of [
  ["temporary", "temporary-peer", "Temporary peer, 24 hours"],
  ["dependent", "persistent-peer", "Persistent peer, until revoked"],
  ["profile", "portable-settings", "Copy portable settings"],
]) {
  assertIncludes(purposeChoice, `value="${value}"`, `the ${value} purpose must keep its existing backend value`);
  assertIncludes(purposeChoice, `src="/v3-assets/network-modes/${art}.svg"`, `${value} must show its own artwork`);
  // The caption is inside the SVG, so the accessible name is on the radio and
  // the picture is decorative - printing the caption twice is the other way to
  // get this wrong.
  assertIncludes(purposeChoice, `aria-label="${name}"`, `${value} must name itself to assistive technology`);
}
assertEqual(
  (purposeChoice.match(/alt=""/g) ?? []).length,
  3,
  "the illustrations must be decorative, because the radio already carries the name",
);
// The radios have to stay operable by keyboard; only their native box is taken
// out of the layout. `display: none` would take them out of the tab order too.
assertNoMatch(css, /#network-mode input[^}]*display:\s*none/, "the purpose radios must remain keyboard-operable");
assertMatch(css, /#network-mode input\b/, "the global text-field sizing must be neutralised for the purpose radios");
assertMatch(css, /\.mode-option:has\(input:focus-visible\)/, "a keyboard focus outline must be visible on the chosen picture");
assertMatch(css, /\.mode-option:has\(input:checked\)/, "the selected purpose must be marked");

// One source of truth for the selection, and it is the checked radio.
assertMatch(networkUi, /const selectedMode = \(\): string =>/, "one typed helper must read the selection");
assertNoMatch(networkUi, /\bmode\.value\b/, "the old single-value control must not survive as a second source of truth");
// Changing the purpose relabels the panel. It must not create or redeem an
// invitation, join a gateway, import settings or grant anything - those stay
// behind the explicit buttons and their confirmations.
const showMode = networkUi.match(/function showMode\(\)[\s\S]*?\n  \}/)?.[0] ?? "";
// The guard first: an extraction that found nothing would pass the next
// assertion by being empty, which is the quiet way for this to stop checking.
assertIncludes(showMode, "network-mode-note", "showMode must still be the one place the panel relabels itself");
assertNoMatch(showMode, /\brequest\(|\binvoke\(/, "selecting a purpose must not call the backend");
assertMatch(networkUi, /'create',\s*\{ mode: selectedMode\(\)/, "creating an invitation must use the selected purpose");
assertMatch(networkUi, /if \(selectedMode\(\) === 'profile'\)/, "the receive branch must use the selected purpose");
// An in-flight operation must not be relabelled as another mode part-way.
assertMatch(
  networkUi,
  /async function act[\s\S]*mode\.disabled = true[\s\S]*finally \{[^}]*mode\.disabled = false/,
  "the purpose choice must be locked while an action is running, and released after it",
);
// Two ways to hand an invitation over, both opt-in, neither weakening the wire.
//
// The file: the invitation is a bearer credential, so sending it as a link
// makes the channel the only protection. Sealing it under a password the
// recipient is told separately needs two interceptions instead of one. It is
// only as strong as the password, which is why the floor is enforced and the
// KDF is expensive.
const networkCore = await read("vendor/gpt-repo-mcp/src/network/core.mjs");
assertIncludes(html, 'id="network-file-password"', "the invitation file must have a password field");
assertMatch(html, /id="network-file-password"[^>]*type="password"/, "the file password must not be shown on screen");
for (const id of ["network-save-file", "network-open-file", "network-short"]) {
  assertIncludes(html, `id="${id}"`, `Network control ${id} must exist`);
}
assertMatch(networkUi, /crypto\.subtle\.deriveKey/, "the file key must be derived from the password, not used raw");
assertMatch(networkUi, /name: 'PBKDF2'[\s\S]*hash: 'SHA-256'/, "password derivation must be PBKDF2-SHA256");
assertMatch(networkUi, /FILE_ITERATIONS = 600_000/, "password derivation must stay expensive enough to be worth doing");
assertMatch(networkUi, /'AES-GCM'[\s\S]*additionalData: fileHeader/, "the file header must be authenticated, so its parameters cannot be downgraded");
assertMatch(networkUi, /password\.length < 8/, "a floor on the password must be enforced where the file is made");
// Opening a file fills the box. Joining stays an explicit, separate action.
const openHandler = networkUi.match(/'network-open-file'\)\.addEventListener[\s\S]*?\}\); \}\);/)?.[0] ?? "";
assertIncludes(openHandler, "incoming.value", "opening a file must fill the invitation box");
assertNoMatch(openHandler, /'join'|'redeem'|'receive_profile'/, "opening a file must not join or import by itself");
// The native side only moves bytes the person pointed at; it holds no key.
assertMatch(networkRs, /"save_file"[\s\S]*rfd::FileDialog[\s\S]*save_file\(\)/, "saving must go through a native dialog the person drove");
assertMatch(networkRs, /"open_file"[\s\S]*rfd::FileDialog[\s\S]*pick_file\(\)/, "opening must go through a native dialog the person drove");
assertNoMatch(networkRs, /"save_file"[\s\S]*password/, "the native side must never see the file password");

// The short code: a short seed, never a short key. Eighty bits is safe only
// because it can be tested one network round trip at a time against a one-use
// invitation that dies in five minutes, so the two are locked together.
assertMatch(networkCore, /hkdfSync/, "a short code must derive a full-length channel key, not carry a short one");
assertMatch(networkCore, /SHORT_MS = 5 \* 60_000/, "the short code must have its own five-minute window");
assertMatch(
  networkCore,
  /need\(!short \|\| invitationMs === SHORT_MS, 'short_requires_short_expiry'\)/,
  "brevity must not be available at a longer expiry",
);
assertMatch(networkCore, /SHORT_CODE = \/\^\(\[a-z0-9-\]\+\)-\(\[A-Z2-7\]\{16\}\)\$\//, "a short code must be a fixed, fully specified shape");
assertMatch(networkRs, /if short \{ 300_000 \} else \{ 900_000 \}/, "the native side must pick the expiry the short code requires");
assertMatch(networkUi, /short: wantShort/, "the toggle must be what asks for a short code");
// Flipping the toggle is a choice, not an action: it must not mint anything.
const shortHandler = networkUi.match(/short\.addEventListener\('change'[\s\S]*?\n  \}\);/)?.[0] ?? "";
assertIncludes(shortHandler, "outgoing.value = ''", "changing the form must clear the invitation it no longer describes");
assertNoMatch(shortHandler, /\brequest\(|\binvoke\(/, "changing the form must not call the backend");

assertIncludes(await read("src-tauri/src/lib.rs"), "network::network_request", "the native Network command must be registered");
const networkPreparation = await read("scripts/prepare-gpt-repo-mcp.mjs");
assertIncludes(networkPreparation, "network-service.js", "the companion must be packaged");
assertIncludes(networkPreparation, "networkHash", "bundle coherence must include the companion");
assertNoMatch(html, /(?:src|data-src)="\/v3-assets\/hero\/cloud-two-laptops-(?:flow|animated)\.svg"/, "planned peers must not appear to carry live traffic");
const networkBase = await read("public/v3-assets/hero/cloud-two-laptops-base.svg");
assertIncludes(networkBase, 'viewBox="0 0 640 360"', "network art must retain shared coordinates");
assertNoMatch(networkBase + moduleSymbols, /<image\b|<script\b|data:image/i, "new module artwork must stay native vector and script-free");

// System Prompt owns the instructions the model reads before it touches a
// shared file. The claim the panel makes about them has to be true at the
// layer that sends them, which is why this checks the whole path and not only
// the markup: settings field, command, spawn environment, bundled server.
const systemPromptPanel = html.match(/<div id="panel-system-prompt"[\s\S]*?<\/section>/)?.[0] ?? "";
assertIncludes(systemPromptPanel, 'aria-labelledby="tab-system-prompt" hidden', "System Prompt must be labelled and initially hidden");
for (const [id, what] of [
  ["system-prompt-builtin", "the app-generated prompt"],
  ["system-prompt-custom", "the user's own standing instructions"],
  ["system-prompt-links", "skill and reference links"],
  ["system-prompt-effective", "what the connector actually sends"],
  ["system-prompt-save", "an explicit save"],
]) {
  assertIncludes(systemPromptPanel, `id="${id}"`, `System Prompt must expose ${what}`);
}
assertMatch(
  systemPromptPanel,
  /id="system-prompt-builtin"[^>]*\breadonly\b/,
  "the built-in prompt must not be editable",
);
assertMatch(
  systemPromptPanel,
  /id="system-prompt-effective"[^>]*\breadonly\b/,
  "the effective prompt is a preview, not a fourth thing to edit",
);
// The panel says the instructions reach ChatGPT. Every layer that has to be
// true for that sentence is asserted below, so the claim cannot outlive its
// wiring - and a prompt only reaches a session at initialize, which is why the
// panel says "next connection" rather than "every time".
assertIncludes(
  systemPromptPanel,
  "MCP instructions",
  "System Prompt must say where the instructions go",
);
assertIncludes(
  systemPromptPanel,
  "next connection",
  "System Prompt must not imply an open chat picks up a saved prompt mid-session",
);
assertNoMatch(systemPromptPanel, /\bstate-ok\b|\bConnected\b/, "System Prompt must not show a connection state it does not measure");
const systemPromptRs = await read("src-tauri/src/system_prompt.rs");
assertMatch(
  systemPromptRs,
  /pub fn effective_prompt\(settings: &SystemPromptSettings\) -> String/,
  "one composer must produce the prompt the panel previews and the child receives",
);
assertMatch(
  settingsRs,
  /#\[serde\(default\)\]\s*pub system_prompt: SystemPromptSettings,/,
  "the saved prompt must be optional in older settings files",
);
assertMatch(
  commandsRs,
  /pub fn system_prompt_set[\s\S]*sync_services_after_settings_change\(&state\)\?/,
  "saving a prompt must restart the child, because instructions are fixed at initialize",
);
assertIncludes(mainLib, "commands::system_prompt_get", "the System Prompt read command must be registered");
assertIncludes(mainLib, "commands::system_prompt_set", "the System Prompt save command must be registered");
assertMatch(
  processRs,
  /"GPT_REPO_USER_INSTRUCTIONS",\s*crate::system_prompt::effective_prompt/,
  "the composed prompt must reach the MCP child's environment",
);
assertMatch(
  await read("vendor/gpt-repo-mcp/src/register.ts"),
  /GPT_REPO_USER_INSTRUCTIONS[\s\S]*const sections = \[SERVER_INSTRUCTIONS\][\s\S]*sections\.push\(operator\)/,
  "the bundled server must append the operator prompt to its own instructions, never replace them",
);

// The one place the GitHub workflow is stated to the model. Agents were
// reading a refused local Git operation, or a missing desktop binding, as
// proof that GitHub publishing was unavailable, so the instructions have to
// keep the four capabilities apart and name both publishing routes end to end.
const serverInstructions = await read("vendor/gpt-repo-mcp/src/instructions.ts");
for (const [needle, why] of [
  ["GITHUB WORKFLOW", "the GitHub workflow must be labelled, not buried in prose"],
  ["are separate capabilities", "the capabilities must be named as separate"],
  ["does not establish that the others are unavailable", "one refusal must not be read as a verdict on the rest"],
  ["MANAGED: github_status", "the managed route must start at its own status tool"],
  ["repo_ship with exact reviewed paths", "the managed route must end at repo_ship"],
  ["DIRECT: github_direct_status", "the direct route must start at its own status tool"],
  ["github_direct_publish with repository, explicit branch", "the direct route must name its explicit branch"],
  ["github_direct_ref to verify", "the direct route must verify what it published"],
  ["it does not require a desktop repository binding", "the direct route must not look blocked by a missing binding"],
  ["OPERATIONS_DISABLED concerns the operation that returned it", "a disabled local operation is not a GitHub verdict"],
  ["not_bound means the managed publishing destination is not configured", "not_bound is a destination fact, not an authorization one"],
  ["HTTP 502 means the connection failed", "a failed connection is not a missing permission"],
  ["never merely to test permissions", "publication tools must not be used as probes"],
  ["repo_write_stage_commit is never required before repo_ship", "a local commit must not look like a publishing prerequisite"],
  ["not prerequisites for editing files in a repository that already exists",
    "repository creation and Pages setup must stay optional"],
]) {
  assertIncludes(serverInstructions, needle, `connector instructions: ${why}`);
}
// Availability, authorization and execution are three things. The old wording
// collapsed them and told the model no capability could be switched on.
for (const [pattern, why] of [
  [/there is no separate discovery step/i, "tool discovery must not be denied"],
  [/no capability that has to be switched on/i, "listed tools must not be promised as authorized"],
]) {
  assertNoMatch(serverInstructions, pattern, `connector instructions: ${why}`);
}
assertIncludes(
  serverInstructions,
  "Availability, authorization and successful execution are three different things",
  "connector instructions: the three must be distinguished",
);
assertOrder(
  serverInstructions,
  ["GITHUB WORKFLOW", "LOCAL DEVELOPMENT, local repository only"],
  "the GitHub workflow must reach the model before the local-only development path",
);
assertIncludes(
  systemPromptRs,
  "do not confuse local Git policy with GitHub publishing authorization",
  "the built-in prompt must point at the connector's GitHub workflow, not restate it",
);

console.log("UI/runtime contract smoke check passed.");

function read(relativePath) {
  return readFile(resolve(rootDir, relativePath), "utf8");
}

function assertIncludes(text, needle, message) {
  if (!text.includes(needle)) {
    throw new Error(`${message}: missing ${JSON.stringify(needle)}`);
  }
}

function assertOrder(text, needles, message) {
  let cursor = -1;
  for (const needle of needles) {
    const at = text.indexOf(needle, cursor + 1);
    if (at <= cursor) {
      throw new Error(`${message}: ${JSON.stringify(needle)} is missing or out of order`);
    }
    cursor = at;
  }
}

function assertMatch(text, pattern, message) {
  if (!pattern.test(text)) {
    throw new Error(`${message}: ${pattern}`);
  }
}

function assertNoMatch(text, pattern, message) {
  if (pattern.test(text)) {
    throw new Error(`${message}: ${pattern}`);
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// `resources` is either a list of paths copied to the same relative place, or a
// map from each source to where it lands inside the bundle. The contract is
// about what the installer carries, which both forms state the same way.
function assertResourceIncludes(value, expected, message) {
  const sources = Array.isArray(value) ? value : Object.keys(value ?? {});
  if (!sources.includes(expected)) {
    throw new Error(`${message}: ${JSON.stringify(value)}`);
  }
}

function assertArrayIncludes(value, expected, message) {
  if (!Array.isArray(value) || !value.includes(expected)) {
    throw new Error(`${message}: ${JSON.stringify(value)}`);
  }
}

function assertFalse(condition, message) {
  if (condition) {
    throw new Error(message);
  }
}
