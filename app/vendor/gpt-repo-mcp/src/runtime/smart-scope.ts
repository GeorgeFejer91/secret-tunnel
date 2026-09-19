import { RepoReaderError } from "./errors.js";

/**
 * Set by the Secret Tunnel desktop when its Folders tab has restricted this
 * endpoint to approved child folders. The restricted roots themselves arrive
 * in the ordinary configuration - this flag carries what the configuration
 * cannot say.
 *
 * Narrowing a root does not narrow Git: `git` resolves the repository above
 * whatever directory it is run in, so a server pointed at `<project>/For-AI`
 * would still read and commit the whole project. The same is true of the
 * GitHub routes, which act on the bound repository, and of anything that runs
 * an executable out of the repository. Those capabilities are refused here
 * rather than made to look confined.
 */
const SMART_SCOPE_ENV = "GPT_REPO_SMART_SCOPE";

/**
 * The tools that stay available: reading and writing files under the approved
 * roots, and describing what those roots are. An allow list rather than a deny
 * list, so a tool added later is refused until it has been shown to hold inside
 * a single child folder.
 */
const ALLOWED_TOOLS = new Set([
  "repo_list_roots",
  "repo_policy_explain",
  "repo_last_write",
  "repo_operation_ledger",
  "repo_tree",
  "repo_search",
  "repo_fetch_file",
  "repo_read_many",
  "repo_write_file",
  "repo_write_changes"
]);

export function smartScopeActive(): boolean {
  return process.env[SMART_SCOPE_ENV] === "1";
}

export function allowedInSmartScope(toolName: string): boolean {
  return !smartScopeActive() || ALLOWED_TOOLS.has(toolName);
}

/**
 * Refuse at execution, not only at registration. Withholding a tool from
 * `tools/list` is presentation: a client that kept an earlier list still calls
 * the handler, and that call has to fail too.
 */
export function assertAllowedInSmartScope(toolName: string): void {
  if (allowedInSmartScope(toolName)) return;
  throw new RepoReaderError(
    "SMART_SCOPE_RESTRICTED",
    `${toolName} is unavailable while this connection is restricted to approved folders. Only file reads and writes inside those folders are served.`
  );
}

/** The same refusal for a capability that is not reached through a named tool. */
export function assertCapabilityAllowedInSmartScope(capability: string): void {
  if (!smartScopeActive()) return;
  throw new RepoReaderError(
    "SMART_SCOPE_RESTRICTED",
    `${capability} cannot be confined to the approved folders and is unavailable while this connection is restricted to them.`
  );
}
