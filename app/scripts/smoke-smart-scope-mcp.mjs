// The packaged MCP runtime, started against a smart-scope configuration in a
// disposable fixture tree, and asked to do the things the restriction has to
// stop. Nothing here touches the installed app, its profile or its tunnel: a
// temporary config file, a temporary fixture, a loopback port of its own.
//
// The Rust side is proved separately - `settings::tests` pins the exact
// managed-config document a scope produces. This script starts from that shape
// and proves what the packaged server does with it.
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, readFile, realpath, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { findRuntimeLayout } from "./runtime-layout.mjs";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const layout = findRuntimeLayout(rootDir, process.argv[2] ?? "src-tauri");
const serverPath = join(layout.runtimeDir, "dist", "server.js");
const port = process.env.SECRET_TUNNEL_SMOKE_PORT ?? String(19000 + (process.pid % 6000));

const DENIED_GLOBS = [
  ".git/**", ".env", ".env.*", "**/*.pem", "**/*.key",
  ".chatgpt/actions/reports/**", ".chatgpt/actions/workspace.json",
  ".chatgpt/actions/template.json", ".chatgpt/actions/README.md",
  ".chatgpt/actions/controller.lock",
];

const failures = [];
const checks = [];
function check(name, condition, detail = "") {
  checks.push({ name, ok: Boolean(condition) });
  if (!condition) failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

// Resolved, because Windows hands back a short 8.3 path here and the server
// reports the real one: comparing the two verbatim proves nothing.
const fixture = await realpath(await mkdtemp(join(tmpdir(), "secret-tunnel-smart-")));
try {
  await run();
} finally {
  await rm(fixture, { recursive: true, force: true });
}

for (const { name, ok } of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
if (failures.length > 0) {
  console.error(`\n${failures.length} smart-scope check(s) failed:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log(`\nSmart-scope MCP smoke check passed for ${layout.runtimeRoot} (${checks.length} checks).`);

async function run() {
  // Three projects with the name in three spellings, one without it, and one
  // approved folder holding a link that points at a sibling in its own project.
  const alpha = join(fixture, "alpha");
  const beta = join(fixture, "beta");
  const gamma = join(fixture, "gamma");
  const delta = join(fixture, "delta");
  for (const [dir, files] of [
    [join(alpha, "For-AI"), { "brief.md": "alpha brief\n" }],
    [join(alpha, "src"), { "secret.ts": "export const keep = true;\n" }],
    [alpha, { "README.md": "alpha readme\n" }],
    [join(beta, "for-ai"), { "brief.md": "beta brief\n" }],
    [join(beta, "src"), { "secret.ts": "export const keep = true;\n" }],
    [join(gamma, "FOR-AI"), { "brief.md": "gamma brief\n" }],
    [join(delta, "docs"), { "note.md": "delta note\n" }],
  ]) {
    await mkdir(dir, { recursive: true });
    for (const [name, body] of Object.entries(files)) await writeFile(join(dir, name), body);
  }

  // A link inside an approved folder, aimed at an out-of-scope sibling in the
  // same project. On Windows this needs the privilege; when it is unavailable
  // the check reports as skipped rather than as passed.
  let linkKind = null;
  try {
    await symlink(join(alpha, "src"), join(alpha, "For-AI", "escape"), "junction");
    linkKind = "junction";
  } catch {
    try {
      await symlink(join(alpha, "src"), join(alpha, "For-AI", "escape"), "dir");
      linkKind = "symlink";
    } catch {
      linkKind = null;
    }
  }

  const approved = [
    { repo_id: "smart-a1", display_name: "alpha/For-AI", root: join(alpha, "For-AI") },
    { repo_id: "smart-b2", display_name: "beta/for-ai", root: join(beta, "for-ai") },
    { repo_id: "smart-c3", display_name: "gamma/FOR-AI", root: join(gamma, "FOR-AI") },
  ];
  // The shape the Rust generator emits: smart ids, subfolder roots, the same
  // deny list and limit every root has always had, operations off.
  check(
    "config carries only subfolder roots with smart ids",
    approved.every((repo) => repo.repo_id.startsWith("smart-"))
      && approved.every((repo) => ![alpha, beta, gamma, delta].includes(repo.root)),
  );

  const configPath = join(fixture, "managed.json");
  const writeConfig = async (writesEnabled) =>
    writeFile(configPath, JSON.stringify({
      repos: approved.map((repo) => ({
        ...repo,
        allow_non_git: true,
        writes: {
          enabled: writesEnabled,
          allowed_globs: ["**"],
          denied_globs: DENIED_GLOBS,
          max_bytes_per_write: 1048576,
        },
        operations: { enabled: false },
      })),
      limits: { max_files: 50, max_bytes_per_file: 128000, max_total_bytes: 750000 },
    }, null, 2));

  await writeConfig(true);
  await withServer(configPath, true, async (client) => {
    const roots = await call(client, "repo_list_roots", {});
    const listed = (roots.structuredContent?.repos ?? []).map((repo) => repo.root);
    check("repo_list_roots lists only the approved child folders", listed.length === 3
      && listed.every((root) => approved.some((repo) => samePath(repo.root, root))),
      JSON.stringify(listed));

    const names = (await client.listTools({})).tools.map((tool) => tool.name);
    check("tools/list offers no Git, GitHub, task or cleanup tools",
      !names.some((name) => /git|github|codex|cleanup|patchset|validate|agent|handoff|ship/.test(name)),
      names.join(", "));
    check("file reads and writes are still offered",
      ["repo_fetch_file", "repo_write_file", "repo_write_changes", "repo_search", "repo_tree"]
        .every((name) => names.includes(name)));

    // Allowed work, inside each approved folder.
    const readInside = await call(client, "repo_fetch_file", { repo_id: "smart-a1", path: "brief.md" });
    check("an allowed read succeeds", !readInside.isError && JSON.stringify(readInside.structuredContent ?? {}).includes("alpha brief"), text(readInside));
    for (const repo of ["smart-a1", "smart-b2", "smart-c3"]) {
      const wrote = await call(client, "repo_write_file", { repo_id: repo, path: "notes/new.md", content: "ok\n", create_dirs: true });
      check(`an allowed write succeeds in ${repo}`, !wrote.isError, text(wrote));
    }

    // Everything outside an approved folder.
    for (const [name, args] of [
      ["parent README by traversal", { repo_id: "smart-a1", path: "../README.md", content: "x\n" }],
      ["sibling source by traversal", { repo_id: "smart-a1", path: "../src/secret.ts", content: "x\n" }],
      ["deep traversal out of the project", { repo_id: "smart-a1", path: "../../beta/src/secret.ts", content: "x\n" }],
      ["absolute path", { repo_id: "smart-a1", path: join(alpha, "src", "secret.ts"), content: "x\n" }],
      ["sibling-prefix trick", { repo_id: "smart-a1", path: "../For-AI-backup/x.md", content: "x\n", create_dirs: true }],
    ]) {
      const result = await call(client, "repo_write_file", args);
      check(`write is refused: ${name}`, result.isError, text(result));
    }
    for (const [name, args] of [
      ["parent README", { repo_id: "smart-a1", path: "../README.md" }],
      ["sibling source", { repo_id: "smart-a1", path: "../src/secret.ts" }],
    ]) {
      const result = await call(client, "repo_fetch_file", args);
      check(`read is refused: ${name}`, result.isError, text(result));
    }
    // A search is a read of many files, and is bounded by the same root.
    const search = await call(client, "repo_search", { repo_id: "smart-a1", query: "keep" });
    check("a search cannot reach the sibling folder",
      search.isError || JSON.stringify(search.structuredContent ?? {}).indexOf("secret.ts") === -1,
      text(search));

    if (linkKind) {
      const through = await call(client, "repo_write_file", { repo_id: "smart-a1", path: "escape/secret.ts", content: "x\n" });
      check(`a ${linkKind} inside an approved folder cannot be written through`, through.isError, text(through));
      const readThrough = await call(client, "repo_fetch_file", { repo_id: "smart-a1", path: "escape/secret.ts" });
      check(`a ${linkKind} inside an approved folder cannot be read through`, readThrough.isError, text(readThrough));
    } else {
      console.log("SKIP  link escape inside an approved folder — no privilege to create one here");
    }

    // The ids a client may have cached from before the scope was applied.
    for (const repo of ["workspace", "folder-deadbeef"]) {
      const stale = await call(client, "repo_fetch_file", { repo_id: repo, path: "README.md" });
      check(`the stale ${repo} id no longer resolves`, stale.isError, text(stale));
    }
    const unmatched = await call(client, "repo_fetch_file", { repo_id: "smart-a1", path: "../../delta/docs/note.md" });
    check("the unmatched project is unreachable", unmatched.isError, text(unmatched));

    // A cached call to a tool that is no longer listed. Hiding it is not the
    // control; this is.
    for (const name of ["repo_git_status", "repo_git_diff", "repo_write_commit", "repo_write_stage_commit",
      "repo_cleanup_paths", "repo_validate", "repo_write_handoff", "repo_apply_patchset",
      "github_status", "github_plan", "github_apply", "github_direct_publish", "repo_ship"]) {
      const result = await call(client, name, { repo_id: "smart-a1" });
      check(`a cached call to ${name} fails`, result.isError, text(result));
    }

    // A mixed pack must change nothing at all.
    const before = await readFile(join(alpha, "For-AI", "brief.md"), "utf8");
    const pack = await call(client, "repo_write_changes", {
      repo_id: "smart-a1",
      files: [
        { path: "brief.md", action: "write", content: "rewritten\n" },
        { path: "../src/secret.ts", action: "write", content: "rewritten\n" },
      ],
    });
    check("a mixed-scope pack is refused", pack.isError, text(pack));
    check("a refused pack leaves its allowed file byte-for-byte unchanged",
      (await readFile(join(alpha, "For-AI", "brief.md"), "utf8")) === before);
    check("a refused pack creates no directories", !existsSync(join(alpha, "For-AI-backup")));
    check("the out-of-scope sibling is unchanged",
      (await readFile(join(alpha, "src", "secret.ts"), "utf8")) === "export const keep = true;\n");
    check("the parent README is unchanged",
      (await readFile(join(alpha, "README.md"), "utf8")) === "alpha readme\n");
  });

  // Read mode still wins: a scope narrows where a write may land, it never
  // turns writing on.
  await writeConfig(false);
  await withServer(configPath, true, async (client) => {
    const blocked = await call(client, "repo_write_file", { repo_id: "smart-a1", path: "brief.md", content: "x\n" });
    check("read-only stays read-only inside an approved folder", blocked.isError, text(blocked));
  });

  // The same configuration without the flag: the roots alone would leave Git
  // and the GitHub paths offered, which is the reason the flag exists.
  await writeConfig(true);
  await withServer(configPath, false, async (client) => {
    const names = (await client.listTools({})).tools.map((tool) => tool.name);
    check("without the flag the same roots would still offer Git", names.includes("repo_git_status"));
  });

  // A scope root that has been deleted stops the server, rather than serving
  // whatever is left.
  await rm(join(alpha, "For-AI"), { recursive: true, force: true });
  const started = await startServer(configPath, true);
  // Exited, not merely unhealthy: the registry resolves every root at startup,
  // so a missing one is fatal rather than quietly dropped.
  check("a deleted approved folder stops the server rather than widening", started.exited, started.detail);
  check("and says which root it could not resolve", /ENOENT|no such file|cannot find/i.test(started.detail),
    started.detail);
  started.child.kill();
}

function samePath(left, right) {
  return left.replace(/\\/g, "/").toLowerCase() === right.replace(/\\/g, "/").toLowerCase();
}

function text(result) {
  return String(result?.content?.[0]?.text ?? "").slice(0, 200);
}

async function call(client, name, args) {
  try {
    return await client.callTool({ name, arguments: args });
  } catch (error) {
    // A tool that is not registered rejects rather than returning an error
    // result. Either way the call did not happen, which is what is being
    // checked, so both are normalised to one shape.
    return { isError: true, content: [{ type: "text", text: String(error?.message ?? error) }] };
  }
}

async function startServer(configPath, restricted) {
  const environment = { ...process.env };
  for (const key of ["SECRET_TUNNEL_BROKER_URL", "SECRET_TUNNEL_BROKER_TOKEN", "SECRET_TUNNEL_STORAGE_URL",
    "SECRET_TUNNEL_STORAGE_TOKEN", "SECRET_TUNNEL_NETWORK_DESCRIPTOR", "SECRET_TUNNEL_NETWORK_MCP_KEY",
    "GPT_REPO_READ_ONLY_SURFACE", "GPT_REPO_SMART_SCOPE"]) {
    delete environment[key];
  }
  if (restricted) environment.GPT_REPO_SMART_SCOPE = "1";
  const child = spawn(layout.nodePath, [serverPath], {
    cwd: layout.runtimeDir,
    env: {
      ...environment,
      GPT_REPO_CONFIG: configPath,
      REPO_READER_CONFIG: configPath,
      GPT_REPO_HOST: "127.0.0.1",
      PORT: port,
      GPT_REPO_PUBLIC_PATH_TOKEN: "smoketest",
      REPO_READER_PUBLIC_PATH_TOKEN: "smoketest",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  let exited = false;
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  child.on("exit", () => { exited = true; });

  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && !exited) {
    if (await probeHealth(url)) return { child, url, exited: false, detail: output };
    await new Promise((done) => setTimeout(done, 200));
  }
  return { child, url, exited: true, detail: output.slice(-400) };
}

async function probeHealth(url) {
  try {
    const response = await fetch(`${url}/health`);
    const body = await response.json();
    return response.ok && body?.ok === true;
  } catch {
    return false;
  }
}

async function withServer(configPath, restricted, body) {
  const started = await startServer(configPath, restricted);
  if (started.exited) {
    started.child.kill();
    throw new Error(`Packaged MCP did not become healthy.\n${started.detail}`);
  }
  const [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all([
    import(pathToFileURL(join(layout.runtimeDir, "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm", "client", "index.js"))),
    import(pathToFileURL(join(layout.runtimeDir, "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm", "client", "streamableHttp.js"))),
  ]);
  const client = new Client({ name: "secret-tunnel-smart-smoke", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${started.url}/t/smoketest/mcp`));
  try {
    await client.connect(transport);
    await body(client);
  } finally {
    await client.close().catch(() => undefined);
    started.child.kill();
    // The port is reused by the next server in this script, so wait for the
    // listener to actually go away rather than racing it.
    for (let attempt = 0; attempt < 40; attempt++) {
      if (!(await probeHealth(started.url))) break;
      await new Promise((done) => setTimeout(done, 100));
    }
  }
}
