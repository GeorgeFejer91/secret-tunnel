import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createBrokerClient, createGitHubHandlers, receiptZodSchema, runtimeStatus } from "./github-broker-client.mjs";
// The Pages verifier already exists and is tested; this bridge composes it
// rather than reimplementing deployment inspection.
import { inspectPages, apiPath } from "./github-pages/core.mjs";
import { createPublicReaders } from "./github-pages/http.mjs";

const PAGES_APEX_ADDRESSES = ["185.199.108.153", "185.199.109.153", "185.199.110.153", "185.199.111.153"];
const DOMAIN = /^(?!-)[a-z0-9-]{1,63}(?<!-)(?:\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

export function registerGitHubTools(server: McpServer, readOnlySurface: boolean): void {
  let client: ReturnType<typeof createBrokerClient> = null;
  let configurationState = "unconfigured";
  try {
    client = createBrokerClient();
    if (client) configurationState = "configured";
  } catch {
    configurationState = "invalid_configuration";
    console.error("GitHub broker configuration is invalid; diagnostics remain available.");
  }
  const handlers = createGitHubHandlers(client, readOnlySurface);
  const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const receiptSchema = receiptZodSchema(z);
  const planIdSchema = z.object({ planId: z.string().regex(/^plan-[a-f0-9]{32}$/) }).strict();

  server.registerTool("github_runtime_status", {
    title: "Identify this Secret Tunnel instance",
    description: "Read the app version, executable build fingerprint, desktop instance, access mode, broker state and GitHub tool-catalogue digest, plus whether a GitHub account is connected, as which login, and whether this installation is authorised to act without a per-operation desktop approval (approvalMode autonomous) and which credential its managed pushes authenticate with. Available even when the broker is absent. No credentials or approval authority are returned; reading autonomous here does not grant it.",
    inputSchema: z.object({}).strict(), annotations: readAnnotations
  }, () => runtimeStatus(client, readOnlySurface, configurationState));

  server.registerTool("github_status", {
    title: "GitHub workspace and operation status",
    description: "Read the selected folder, repository binding, runtime identity, pending and approved plans, recent execution receipts, the connected GitHub login, and the approval mode. When approvalMode is autonomous the user's one deliberate GitHub connection is the authorisation and mutations run without a further desktop click; when it is local_approval they wait for one. publicationAuthentication names the credential a managed push would use. An unavailable broker returns a diagnostic refusal, never silently removes this tool.",
    inputSchema: z.object({}).strict(), annotations: readAnnotations
  }, handlers.status);

  server.registerTool("github_operation_status", {
    title: "Read a durable GitHub operation receipt",
    description: "Look up the exact plan ID after an apply, timeout or reconnect. Returns running, succeeded, partial, failed or unknown with stage-specific evidence. This is read-only and cannot approve or restart an operation. Partial or unknown outcomes require reconciliation, not automatic replay.",
    inputSchema: planIdSchema, outputSchema: receiptSchema, annotations: readAnnotations
  }, handlers.operationStatus);

  server.registerTool("github_pages_status", {
    title: "Verify the live GitHub Pages deployment",
    description:
      "Report whether Pages is configured, the deployment state, the deployed commit, any failure reason, " +
      "and the public site URL, then fetch the live site and check it actually serves a page. Read-only: " +
      "it performs GET requests to GitHub and to the published site and changes nothing. The repository is the " +
      "one bound in the desktop; it cannot be chosen here. Identity is anchored to the bound numeric repository " +
      "id, so a renamed or re-created repository reports a mismatch instead of passing. When github_pages_ensure " +
      "configured a custom domain for this repository, that exact domain is the site fetched, and custom_domain " +
      "reports whether GitHub holds it, whether HTTPS is enforced, and the DNS records it expects, so a DNS " +
      "problem can be named rather than guessed. Any other origin is still refused. Pass expectContains to " +
      "assert exact published text instead of the default check that the page is HTML.",
    inputSchema: z.object({
      expectedCommit: z.string().regex(/^[a-f0-9]{40}$/).optional(),
      expectContains: z.string().min(1).max(4096).optional()
    }).strict(),
    annotations: readAnnotations
  }, async (args: { expectedCommit?: string; expectContains?: string }) => {
    const context = await handlers.pagesContext();
    if (context.isError) return context;
    const bound = context.structuredContent as {
      repository: string; repositoryId: number; commit: string; branch: string;
      pagesDomain: string | null; workflowPath: string | null;
      pagesSite: {
        buildType: string | null; htmlUrl: string | null; cname: string | null;
        httpsEnforced: boolean; sourceBranch: string | null; sourcePath: string | null;
      } | null;
    };
    const request: Record<string, unknown> = {
      repository: bound.repository,
      repository_id: bound.repositoryId,
      commit: args.expectedCommit ?? bound.commit,
      branch: bound.branch,
      // Fetching the site is the only way to answer "is it actually live", so
      // it is always requested. The default assertion is simply that the page
      // is HTML; anything stronger is the caller's to state.
      live: { assertion: { kind: "contains", value: args.expectContains ?? "<html" } }
    };
    // The one custom origin this app itself configured for this exact bound
    // repository. Any other origin GitHub reports stays refused.
    if (bound.pagesDomain) request.approved_site_origin = `https://${bound.pagesDomain}`;
    // For an Actions-built site the deploying run is the only per-commit
    // deployment evidence GitHub publishes, so name the workflow that deploys it.
    if (bound.workflowPath) request.workflow_id = bound.workflowPath.split("/").pop();
    try {
      // Every read below is a real HTTPS read of GitHub. The Pages site record
      // is the one GitHub refuses to serve without a credential, even for a
      // public repository, so the desktop — which holds one — supplies it;
      // everything else, and the site itself, is read anonymously.
      const readers = createPublicReaders(request as never);
      const pagesRoute = apiPath(request as never, "pages");
      const site = bound.pagesSite;
      const composed = {
        origin: readers.origin,
        readApi: (path: string) => path !== pagesRoute ? readers.readApi(path) : Promise.resolve(
          site === null ? { status: 404, body: null } : { status: 200, body: {
            build_type: site.buildType, html_url: site.htmlUrl, cname: site.cname,
            https_enforced: site.httpsEnforced,
            ...(site.sourceBranch === null ? {} : { source: { branch: site.sourceBranch, path: site.sourcePath } })
          } }),
        readSite: readers.readSite
      };
      const report = await inspectPages(request as never, composed as never) as Record<string, unknown>;
      const pages = report.pages as { cname?: string | null; https_enforced?: boolean } | undefined;
      if (bound.pagesDomain) {
        report.custom_domain = {
          domain: bound.pagesDomain,
          configured_on_github: pages?.cname === bound.pagesDomain,
          https_enforced: pages?.https_enforced === true,
          expected_dns: {
            apex_a: PAGES_APEX_ADDRESSES,
            // www must point at the OWNER's Pages host, not at the repository.
            www_cname: `${bound.repository.split("/")[0]}.github.io`
          }
        };
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(report, null, 2) }], structuredContent: report };
    } catch (error: unknown) {
      const failure = error as { code?: string; message?: string };
      const safe = { code: failure.code ?? "pages_verification_failed", message: failure.message ?? "Pages verification failed.", outcome: "not_applied" };
      return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error: safe }) }] };
    }
  });

  if (readOnlySurface) return;

  server.registerTool("github_plan", {
    title: "Propose an exact commit or publication",
    description: "Propose commit, commit_push, or push. Commits require one to fifty exact paths and a message. Push takes no paths or message and publishes the approved existing commit. The desktop binds effective GitHub destination, source branch/HEAD, remote tip and reviewed bytes. Only the local user can approve. Raw reviewed bytes are committed without hooks or clean filters; the managed push path supports HTTPS GitHub remotes only.",
    inputSchema: z.object({
      action: z.enum(["commit", "commit_push", "push"]),
      paths: z.array(z.string().min(1).max(512)).max(50).optional(),
      message: z.string().min(1).max(4000).optional()
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  }, handlers.plan);

  server.registerTool("github_apply", {
    title: "Execute a desktop-approved plan once",
    description: "Apply a plan already approved locally. No argument grants approval. Returns a version-1 durable operation receipt, not an unconditional success. A commit may succeed while publication fails. After a timeout query github_operation_status with this planId; do not create a duplicate plan automatically. A repeated apply returns the existing receipt instead of executing again. Publication has external effects.",
    inputSchema: planIdSchema, outputSchema: receiptSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  }, handlers.apply);

  server.registerTool("github_pages_ensure", {
    title: "Set up GitHub Pages deployment for this repository",
    description:
      "Write the minimal GitHub Actions Pages workflow when the repository does not already have one, and turn " +
      "Pages on with Actions as the build source. An existing workflow file is left untouched, so a project that " +
      "already builds its own site keeps its own build. This writes the workflow into the folder but does not " +
      "publish it: call repo_ship with the returned workflowPath to commit and push it, which is what triggers " +
      "the first deployment. Then poll github_pages_status. Only static publication from the repository root is " +
      "supported. Pass domain to bind a custom domain to the site through GitHub's Pages API, which is what " +
      "workflow-built Pages reads; a CNAME file in the repository is not that configuration. With " +
      "httpsEnforced, HTTPS is requested too, and a refusal while GitHub is still issuing the certificate is " +
      "returned as note rather than failing the call. The configured domain is returned as GitHub reports it, " +
      "and becomes the site github_pages_status verifies.",
    inputSchema: z.object({
      domain: z.string().min(4).max(253).regex(DOMAIN).optional(),
      httpsEnforced: z.boolean().optional()
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, handlers.pagesEnsure);

  server.registerTool("repo_ship", {
    title: "Commit the exact reviewed files and publish them",
    description:
      "Commit one to fifty exact repository-relative paths with the given message and push the result to the " +
      "bound repository's branch, returning a version-1 durable receipt with the commit SHA and the verified " +
      "remote ref. Publication has external effects and is not reversible from here. There is no force push, no " +
      "refspec and no choice of destination: the repository, branch and remote come from the desktop binding. " +
      "If the remote moved, this refuses rather than overwriting it. When the desktop is configured for local " +
      "approval this leaves a plan pending and refuses with plan_not_approved until a human approves it; when " +
      "the user has connected a GitHub account and approvalMode is autonomous, that connection is the " +
      "authorisation and this commits and pushes without a further desktop click. Every state check still " +
      "applies either way, so a moved HEAD, a moved remote or changed bytes still refuses.",
    inputSchema: z.object({
      paths: z.array(z.string().min(1).max(512)).min(1).max(50),
      message: z.string().min(1).max(4000)
    }).strict(),
    outputSchema: receiptSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  }, handlers.repoShip);

  server.registerTool("github_repo_ensure", {
    title: "Ensure this folder has a bound GitHub repository",
    description:
      "Return the GitHub repository this folder is bound to, initialising Git and creating the repository and " +
      "binding only if there is no usable binding yet. Safe to call repeatedly. It will not retarget a folder " +
      "that is already bound to a different repository. Returns owner, name, numeric repository id, URL, " +
      "default branch, and whether it was created now. A repository is created private unless visibility is " +
      "'public'; GitHub Pages on a free plan needs a public repository.",
    inputSchema: z.object({
      name: z.string().min(1).max(100).regex(/^[A-Za-z0-9._-]+$/).optional(),
      visibility: z.enum(["private", "public"]).optional()
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }, handlers.repoEnsure);

  server.registerTool("github_create_repository", {
    title: "Propose creating one private GitHub repository",
    description: "Propose creating a private repository under the verified connected account. Approval is local and binds that account. This operation creates the remote repository only: it does not initialize a folder, replace origin, bind, commit or push. Those changes require separate explicit desktop actions.",
    inputSchema: z.object({ name: z.string().min(1).max(100).regex(/^[A-Za-z0-9._-]+$/) }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  }, handlers.createRepository);

  server.registerTool("github_create_repository_apply", {
    title: "Execute a desktop-approved repository creation once",
    description: "Execute a locally approved creation plan, returning a version-1 receipt with createdRepository evidence. Never grants approval. After interrupted or uncertain creation, query github_operation_status and reconcile GitHub before making another plan. This does not change local Git configuration.",
    inputSchema: planIdSchema, outputSchema: receiptSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  }, handlers.createRepositoryApply);
}
