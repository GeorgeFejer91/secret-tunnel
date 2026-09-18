import { z } from "zod";
import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RuntimeContext } from "./runtime/context.js";
// The Pages verifier already exists, is tested, and is transport-agnostic:
// it reads GitHub and the published site over plain HTTPS. The direct path
// composes it rather than growing a second deployment inspector.
import { inspectPages } from "./github-pages/core.mjs";
import { createPublicReaders, getPublicHttps } from "./github-pages/http.mjs";

/* -------------------------------------------------------------- the path
 *
 * These tools call api.github.com from this process. They never ask the
 * desktop app to perform the mutation and never relabel an app-mediated
 * result as a direct one, which is the whole point of keeping the two paths
 * separate: a comparison is only worth anything if each side really is what
 * it says it is.
 *
 * They use the same one-time GitHub authorization as the app path. The
 * credential is fetched from the desktop over the authenticated loopback
 * broker for the duration of one call, is never cached, never logged and
 * never returned in a tool result.
 */

const GITHUB_API = "https://api.github.com";
const USER_AGENT = "SecretTunnel-v2-direct";
const WORKFLOW_PATH = ".github/workflows/pages.yml";
const DOMAIN = /^(?!-)[a-z0-9-]{1,63}(?<!-)(?:\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;
const REPOSITORY = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;
const SHA = /^[a-f0-9]{40}$/;

/** Same minimal workflow the app path installs, so both publish the same site. */
const PAGES_WORKFLOW = `name: Deploy static site to GitHub Pages

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: false

jobs:
  deploy:
    environment:
      name: github-pages
      url: \${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with:
          path: .
      - id: deployment
        uses: actions/deploy-pages@v4
`;

class DirectError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function refuse(code: string, message: string): never {
  throw new DirectError(code, message);
}

/* --------------------------------------------------------- the credential */

type Credential = { token: string; login: string; scopes: string[] };

/**
 * Ask the desktop for the connected account's token.
 *
 * Deliberately not the shared broker client: that one redacts anything
 * token-shaped out of every response, which is correct for every other route
 * and exactly wrong for this one.
 */
function brokerCredential(): Promise<{ token: string; login: string }> {
  const base = process.env.SECRET_TUNNEL_BROKER_URL;
  const bearer = process.env.SECRET_TUNNEL_BROKER_TOKEN;
  const matched = typeof base === "string" ? /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/?$/.exec(base) : null;
  if (!matched || typeof bearer !== "string" || !/^[a-f0-9]{64}$/.test(bearer)) {
    refuse("broker_configuration", "The direct GitHub path requires a valid local broker configuration.");
  }
  return new Promise((resolve, reject) => {
    const body = "{}";
    const req = httpRequest(
      {
        hostname: "127.0.0.1", port: Number(matched[1]), path: "/github/direct_credential",
        method: "POST", agent: false, maxHeaderSize: 16384,
        headers: {
          "content-type": "application/json", accept: "application/json",
          "content-length": Buffer.byteLength(body), authorization: `Bearer ${bearer}`
        }
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          let value: { token?: string; login?: string; error?: { code?: string; message?: string } };
          try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
          catch { reject(new DirectError("broker_json", "The desktop returned an unreadable reply.")); return; }
          if (res.statusCode !== 200 || typeof value.token !== "string" || typeof value.login !== "string") {
            reject(new DirectError(value.error?.code ?? "github_not_connected",
              value.error?.message ?? "Connect a GitHub account in Secret Tunnel first."));
            return;
          }
          resolve({ token: value.token, login: value.login });
        });
        res.on("error", () => reject(new DirectError("broker_network", "The local broker response failed.")));
      }
    );
    req.setTimeout(20000, () => { req.destroy(); reject(new DirectError("broker_timeout", "The desktop did not answer.")); });
    req.on("error", () => reject(new DirectError("broker_network", "The local broker request failed.")));
    req.end(body);
  });
}

/* ------------------------------------------------------------- the client */

type Reply = { status: number; body: unknown; scopes: string[] };

async function api(
  credential: { token: string }, method: string, path: string, body?: unknown
): Promise<Reply> {
  const response = await fetch(`${GITHUB_API}${path}`, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": USER_AGENT,
      "x-github-api-version": "2022-11-28",
      authorization: `Bearer ${credential.token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" })
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000)
  });
  const text = await response.text();
  let parsed: unknown = null;
  if (text.length > 0) { try { parsed = JSON.parse(text); } catch { parsed = null; } }
  return {
    status: response.status,
    body: parsed,
    scopes: (response.headers.get("x-oauth-scopes") ?? "").split(",").map((s) => s.trim()).filter(Boolean)
  };
}

/**
 * One verifier read of api.github.com, carrying the connected credential.
 *
 * Shaped like the verifier's own transport: a non-200 yields a null body
 * rather than throwing, so the report says which evidence was unavailable
 * instead of collapsing into one opaque failure.
 */
async function authenticatedRead(
  credential: Credential, url: string
): Promise<{ status: number; body: unknown }> {
  const path = url.slice(GITHUB_API.length);
  const reply = await api(credential, "GET", path);
  return { status: reply.status, body: reply.status === 200 ? reply.body : null };
}

/** GitHub's own message, which is almost always the actionable one. */
function githubMessage(reply: Reply, what: string): string {
  const message = (reply.body as { message?: string } | null)?.message;
  return typeof message === "string" ? message : `GitHub refused to ${what} with status ${reply.status}.`;
}

async function expect(reply: Reply, what: string, ...ok: number[]): Promise<Reply> {
  if (!ok.includes(reply.status)) refuse(`github_${reply.status}`, githubMessage(reply, what));
  return reply;
}

async function connect(): Promise<Credential> {
  const { token, login } = await brokerCredential();
  const user = await api({ token }, "GET", "/user");
  if (user.status !== 200) refuse("github_not_connected", githubMessage(user, "identify the account"));
  const observed = (user.body as { login?: string }).login;
  if (observed !== login) {
    refuse("account_changed", "The GitHub account answering differs from the one Secret Tunnel connected.");
  }
  return { token, login, scopes: user.scopes };
}

/* -------------------------------------------------------------- the files */

/**
 * Read the exact bytes of the named workspace-relative paths.
 *
 * Same folder the local file tools expose and the same per-file limit, so the
 * direct path cannot reach outside the folder the user selected.
 */
async function readWorkspaceFiles(
  context: RuntimeContext, paths: string[]
): Promise<Array<{ path: string; content: Buffer }>> {
  const repo = context.registry.get("workspace");
  const limit = context.registry.limits.max_bytes_per_file;
  const files = [];
  for (const path of paths) {
    if (path.length === 0 || path.length > 512 || path.startsWith("/") || path.includes("\\")
      || path.includes("\0") || /(^|\/)\.\.(\/|$)/.test(path) || /^[A-Za-z]:/.test(path)) {
      refuse("invalid_paths", `'${path}' is not a repository-relative file path.`);
    }
    let content: Buffer;
    try { content = await readFile(join(repo.root, ...path.split("/"))); }
    catch { refuse("file_unreadable", `'${path}' could not be read from the selected folder.`); }
    if (content.length > limit) refuse("file_too_large", `'${path}' exceeds the configured per-file limit.`);
    files.push({ path, content });
  }
  return files;
}

/* ------------------------------------------------------------- the commit */

function splitRepository(repository: string): [string, string] {
  if (!REPOSITORY.test(repository)) refuse("invalid_repository", "Use owner/name.");
  const [owner, repo] = repository.split("/");
  return [owner, repo];
}

/**
 * One commit containing every named file, built from blobs and a tree.
 *
 * The contents API would need one commit per file, which leaves the branch in
 * intermediate states a deployment can pick up. This is the direct-path
 * equivalent of staging several files and committing once.
 */
async function commitFiles(
  credential: Credential, owner: string, repo: string, branch: string,
  files: Array<{ path: string; content: Buffer }>, message: string
): Promise<{ commit: string; parent: string | null }> {
  const ref = await api(credential, "GET", `/repos/${owner}/${repo}/git/ref/heads/${branch}`);
  let parent: string | null = null;
  let baseTree: string | undefined;
  if (ref.status === 200) {
    parent = (ref.body as { object?: { sha?: string } }).object?.sha ?? null;
    if (parent === null || !SHA.test(parent)) refuse("github_bad_response", "GitHub returned no branch tip.");
    const head = await expect(
      await api(credential, "GET", `/repos/${owner}/${repo}/git/commits/${parent}`), "read the branch tip", 200
    );
    baseTree = (head.body as { tree?: { sha?: string } }).tree?.sha;
  } else if (ref.status !== 404 && ref.status !== 409) {
    refuse(`github_${ref.status}`, githubMessage(ref, "read the branch"));
  }

  const tree = [];
  for (const file of files) {
    const blob = await api(credential, "POST", `/repos/${owner}/${repo}/git/blobs`,
      { content: file.content.toString("base64"), encoding: "base64" });
    // The one refusal worth translating: GitHub's own wording names the
    // symptom, not what the caller should do about it.
    if (blob.status === 409) {
      refuse("repository_empty",
        "This repository has no commits, and GitHub's git data API cannot write to an empty one. "
        + "Create it with github_direct_repo_ensure, which initialises it.");
    }
    await expect(blob, `upload ${file.path}`, 201);
    tree.push({ path: file.path, mode: "100644", type: "blob", sha: (blob.body as { sha: string }).sha });
  }
  const created = await expect(
    await api(credential, "POST", `/repos/${owner}/${repo}/git/trees`,
      { ...(baseTree === undefined ? {} : { base_tree: baseTree }), tree }),
    "create the tree", 201
  );
  const commit = await expect(
    await api(credential, "POST", `/repos/${owner}/${repo}/git/commits`, {
      message, tree: (created.body as { sha: string }).sha,
      parents: parent === null ? [] : [parent]
    }),
    "create the commit", 201
  );
  const sha = (commit.body as { sha: string }).sha;

  // Never forced: a branch that moved under us is a refusal, not an overwrite.
  const updated = parent === null
    ? await api(credential, "POST", `/repos/${owner}/${repo}/git/refs`,
      { ref: `refs/heads/${branch}`, sha })
    : await api(credential, "PATCH", `/repos/${owner}/${repo}/git/refs/heads/${branch}`,
      { sha, force: false });
  if (updated.status === 422) {
    refuse("remote_moved", "The remote branch moved. Read the ref and publish again; nothing was overwritten.");
  }
  await expect(updated, "update the branch", 200, 201);
  return { commit: sha, parent };
}

/* --------------------------------------------------------------- the tools */

const ok = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  structuredContent: value as Record<string, unknown>
});

function failed(error: unknown) {
  const failure = error as { code?: string; message?: string };
  return {
    isError: true as const,
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        error: {
          code: failure.code ?? "direct_failed",
          message: failure.message ?? "The direct GitHub call failed.",
          path: "direct"
        }
      })
    }]
  };
}

const guard = <A>(run: (args: A) => Promise<ReturnType<typeof ok>>) =>
  async (args: A) => { try { return await run(args); } catch (error) { return failed(error); } };

export function registerDirectGitHubTools(
  server: McpServer, context: RuntimeContext, readOnlySurface: boolean
): void {
  const repositoryArg = z.string().regex(REPOSITORY);
  const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

  server.registerTool("github_direct_status", {
    title: "Identify the GitHub account the direct path uses",
    description:
      "Call GitHub's user endpoint directly and report the authenticated login and the effective OAuth scopes " +
      "of Secret Tunnel's one GitHub connection. This is the direct path: it contacts api.github.com from the " +
      "MCP server and never asks the desktop app to act. Use it to check that the grant actually covers what a " +
      "publication needs before attempting one. Read-only; returns no credential.",
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, guard(async () => {
    const credential = await connect();
    return ok({
      path: "direct", login: credential.login, scopes: credential.scopes,
      canWriteRepositories: credential.scopes.includes("repo"),
      canWriteWorkflows: credential.scopes.includes("workflow")
    });
  }));

  server.registerTool("github_direct_ref", {
    title: "Read a branch tip straight from GitHub",
    description:
      "Read the commit a branch points at, by calling GitHub's git ref endpoint directly. Use it to verify " +
      "independently that a publication landed. Read-only: it creates and changes nothing, and it does not " +
      "consult the desktop app's binding - name the repository explicitly as owner/name.",
    inputSchema: z.object({ repository: repositoryArg, branch: z.string().min(1).max(200).default("main") }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, guard(async (args: { repository: string; branch: string }) => {
    const credential = await connect();
    const [owner, repo] = splitRepository(args.repository);
    const ref = await api(credential, "GET", `/repos/${owner}/${repo}/git/ref/heads/${args.branch}`);
    if (ref.status === 404 || ref.status === 409) {
      return ok({ path: "direct", repository: args.repository, branch: args.branch, commit: null, exists: false });
    }
    await expect(ref, "read the branch", 200);
    return ok({
      path: "direct", repository: args.repository, branch: args.branch, exists: true,
      commit: (ref.body as { object: { sha: string } }).object.sha
    });
  }));

  if (readOnlySurface) return;

  server.registerTool("github_direct_repo_ensure", {
    title: "Create or read a GitHub repository, directly",
    description:
      "Return the named repository under the connected account, creating it through GitHub's API when it does " +
      "not exist. This is the direct path: no local Git, no folder initialisation and no desktop binding " +
      "happen, so the repository is usable immediately by the other direct tools and by nothing else. Safe to " +
      "call repeatedly; an existing repository is read, never reconfigured. A repository is created private " +
      "unless visibility is 'public'; GitHub Pages on a free plan needs a public repository.",
    inputSchema: z.object({
      name: z.string().min(1).max(100).regex(/^[A-Za-z0-9._-]+$/),
      visibility: z.enum(["private", "public"]).optional()
    }).strict(),
    annotations: { ...write, idempotentHint: true }
  }, guard(async (args: { name: string; visibility?: "private" | "public" }) => {
    const credential = await connect();
    const existing = await api(credential, "GET", `/repos/${credential.login}/${args.name}`);
    if (existing.status === 200) {
      const value = existing.body as { id: number; full_name: string; html_url: string; private: boolean; default_branch: string };
      return ok({
        path: "direct", repository: value.full_name, repositoryId: value.id, htmlUrl: value.html_url,
        visibility: value.private ? "private" : "public", branch: value.default_branch, created: false
      });
    }
    if (existing.status !== 404) refuse(`github_${existing.status}`, githubMessage(existing, "read the repository"));
    const made = await expect(
      // Initialised on purpose, unlike the app path. GitHub's git data API -
      // blobs, trees, commits - answers 409 "Git Repository is empty" until a
      // repository has at least one commit, so an uninitialised repository
      // could never receive its first direct publication. The app path wants
      // the opposite, because it pushes a local history onto the remote.
      await api(credential, "POST", "/user/repos",
        { name: args.name, private: args.visibility !== "public", auto_init: true }),
      "create the repository", 201
    );
    const value = made.body as { id: number; full_name: string; html_url: string; private: boolean; default_branch: string };
    return ok({
      path: "direct", repository: value.full_name, repositoryId: value.id, htmlUrl: value.html_url,
      visibility: value.private ? "private" : "public", branch: value.default_branch ?? "main", created: true
    });
  }));

  server.registerTool("github_direct_publish", {
    title: "Publish exact local files as one direct GitHub commit",
    description:
      "Read the named files from the selected folder and write them to the named GitHub repository as a single " +
      "commit, by calling GitHub's git data API directly. This is the direct path: nothing is committed to the " +
      "local repository, nothing is pushed, and the desktop app performs no part of it. All files land in one " +
      "commit rather than one commit each, so no deployment ever sees a half-published site. There is no force " +
      "update: if the branch moved since its tip was read, this refuses instead of overwriting it. Returns the " +
      "new commit SHA and the branch tip read back from GitHub afterwards.",
    inputSchema: z.object({
      repository: repositoryArg,
      paths: z.array(z.string().min(1).max(512)).min(1).max(50),
      message: z.string().min(1).max(4000),
      branch: z.string().min(1).max(200).default("main")
    }).strict(),
    annotations: { ...write, destructiveHint: true }
  }, guard(async (args: { repository: string; paths: string[]; message: string; branch: string }) => {
    const credential = await connect();
    const [owner, repo] = splitRepository(args.repository);
    if (args.paths.some((path) => path.startsWith(".github/workflows/")) && !credential.scopes.includes("workflow")) {
      refuse("insufficient_scope",
        "This connection has no 'workflow' scope, so GitHub will reject a workflow file. Reconnect GitHub in Secret Tunnel.");
    }
    const files = await readWorkspaceFiles(context, args.paths);
    const { commit, parent } = await commitFiles(credential, owner, repo, args.branch, files, args.message);
    const verify = await expect(
      await api(credential, "GET", `/repos/${owner}/${repo}/git/ref/heads/${args.branch}`), "verify the branch", 200
    );
    return ok({
      path: "direct", repository: args.repository, branch: args.branch,
      parentCommit: parent, commit,
      verifiedRemoteHead: (verify.body as { object: { sha: string } }).object.sha,
      committedPaths: files.map((file) => file.path)
    });
  }));

  server.registerTool("github_direct_pages_ensure", {
    title: "Turn on GitHub Pages, directly",
    description:
      "Configure GitHub Pages for the named repository through GitHub's API, adding the minimal static-site " +
      "Actions workflow to the repository when it has none. This is the direct path: the workflow is committed " +
      "straight to GitHub and the selected folder is not touched. An existing workflow file is left exactly as " +
      "it is, so a project that builds its own site keeps its own build. Pass domain to bind a custom domain " +
      "through the Pages API, which is the configuration workflow-built Pages reads; a CNAME file is not. With " +
      "httpsEnforced, HTTPS is requested too, and a refusal while GitHub is still issuing the certificate is " +
      "reported as note rather than failing. Returns the configuration read back from GitHub.",
    inputSchema: z.object({
      repository: repositoryArg,
      domain: z.string().min(4).max(253).regex(DOMAIN).optional(),
      httpsEnforced: z.boolean().optional(),
      branch: z.string().min(1).max(200).default("main")
    }).strict(),
    annotations: { ...write, idempotentHint: true }
  }, guard(async (args: { repository: string; domain?: string; httpsEnforced?: boolean; branch: string }) => {
    if (args.httpsEnforced === true && args.domain === undefined) {
      refuse("invalid_input", "HTTPS can only be enforced for a custom domain.");
    }
    const credential = await connect();
    const [owner, repo] = splitRepository(args.repository);

    // Pages is switched on *before* the workflow is committed, never after.
    // Committing first would start a deployment run against a repository with
    // Pages still disabled, which fails, and the site would then need an
    // unrelated third commit to deploy. Enabling first means the run the
    // workflow commit triggers is the run that publishes the site.
    const site = `/repos/${owner}/${repo}/pages`;
    const enabled = await api(credential, "POST", site, { build_type: "workflow" });
    // 409 is GitHub saying Pages already exists, which is success here.
    if (enabled.status !== 201 && enabled.status !== 409) {
      refuse(`github_${enabled.status}`, githubMessage(enabled, "enable Pages"));
    }

    const present = await api(credential, "GET", `/repos/${owner}/${repo}/contents/${WORKFLOW_PATH}?ref=${args.branch}`);
    let workflowWritten = false;
    let workflowCommit: string | null = null;
    if (present.status === 404) {
      if (!credential.scopes.includes("workflow")) {
        refuse("insufficient_scope",
          "This connection has no 'workflow' scope, so GitHub will reject the Pages workflow. Reconnect GitHub in Secret Tunnel.");
      }
      const written = await commitFiles(credential, owner, repo, args.branch,
        [{ path: WORKFLOW_PATH, content: Buffer.from(PAGES_WORKFLOW, "utf8") }],
        "Add the GitHub Pages deployment workflow");
      workflowWritten = true;
      workflowCommit = written.commit;
    } else if (present.status !== 200) {
      refuse(`github_${present.status}`, githubMessage(present, "read the workflow file"));
    }

    let note: string | null = null;
    if (args.domain !== undefined) {
      await expect(await api(credential, "PUT", site, { cname: args.domain, build_type: "workflow" }),
        "set the custom domain", 204, 200);
      if (args.httpsEnforced === true) {
        const https = await api(credential, "PUT", site, { https_enforced: true });
        if (https.status !== 204 && https.status !== 200) note = githubMessage(https, "enforce HTTPS");
      }
    }
    const read = await expect(await api(credential, "GET", site), "read the Pages site back", 200);
    const value = read.body as { html_url?: string; cname?: string | null; https_enforced?: boolean; build_type?: string };
    return ok({
      path: "direct", repository: args.repository, workflowPath: WORKFLOW_PATH, workflowWritten,
      workflowCommit,
      pages: enabled.status === 409 ? "already_enabled" : "enabled",
      buildType: value.build_type ?? null, publicUrl: value.html_url ?? null,
      domain: value.cname ?? null, httpsEnforced: value.https_enforced === true, note
    });
  }));

  server.registerTool("github_direct_pages_status", {
    title: "Verify a directly published Pages deployment",
    description:
      "Report whether Pages is configured for the named repository, the deployment state, the deploying " +
      "workflow run for the exact commit, the public URL and any custom domain, then fetch the live site and " +
      "check it actually serves the expected content. Read-only. Identity is anchored to GitHub's numeric " +
      "repository id read at the start, so a renamed or re-created repository reports a mismatch instead of " +
      "passing. Pass expectedCommit to verify a specific publication, and expectContains to assert exact " +
      "published text instead of the default check that the page is HTML.",
    inputSchema: z.object({
      repository: repositoryArg,
      branch: z.string().min(1).max(200).default("main"),
      expectedCommit: z.string().regex(SHA).optional(),
      expectContains: z.string().min(1).max(4096).optional()
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, guard(async (args: { repository: string; branch: string; expectedCommit?: string; expectContains?: string }) => {
    const credential = await connect();
    const [owner, repo] = splitRepository(args.repository);
    const info = await expect(await api(credential, "GET", `/repos/${owner}/${repo}`), "read the repository", 200);
    const repositoryId = (info.body as { id: number }).id;
    let commit = args.expectedCommit;
    if (commit === undefined) {
      const ref = await expect(
        await api(credential, "GET", `/repos/${owner}/${repo}/git/ref/heads/${args.branch}`), "read the branch", 200
      );
      commit = (ref.body as { object: { sha: string } }).object.sha;
    }
    const site = await api(credential, "GET", `/repos/${owner}/${repo}/pages`);
    const cname = site.status === 200 ? (site.body as { cname?: string | null }).cname ?? null : null;
    const request: Record<string, unknown> = {
      repository: `${owner}/${repo}`, repository_id: repositoryId, commit, branch: args.branch,
      workflow_id: "pages.yml",
      live: { assertion: { kind: "contains", value: args.expectContains ?? "<html" } }
    };
    if (cname !== null) request.approved_site_origin = `https://${cname}`;
    // Authenticated GitHub reads, unauthenticated site read.
    //
    // The verifier makes about six API calls per poll, and GitHub's
    // unauthenticated limit is sixty an hour per address, so polling a
    // deployment anonymously runs out of budget mid-deployment and reports a
    // rate-limit as a missing site. Reads of the published site stay
    // anonymous through the verifier's own SSRF-checked transport, because
    // that URL is attacker-influenced and must not carry a credential.
    const readers = createPublicReaders(request as never, {
      transport: (url, options) =>
        options?.json === true && url.startsWith(`${GITHUB_API}/`)
          ? authenticatedRead(credential, url)
          : getPublicHttps(url, options)
    });
    const report = await inspectPages(request as never, readers) as Record<string, unknown>;
    report.path = "direct";
    return ok(report);
  }));
}
