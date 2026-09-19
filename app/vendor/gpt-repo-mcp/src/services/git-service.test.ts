import { mkdtemp, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GitService } from "./git-service.js";

/**
 * `git init` then a first file is where every new project starts, and it is
 * exactly the state `git rev-parse HEAD` refuses to answer for. Status used to
 * propagate that refusal, so the first thing a caller did in a brand new
 * repository failed with "fatal: ambiguous argument 'HEAD'".
 */
describe("status on a repository with no commit yet", () => {
  it("reports an unborn head instead of failing", async () => {
    const root = await mkdtemp(join(tmpdir(), "gpt-repo-unborn-"));
    execFileSync("git", ["init", "--initial-branch=main", "."], { cwd: root });
    await writeFile(join(root, "index.html"), "<html></html>\n");

    const status = await new GitService(root).status();

    expect(status.head_sha).toBeNull();
    expect(status.unborn).toBe(true);
    expect(status.branch).toBe("main");
    expect(status.clean).toBe(false);
    expect(status.files.map((file) => file.path)).toContain("index.html");
  });

  it("still reports a commit once one exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "gpt-repo-born-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root });
    git("init", "--initial-branch=main", ".");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.invalid");
    await writeFile(join(root, "index.html"), "<html></html>\n");
    git("add", "index.html");
    git("commit", "-m", "first");

    const status = await new GitService(root).status();

    expect(status.unborn).toBe(false);
    expect(status.head_sha).toMatch(/^[a-f0-9]{40}$/);
    expect(status.branch).toBe("main");
  });
});
