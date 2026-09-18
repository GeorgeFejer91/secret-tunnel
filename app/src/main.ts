import { invoke } from "@tauri-apps/api/core";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { measureNaturalWidth, prepareWithSegments } from "@chenglou/pretext";

type AppError = {
  code: string;
  message: string;
};

type LogLine = {
  source: string;
  line: string;
};

type ProbeStatus = "pending" | "verifying" | "verified" | "failed" | "unsupported";

type ProbeEntry = {
  kind: string;
  status: ProbeStatus;
  checkedAt: string | null;
  detail: string | null;
};

/// The backend's readiness gates for the active generation. `publicProtocol` is
/// the only one that means "ChatGPT could actually talk to this": a spawned
/// process and a registered share both prove nothing on their own.
type Readiness = {
  localProcess: ProbeEntry;
  localEndpoint: ProbeEntry;
  localProtocol: ProbeEntry;
  publicTunnel: ProbeEntry;
  publicProtocol: ProbeEntry;
  generation: number;
  verifiedRevision: number | null;
  degraded: boolean;
  issues: string[];
};

type Status = {
  settings: {
    workspacePath: string | null;
    accessMode: "read" | "read_write";
    zrokName: string;
    publicPathToken: string;
    gptRepoMcpPath: string;
    managedConfigPath: string;
  };
  mcpUrl: string;
  running: boolean;
  autostartEnabled: boolean;
  zrokInstalled: boolean;
  zrokEnabled: boolean;
  gptRepoMcpFound: boolean;
  workspaceConfigured: boolean;
  githubEnabled: boolean;
  startupBlockedReason: string | null;
  startupBlockedMessage: string | null;
  lifecycleState: string;
  desiredRunning: boolean;
  cleanupBlockedReason: string | null;
  readiness: Readiness | null;
  logs: LogLine[];
};

type Health = "ok" | "warn" | "bad";

type Indicator = {
  level: Health;
  text: string;
  /// One actionable sentence, shown only when something is wrong.
  reason?: string;
};

const ZROK_TOKEN_PAGE_URL = "https://myzrok.io";

const elements = {
  statusLine: mustElement<HTMLElement>("status-line"),
  flowArt: mustElement<HTMLImageElement>("hero-flow-art"),
  mcpUrl: mustElement<HTMLInputElement>("mcp-url"),
  copyUrl: mustElement<HTMLButtonElement>("copy-url"),
  regenerateUrl: mustElement<HTMLButtonElement>("regenerate-url"),
  zrokSetup: mustElement<HTMLElement>("zrok-setup"),
  zrokToken: mustElement<HTMLInputElement>("zrok-token"),
  enableZrok: mustElement<HTMLButtonElement>("enable-zrok"),
  getTokenLink: mustElement<HTMLAnchorElement>("get-token-link"),
  folderPicker: mustElement<HTMLButtonElement>("folder-picker"),
  folderPath: mustElement<HTMLInputElement>("folder-path"),
  pasteFolder: mustElement<HTMLButtonElement>("paste-folder"),
  copyFolder: mustElement<HTMLButtonElement>("copy-folder"),
  saveFolder: mustElement<HTMLButtonElement>("save-folder"),
  autostart: mustElement<HTMLInputElement>("autostart"),
  modeRead: mustElement<HTMLButtonElement>("mode-read"),
  modeWrite: mustElement<HTMLButtonElement>("mode-write"),
  modeGithub: mustElement<HTMLButtonElement>("mode-github"),
  zrokState: mustElement<HTMLElement>("zrok-state"),
  mcpState: mustElement<HTMLElement>("mcp-state"),
  publicState: mustElement<HTMLElement>("public-state"),
  diagReason: mustElement<HTMLParagraphElement>("diag-reason"),
  instructions: mustElement<HTMLDialogElement>("instructions"),
  openInstructions: mustElement<HTMLButtonElement>("open-instructions"),
  closeInstructions: mustElement<HTMLButtonElement>("close-instructions"),
  doneInstructions: mustElement<HTMLButtonElement>("done-instructions"),
  copyUrlFromInstructions: mustElement<HTMLButtonElement>("copy-url-from-instructions"),
  about: mustElement<HTMLDialogElement>("about"),
  openActions: mustElement<HTMLButtonElement>("open-actions"),
  openAbout: mustElement<HTMLButtonElement>("open-about"),
  closeAbout: mustElement<HTMLButtonElement>("close-about"),
  doneAbout: mustElement<HTMLButtonElement>("done-about"),
  github: mustElement<HTMLDialogElement>("github"),
  githubConnect: mustElement<HTMLButtonElement>("github-connect"),
  githubConnectLabel: mustElement<HTMLSpanElement>("github-connect-label"),
  githubDevice: mustElement<HTMLParagraphElement>("github-device"),
  githubDeviceCode: mustElement<HTMLElement>("github-device-code"),
  githubDeviceCopy: mustElement<HTMLButtonElement>("github-device-copy"),
  githubDeviceCancel: mustElement<HTMLButtonElement>("github-device-cancel"),
  githubConnectError: mustElement<HTMLParagraphElement>("github-connect-error"),
  closeGithub: mustElement<HTMLButtonElement>("close-github"),
  doneGithub: mustElement<HTMLButtonElement>("done-github"),
  githubEnabled: mustElement<HTMLInputElement>("github-enabled"),
  githubBlocked: mustElement<HTMLParagraphElement>("github-blocked"),
  githubRepoState: mustElement<HTMLParagraphElement>("github-repo-state"),
  githubOwner: mustElement<HTMLInputElement>("github-owner"),
  githubRepo: mustElement<HTMLInputElement>("github-repo"),
  githubBind: mustElement<HTMLButtonElement>("github-bind"),
  githubUnbind: mustElement<HTMLButtonElement>("github-unbind"),
  githubInit: mustElement<HTMLButtonElement>("github-init"),
  githubPlans: mustElement<HTMLElement>("github-plans"),
  githubMessage: mustElement<HTMLParagraphElement>("github-message"),
};

let currentStatus: Status | null = null;
let busy = false;

window.addEventListener("DOMContentLoaded", () => {
  wireEvents();
  refresh();
  void refreshGitHubAccount();
  window.setInterval(refresh, 4000);
});

function wireEvents() {
  elements.flowArt.addEventListener("load", () => {
    document.body.classList.toggle("flow-ready", currentStatus?.running ?? false);
  });
  elements.copyUrl.addEventListener("click", () => copyText(elements.mcpUrl.value));
  elements.regenerateUrl.addEventListener("click", () =>
    runStatusCommand("regenerate_mcp_url"),
  );
  elements.enableZrok.addEventListener("click", enableZrok);
  elements.getTokenLink.addEventListener("click", openZrokTokenPage);
  elements.zrokToken.addEventListener("keydown", (event) => {
    if (event.key === "Enter") enableZrok();
  });
  elements.folderPicker.addEventListener("click", chooseFolder);
  elements.copyFolder.addEventListener("click", () => copyText(elements.folderPath.value));
  elements.pasteFolder.addEventListener("click", pasteFolder);
  elements.saveFolder.addEventListener("click", saveFolder);
  elements.autostart.addEventListener("change", () => {
    runStatusCommand("set_autostart", { enabled: elements.autostart.checked });
  });
  elements.modeRead.addEventListener("click", () => setAccessLevel("read", false));
  elements.modeWrite.addEventListener("click", () => setAccessLevel("read_write", false));
  elements.modeGithub.addEventListener("click", () => setAccessLevel("read_write", true));

  elements.openInstructions.addEventListener("click", () => elements.instructions.showModal());
  elements.closeInstructions.addEventListener("click", () => elements.instructions.close());
  elements.doneInstructions.addEventListener("click", () => elements.instructions.close());
  elements.copyUrlFromInstructions.addEventListener("click", () => copyText(elements.mcpUrl.value));
  elements.githubConnect.addEventListener("click", () => void toggleGitHubAccount());
  elements.githubDeviceCancel.addEventListener("click", () => {
    stopDevicePolling();
    void refreshGitHubAccount();
  });
  elements.githubDeviceCopy.addEventListener("click", () =>
    copyText(elements.githubDeviceCode.textContent ?? ""),
  );
  elements.closeGithub.addEventListener("click", () => elements.github.close());
  elements.doneGithub.addEventListener("click", () => elements.github.close());
  elements.githubEnabled.addEventListener("change", () => {
    void githubCommand(
      "github_set_enabled",
      { enabled: elements.githubEnabled.checked },
      elements.githubEnabled.checked
        ? "ChatGPT can now propose commits. It still cannot make one."
        : "Turned off. Any plan waiting for a decision was discarded.",
    );
  });
  elements.githubBind.addEventListener("click", () => {
    void githubCommand(
      "github_bind",
      { owner: elements.githubOwner.value.trim(), repo: elements.githubRepo.value.trim() },
      "Linked.",
    );
  });
  elements.githubUnbind.addEventListener("click", () => {
    void githubCommand("github_unbind", {}, "Unlinked. Plans for this folder were discarded.");
  });
  elements.githubInit.addEventListener("click", () => {
    void githubCommand("github_init_repository", {}, "This folder is now a Git repository.");
  });
  elements.openActions.addEventListener("click", () => {
    void invoke("open_actions").catch(renderError);
  });
  elements.openAbout.addEventListener("click", () => elements.about.showModal());
  elements.closeAbout.addEventListener("click", () => elements.about.close());
  elements.doneAbout.addEventListener("click", () => elements.about.close());
  // Clicking the backdrop closes the dialog; clicks inside it must not.
  for (const sheet of [elements.instructions, elements.about, elements.github]) {
    sheet.addEventListener("click", (event) => {
      if (event.target === sheet) sheet.close();
    });
  }
  // The CSP blocks navigation, so external links are opened by the backend.
  for (const link of document.querySelectorAll<HTMLElement>("[data-open-url]")) {
    link.addEventListener("click", () => {
      const url = link.dataset.openUrl;
      if (url) openExternal(url);
    });
  }
}

async function openExternal(url: string) {
  try {
    await invoke("open_url", { url });
  } catch (error) {
    renderError(error);
  }
}

async function refresh() {
  if (busy) return;
  try {
    render(await invoke<Status>("get_status"));
  } catch (error) {
    renderError(error);
  }
}

async function chooseFolder() {
  await withBusy(async () => {
    const status = await invoke<Status | null>("choose_workspace_folder");
    if (status) render(status);
  });
}

async function pasteFolder() {
  try {
    elements.folderPath.value = await readText();
    elements.folderPath.focus();
  } catch {
    setStatusText("Clipboard read was blocked.");
  }
}

async function saveFolder() {
  await runStatusCommand("set_workspace_path", { path: elements.folderPath.value });
}

async function setAccessLevel(
  mode: Status["settings"]["accessMode"],
  github: boolean,
) {
  const sameMode = currentStatus?.settings.accessMode === mode;
  const sameGithub = currentStatus?.githubEnabled === github;
  if (sameMode && sameGithub) return;
  await withBusy(async () => {
    // Withdraw GitHub before narrowing access, and widen access before
    // granting it, so no intermediate state is broader than either end.
    if (!github && !sameGithub) await invoke("github_set_enabled", { enabled: false });
    if (!sameMode) await invoke("set_access_mode", { mode });
    if (github && !sameGithub) await invoke("github_set_enabled", { enabled: true });
    render(await invoke<Status>("get_status"));
  });
}

async function runStatusCommand(command: string, args?: Record<string, unknown>) {
  await withBusy(async () => {
    render(await invoke<Status>(command, args));
  });
}

async function withBusy(work: () => Promise<void>) {
  if (busy) return;
  busy = true;
  setControlsDisabled(true);
  try {
    await work();
  } catch (error) {
    await refresh();
    renderError(error);
  } finally {
    busy = false;
    setControlsDisabled(false);
  }
}

async function copyText(value: string) {
  if (!value) return;
  try {
    await writeText(value);
    setStatusText("Copied.");
  } catch {
    setStatusText("Clipboard write failed.");
  }
}

function render(status: Status) {
  currentStatus = status;
  elements.mcpUrl.value = status.mcpUrl;
  elements.folderPath.value = status.settings.workspacePath ?? "";
  elements.autostart.checked = status.autostartEnabled;
  renderAccessMode(status.settings.accessMode, status.githubEnabled);
  document.body.classList.toggle("running", status.running);
  document.body.classList.toggle("needs-folder", !status.settings.workspacePath);
  renderFlowArt(status.running);
  const zrokNeedsEnable = status.zrokInstalled && !status.zrokEnabled;
  document.body.classList.toggle("zrok-needs-enable", zrokNeedsEnable);
  elements.zrokSetup.hidden = !zrokNeedsEnable;

  applyIndicator(elements.zrokState, zrokIndicator(status));
  applyIndicator(elements.mcpState, mcpIndicator(status));
  const reachable = reachabilityIndicator(status);
  applyIndicator(elements.publicState, reachable);
  const overall = overallIndicator(status, reachable);
  applyIndicator(elements.statusLine, overall);

  // Show the single most useful explanation, preferring the overall verdict.
  const reason = overall.reason ?? reachable.reason ?? null;
  elements.diagReason.textContent = reason ?? "";
  // The line is clamped to two lines, so keep the full text reachable on hover.
  elements.diagReason.title = reason ?? "";
  elements.diagReason.hidden = reason === null;
}

function applyIndicator(element: HTMLElement, indicator: Indicator) {
  element.textContent = indicator.text;
  element.classList.remove("state-ok", "state-warn", "state-bad");
  element.classList.add(`state-${indicator.level}`);
}

function zrokIndicator(status: Status): Indicator {
  if (!status.zrokInstalled) {
    return { level: "bad", text: "Missing", reason: "The bundled zrok2 is missing. Reinstall Secret Tunnel." };
  }
  if (!status.zrokEnabled) {
    return { level: "bad", text: "Needs enable", reason: "Paste your zrok token above to enable the tunnel." };
  }
  return { level: "ok", text: "Ready" };
}

function mcpIndicator(status: Status): Indicator {
  return status.gptRepoMcpFound
    ? { level: "ok", text: "Ready" }
    : { level: "bad", text: "Missing", reason: "The bundled gpt-repo-mcp runtime is missing. Reinstall Secret Tunnel." };
}

/// Whether ChatGPT could actually reach this folder right now. Only a verified
/// handshake through the public URL counts: a running process and a registered
/// share can both be true while the endpoint returns 502 or 503.
function reachabilityIndicator(status: Status): Indicator {
  if (!status.running) return { level: "bad", text: "Not running" };

  const readiness = status.readiness;
  if (!readiness) return { level: "warn", text: "Checking…" };

  const { publicTunnel, publicProtocol } = readiness;
  if (publicProtocol.status === "verified") {
    return { level: "ok", text: "Connected" };
  }
  if (publicProtocol.status === "failed" || publicTunnel.status === "failed") {
    const detail = publicProtocol.detail ?? publicTunnel.detail ?? "the public URL is not responding";
    return { level: "bad", text: "Unreachable", reason: `ChatGPT cannot reach this app: ${detail}` };
  }
  return { level: "warn", text: "Checking…" };
}

function overallIndicator(status: Status, reachable: Indicator): Indicator {
  const mode = status.settings.accessMode === "read_write" ? "read+write" : "read-only";

  // Hard blockers first, most specific and most actionable.
  if (status.cleanupBlockedReason) {
    return {
      level: "bad",
      text: "Needs a restart",
      reason: `Previous services could not be confirmed stopped (${status.cleanupBlockedReason}). Close and reopen Secret Tunnel.`,
    };
  }
  if (!status.settings.workspacePath) {
    return { level: "bad", text: "No folder selected", reason: "Pick the folder you want ChatGPT to read." };
  }
  if (status.startupBlockedMessage) {
    return { level: "bad", text: "Folder unavailable", reason: status.startupBlockedMessage };
  }
  const zrok = zrokIndicator(status);
  if (zrok.level === "bad") return { level: "bad", text: zrok.text, reason: zrok.reason };
  const mcp = mcpIndicator(status);
  if (mcp.level === "bad") return { level: "bad", text: mcp.text, reason: mcp.reason };

  const failedStart = latestStartupIssue(status);
  if (failedStart) return { level: "bad", text: failedStart, reason: failedStart };

  if (!status.running) {
    return status.desiredRunning
      ? { level: "warn", text: "Starting…" }
      : { level: "warn", text: `Stopped, ${mode}` };
  }
  if (reachable.level === "bad") {
    return { level: "bad", text: "Running, not reachable", reason: reachable.reason };
  }
  if (reachable.level === "warn") {
    return { level: "warn", text: `Connecting, ${mode}` };
  }
  return { level: "ok", text: `Connected, ${mode}` };
}

async function openZrokTokenPage() {
  await openExternal(ZROK_TOKEN_PAGE_URL);
}

async function enableZrok() {
  const token = elements.zrokToken.value.trim();
  if (!token) {
    setStatusText("Paste zrok token first.");
    elements.zrokToken.focus();
    return;
  }

  await withBusy(async () => {
    render(await invoke<Status>("enable_zrok", { token }));
    elements.zrokToken.value = "";
  });
}

function renderFlowArt(running: boolean) {
  const src = elements.flowArt.dataset.src;
  if (!src) return;

  if (running) {
    if (!elements.flowArt.getAttribute("src")) {
      document.body.classList.remove("flow-ready");
      elements.flowArt.src = src;
    }
    return;
  }

  elements.flowArt.removeAttribute("src");
  document.body.classList.remove("flow-ready");
}

function renderAccessMode(mode: Status["settings"]["accessMode"], githubEnabled: boolean) {
  // Exactly one segment is active. GitHub is the highest rung and implies
  // read+write, so it wins the display whenever it is on.
  const active = githubEnabled ? "github" : mode === "read_write" ? "write" : "read";
  const segments = [
    ["read", elements.modeRead],
    ["write", elements.modeWrite],
    ["github", elements.modeGithub],
  ] as const;
  for (const [name, element] of segments) {
    element.classList.toggle("active", active === name);
    element.setAttribute("aria-pressed", String(active === name));
  }
}

/// The most recent launch failure reported by the backend. zrok and runtime
/// problems are diagnosed from status fields instead, so this only covers
/// failures that have no dedicated indicator.
function latestStartupIssue(status: Status): string | null {
  if (status.running) return null;

  const failedStart = status.logs
    .slice()
    .reverse()
    .find((entry) => entry.line.startsWith("Auto-start failed:"));
  if (!failedStart) return null;

  const message = failedStart.line.replace("Auto-start failed:", "").trim();
  if (!message) return "Setup needs attention";
  return message;
}

function renderError(error: unknown) {
  const appError = error as Partial<AppError>;
  setStatusText(appError.message ?? String(error));
}

function setControlsDisabled(disabled: boolean) {
  [
    elements.folderPicker,
    elements.zrokToken,
    elements.enableZrok,
    elements.pasteFolder,
    elements.copyFolder,
    elements.saveFolder,
    elements.copyUrl,
    elements.regenerateUrl,
    elements.autostart,
    elements.modeRead,
    elements.modeWrite,
    elements.modeGithub,
  ].forEach((control) => {
    control.disabled = disabled;
  });
}

/// Transient messages ("Copied.", clipboard failures) are not health states, so
/// they drop the colouring rather than inheriting the previous verdict's. The
/// next refresh restores the real indicator.
function setStatusText(value: string) {
  elements.statusLine.textContent = value;
  elements.statusLine.classList.remove("state-ok", "state-warn", "state-bad");
}

/// A proposed mutation, exactly as the backend recorded it. This is what the
/// user reads before approving, so it is rendered verbatim rather than
/// summarised: the point of the panel is that nothing is approved unseen.
type GitHubPlan = {
  id: string;
  action: "commit" | "commit_push" | "push" | "create_repository";
  expected?: { localHead: string | null; branch: string | null; remoteTip: string | null;
    contentDigest: string | null; accountLogin?: string | null;
    publication?: { repository: string; branch: string; url: string } | null };
  repository: string;
  paths: string[];
  commitMessage: string | null;
  expiresAtSecs: number;
  warnings: string[];
};

type GitHubBinding = {
  owner: string;
  repo: string;
  integrationBranch: string;
};

type GitHubOperationReceipt = {
  schemaVersion: 1; operationId: string;
  state: "running" | "succeeded" | "partial" | "failed" | "unknown";
  action: GitHubPlan["action"]; phase: string; errorCode: string | null;
  commit: { afterHead: string; committedPaths: string[];
    pushed?: { repository: string | null; branch: string; verifiedRemoteHead: string | null } | null } | null;
  createdRepository: { fullName: string; private: boolean } | null;
};

function describeGitHubReceipt(receipt: GitHubOperationReceipt): string {
  const details = [`${receipt.state}: ${receipt.action} (${receipt.phase})`, `Operation ${receipt.operationId}`];
  if (receipt.commit) {
    details.push(`${receipt.commit.committedPaths.length ? "Local commit" : "Source commit"}: ${receipt.commit.afterHead}`);
    if (receipt.commit.pushed) details.push(`Verified remote: ${receipt.commit.pushed.repository}/${receipt.commit.pushed.branch} at ${receipt.commit.pushed.verifiedRemoteHead}`);
  }
  if (receipt.createdRepository) details.push(`Private repository: ${receipt.createdRepository.fullName}. Local folder and origin were not changed.`);
  if (receipt.errorCode) details.push(`Reason: ${receipt.errorCode}. Inspect this receipt and Git state before retrying.`);
  return details.join("\n");
}

type GitHubStatus = {
  enabled: boolean;
  gitAvailable: boolean;
  gitVersion: string | null;
  workspacePath: string | null;
  isRepository: boolean;
  repository: { branch: string | null; unborn: boolean; dirty: boolean } | null;
  binding: GitHubBinding | null;
  pendingPlans: GitHubPlan[];
  approvedPlans?: GitHubPlan[];
  recentOperations?: GitHubOperationReceipt[];
  runtime?: { applicationVersion: string; buildId: string; instanceId: string; contractVersion: number };
  apiAccountStored?: boolean;
  publicationAuthentication?: string;
  blockedReason: string | null;
};

/// The panel polls only while it is open. A closed dialog has nothing to show,
/// and each refresh runs git subprocesses.
let githubTimer: number | null = null;
let githubBusy = false;

/// Run a GitHub command, report what happened in the panel's own status line,
/// and re-read the state afterwards.
///
/// Every outcome is surfaced. A refused apply is the feature working correctly -
/// the user needs to see *why* it was refused, because "the files changed after
/// you reviewed them" calls for a different response than "the branch moved".
async function githubCommand(
  command: string,
  args: Record<string, unknown>,
  success: string,
): Promise<void> {
  if (githubBusy) return;
  githubBusy = true;
  setGitHubMessage("Working…");
  try {
    const result = await invoke<unknown>(command, args);
    if (result && typeof result === "object" && "schemaVersion" in result && result.schemaVersion === 1) {
      const receipt = result as GitHubOperationReceipt;
      setGitHubMessage(describeGitHubReceipt(receipt), ["partial", "failed", "unknown"].includes(receipt.state));
    } else {
      setGitHubMessage(success);
    }
  } catch (error) {
    const failure = error as AppError;
    setGitHubMessage(failure?.message ?? String(error), true);
  } finally {
    githubBusy = false;
    await refreshGitHub();
  }
}

function setGitHubMessage(value: string, isError = false) {
  elements.githubMessage.textContent = value;
  elements.githubMessage.classList.toggle("error", isError);
}

async function refreshGitHub(): Promise<void> {
  if (!elements.github.open) {
    if (githubTimer !== null) {
      window.clearInterval(githubTimer);
      githubTimer = null;
    }
    return;
  }
  if (githubTimer === null) {
    githubTimer = window.setInterval(() => void refreshGitHub(), 3000);
  }
  try {
    renderGitHub(await invoke<GitHubStatus>("github_status"));
  } catch (error) {
    const failure = error as AppError;
    setGitHubMessage(failure?.message ?? String(error), true);
  }
}

function renderGitHub(status: GitHubStatus) {
  elements.githubEnabled.checked = status.enabled;

  elements.githubBlocked.textContent = status.blockedReason ?? "";
  elements.githubBlocked.hidden = status.blockedReason === null;

  // Describe the repository in terms of what the user can do next, not in git
  // vocabulary they may not share.
  if (!status.gitAvailable) {
    elements.githubRepoState.textContent =
      "Git is not installed on this computer, so commits cannot be made here.";
  } else if (!status.workspacePath) {
    elements.githubRepoState.textContent = "Choose a folder in the main window first.";
  } else if (!status.isRepository) {
    elements.githubRepoState.textContent =
      "This folder is not a Git repository yet.";
  } else if (status.binding) {
    const branch = status.repository?.branch ?? "an unnamed branch";
    elements.githubRepoState.textContent =
      `Linked to ${status.binding.owner}/${status.binding.repo}, on ${branch}.`;
  } else {
    elements.githubRepoState.textContent =
      "This folder is a repository, but it is not linked to one on GitHub yet.";
  }

  // Do not fight the user's typing: only fill the fields they have not touched.
  if (status.binding && document.activeElement !== elements.githubOwner) {
    elements.githubOwner.value = status.binding.owner;
  }
  if (status.binding && document.activeElement !== elements.githubRepo) {
    elements.githubRepo.value = status.binding.repo;
  }

  elements.githubBind.textContent = "Bind and add missing origin";
  elements.githubBind.title = "Explicitly bind this folder and add origin only if it is absent. An existing different origin is never replaced.";
  elements.githubBind.disabled = !status.isRepository;
  elements.githubUnbind.disabled = status.binding === null;
  elements.githubInit.disabled = !status.workspacePath || status.isRepository;
  elements.githubInit.hidden = status.isRepository;

  if (status.runtime) {
    elements.githubRepoState.textContent += ` Version ${status.runtime.applicationVersion}; build ${status.runtime.buildId}; instance ${status.runtime.instanceId}. Git publication authentication: ${status.publicationAuthentication ?? "not checked"}.`;
  }
  const approved = status.approvedPlans ?? [];
  renderGitHubPlans([...status.pendingPlans, ...approved], new Set(approved.map(plan => plan.id)));
  for (const receipt of status.recentOperations ?? []) {
    const article = document.createElement("article");
    article.className = "github-plan";
    const heading = document.createElement("h4");
    heading.textContent = `Operation ${receipt.state}`;
    const details = document.createElement("pre");
    details.className = "github-meta";
    details.textContent = describeGitHubReceipt(receipt);
    article.append(heading, details);
    elements.githubPlans.append(article);
  }
}

function renderGitHubPlans(plans: GitHubPlan[], approvedIds = new Set<string>()) {
  elements.githubPlans.replaceChildren();
  if (plans.length === 0) {
    const empty = document.createElement("p");
    empty.className = "github-meta";
    empty.textContent = "Nothing is waiting. Ask ChatGPT to propose a commit.";
    elements.githubPlans.append(empty);
    return;
  }

  for (const plan of plans) {
    const card = document.createElement("article");
    card.className = "github-plan";

    const title = document.createElement("h4");
    title.textContent =
      plan.action === "commit"
        ? `Commit to ${plan.repository}`
        : `Commit and publish to ${plan.repository}`;
    const verbs = { commit: "Commit locally for", commit_push: "Commit and publish to", push: "Publish existing commit to", create_repository: "Create private repository" };
    title.textContent = `${approvedIds.has(plan.id) ? "Approved: " : "Review: "}${verbs[plan.action]} ${plan.repository}`;
    card.append(title);
    if (plan.expected) {
      const target = document.createElement("pre");
      target.className = "github-meta";
      target.textContent = [
        `Plan: ${plan.id}`,
        plan.expected.accountLogin ? `Verified account: ${plan.expected.accountLogin}` : "",
        plan.expected.publication ? `Destination: ${plan.expected.publication.url}\nBranch: ${plan.expected.publication.branch}` : "",
        plan.expected.localHead ? `Source HEAD: ${plan.expected.localHead}` : "",
        plan.expected.remoteTip ? `Reviewed remote tip: ${plan.expected.remoteTip}` : "",
        plan.expected.contentDigest ? `Reviewed content digest: ${plan.expected.contentDigest}` : ""
      ].filter(Boolean).join("\n");
      card.append(target);
    }

    if (plan.commitMessage) {
      const message = document.createElement("p");
      message.className = "github-commit-message";
      message.textContent = plan.commitMessage;
      card.append(message);
    }

    // The file list is the substance of the approval, so it is always shown in
    // full rather than behind a disclosure or truncated with an ellipsis.
    const files = document.createElement("ul");
    files.className = "github-paths";
    for (const path of plan.paths) {
      const row = document.createElement("li");
      row.textContent = path;
      files.append(row);
    }
    card.append(files);

    for (const warning of plan.warnings) {
      const note = document.createElement("p");
      note.className = "github-warning";
      note.textContent = warning;
      card.append(note);
    }

    const controls = document.createElement("div");
    controls.className = "github-actions";
    controls.append(
      githubButton("Approve", "primary", () =>
        githubCommand(
          "github_approve",
          { planId: plan.id },
          "Approved. Use Execute approved plan, or let ChatGPT carry it out.",
        ),
      ),
      githubButton("Execute approved plan", "", () =>
        githubCommand("github_apply", { planId: plan.id }, "Operation returned. Inspect its receipt."),
      ),
      githubButton("Discard", "", () =>
        githubCommand("github_cancel", { planId: plan.id }, "Discarded. Nothing was committed."),
      ),
    );
    const buttons = controls.querySelectorAll("button");
    if (buttons[0]) buttons[0].disabled = approvedIds.has(plan.id);
    if (buttons[1]) buttons[1].disabled = !approvedIds.has(plan.id);
    card.append(controls);
    elements.githubPlans.append(card);
  }
}

function githubButton(label: string, className: string, run: () => Promise<void>) {
  const button = document.createElement("button");
  button.type = "button";
  if (className) button.className = className;
  button.textContent = label;
  button.addEventListener("click", () => void run());
  return button;
}

function mustElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing element #${id}`);
  }
  return element as T;
}

/* ------------------------------------------------------- GitHub account ---
 * One button, two states. Connecting opens the browser at GitHub's own page;
 * this window only shows the short code and polls for the result. There is no
 * settings dialog and the desktop never sees a GitHub password.
 */

type GitHubAccountState = {
  connected: boolean;
  login: string | null;
  scope: string | null;
  source: "connected_account" | "git_credential_helper" | null;
  storage?: string | null;
  autonomous: boolean;
};

type DeviceStart = {
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  deviceCode: string;
  intervalSecs: number;
  expiresInSecs: number;
};

type PollOutcome =
  | { state: "pending" }
  | { state: "slow_down"; intervalSecs: number }
  | { state: "connected"; login: string }
  | { state: "denied" }
  | { state: "expired" };

let devicePollTimer: number | null = null;
let githubAccountBusy = false;

/* The GitHub account name is the one label here whose width is decided at
 * runtime: logins run from one character to thirty-nine, and the pill it sits
 * in shares a fixed 580px row with three other links. Measuring it is the only
 * way to know whether it fits; guessing a character count is wrong for "illil"
 * and for "MMMMM" in opposite directions.
 *
 * Pretext measures with the browser's own font engine and no DOM reflow, so
 * this can run on every status refresh. The smallest adjustment that works is
 * applied in order: leave it alone, then truncate at the measured grapheme
 * boundary. The font is not shrunk, because a smaller account name next to
 * same-size links reads as a rendering fault rather than a choice.
 */
const GH_LABEL_FONT = '12px ui-sans-serif, system-ui, -apple-system, sans-serif';
const GH_LABEL_MAX_WIDTH = 190;

function fitAccountLabel(label: string): string {
  try {
    if (measureNaturalWidth(prepareWithSegments(label, GH_LABEL_FONT)) <= GH_LABEL_MAX_WIDTH) {
      return label;
    }
    const graphemes = Array.from(label);
    // Longest prefix whose measured width, plus the ellipsis, still fits.
    let fits = 1;
    for (let take = graphemes.length; take >= 1; take -= 1) {
      const candidate = `${graphemes.slice(0, take).join("")}…`;
      if (measureNaturalWidth(prepareWithSegments(candidate, GH_LABEL_FONT)) <= GH_LABEL_MAX_WIDTH) {
        fits = take;
        break;
      }
    }
    return `${graphemes.slice(0, fits).join("")}…`;
  } catch {
    // Measurement needs a canvas; if one is unavailable the untouched label is
    // still correct, just possibly wide.
    return label;
  }
}

function setGitHubButton(state: "disconnected" | "connecting" | "connected", label: string): void {
  elements.githubConnect.dataset.state = state;
  // The inlined asset drives its own visuals from this attribute: muted when
  // disconnected, a violet orbit while connecting, a green check once verified.
  elements.githubConnect.querySelector(".gh-connection")?.setAttribute("data-gh-state", state);
  // Only the account name is unbounded; the fixed strings are known to fit.
  elements.githubConnectLabel.textContent =
    state === "connected" ? fitAccountLabel(label) : label;
  // The tooltip carries the full name even when the label was truncated.
  const description =
    state !== "connected"
      ? "Connect your GitHub account"
      : `Connected as ${label}. Autonomous access enabled. Click to disconnect.`;
  elements.githubConnect.title = description;
  elements.githubConnect.setAttribute("aria-label", description);
}

function setGitHubConnectError(message: string): void {
  elements.githubConnectError.textContent = message;
  if (message.length > 0) {
    elements.githubConnect.querySelector(".gh-connection")?.setAttribute("data-gh-state", "error");
  }
  elements.githubConnectError.hidden = message.length === 0;
}

function stopDevicePolling(): void {
  if (devicePollTimer !== null) {
    window.clearTimeout(devicePollTimer);
    devicePollTimer = null;
  }
  elements.githubDevice.hidden = true;
  elements.githubDeviceCode.textContent = "";
}

export async function refreshGitHubAccount(): Promise<void> {
  try {
    const account = await invoke<GitHubAccountState>("github_account_status");
    // The button is about Secret Tunnel's own connection. A credential merely
    // found in the machine's Git credential manager was granted to that
    // manager, not to this app, and showing it as connected leaves the user
    // with no way to press Connect at all - which is the one thing this
    // button exists to do.
    if (account.connected && account.login && account.source === "connected_account") {
      setGitHubButton("connected", account.login);
      const storage = account.storage === "windows_dpapi" ? "Stored using Windows user protection."
        : "Saved account file is not OS-encrypted; use the system credential helper where available.";
      elements.githubConnect.title += ` ${storage} Account identification does not verify this repository's publication permissions.`;
      // Reaching GitHub at all clears any earlier failure to do so.
      setGitHubConnectError("");
    } else {
      setGitHubButton("disconnected", "Connect GitHub");
      if (account.connected && account.login) {
        elements.githubConnect.title =
          `Not connected. Git on this computer already has a GitHub credential for ${account.login}, but it was granted to your Git credential manager, not to Secret Tunnel. Connect to give Secret Tunnel its own.`;
      }
    }
  } catch {
    // A status read failing should not blank the button.
    setGitHubButton("disconnected", "Connect GitHub");
  }
}

async function beginDeviceFlow(): Promise<void> {
  const start = await invoke<DeviceStart>("github_account_connect");
  setGitHubButton("connecting", "Waiting for GitHub…");
  elements.githubDeviceCode.textContent = start.userCode;
  elements.githubDevice.hidden = false;
  scheduleDevicePoll(start.deviceCode, start.intervalSecs, Date.now() + start.expiresInSecs * 1000);
}

async function toggleGitHubAccount(): Promise<void> {
  if (githubAccountBusy) return;
  if (elements.githubConnect.dataset.state === "connecting") return;

  githubAccountBusy = true;
  setGitHubConnectError("");
  try {
    if (elements.githubConnect.dataset.state === "connected") {
      await invoke<GitHubAccountState>("github_account_disconnect");
      stopDevicePolling();
        setGitHubButton("disconnected", "Connect GitHub");
      return;
    }

    await beginDeviceFlow();
  } catch (error) {
    const failure = error as AppError;
    setGitHubConnectError(failure?.message ?? "Could not reach GitHub.");
    setGitHubButton("disconnected", "Connect GitHub");
  } finally {
    githubAccountBusy = false;
  }
}

function scheduleDevicePoll(deviceCode: string, intervalSecs: number, deadlineMs: number): void {
  devicePollTimer = window.setTimeout(() => {
    void pollDeviceOnce(deviceCode, intervalSecs, deadlineMs);
  }, Math.max(1, intervalSecs) * 1000);
}

async function pollDeviceOnce(
  deviceCode: string,
  intervalSecs: number,
  deadlineMs: number,
): Promise<void> {
  if (Date.now() > deadlineMs) {
    stopDevicePolling();
    setGitHubConnectError("The code expired before it was approved. Try connecting again.");
    setGitHubButton("disconnected", "Connect GitHub");
    return;
  }
  try {
    const outcome = await invoke<PollOutcome>("github_account_poll", { deviceCode });
    switch (outcome.state) {
      case "pending":
        scheduleDevicePoll(deviceCode, intervalSecs, deadlineMs);
        return;
      case "slow_down":
        scheduleDevicePoll(deviceCode, outcome.intervalSecs, deadlineMs);
        return;
      case "connected":
        stopDevicePolling();
        setGitHubButton("connected", outcome.login);
        // Connecting is what turned autonomous operation on, so re-read rather
        // than leaving the window describing the state from a moment ago.
        void refreshGitHubAccount();
        return;
      case "denied":
        stopDevicePolling();
        setGitHubConnectError("GitHub access was declined.");
        setGitHubButton("disconnected", "Connect GitHub");
        return;
      case "expired":
        stopDevicePolling();
        setGitHubConnectError("The code expired before it was approved. Try connecting again.");
        setGitHubButton("disconnected", "Connect GitHub");
        return;
    }
  } catch (error) {
    stopDevicePolling();
    const failure = error as AppError;
    setGitHubConnectError(failure?.message ?? "Could not reach GitHub.");
    setGitHubButton("disconnected", "Connect GitHub");
  }
}
