import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { posix } from "node:path";
import { isDelegationControlArtifact } from "../policies/delegation-control-artifacts.js";
import { RepoReaderError } from "../runtime/errors.js";
import { normalizeRepoPath } from "./ignore-engine.js";

export type BoundaryClassification =
  | { kind: "normal"; path: string }
  | { kind: "nested_repo"; path: string }
  | { kind: "submodule"; path: string };

export class PathSandbox {
  constructor(private readonly root: string) {}

  async resolve(repoPath: string): Promise<{ repoPath: string; absolutePath: string; stat: Awaited<ReturnType<typeof lstat>> }> {
    const normalized = validateRepoPath(repoPath);
    if (isDelegationControlArtifact(normalized)) {
      throw internalArtifactBlocked();
    }
    const absolutePath = join(this.root, normalized);
    const [rootReal, targetReal, stat] = await Promise.all([
      realpath(this.root),
      realpath(absolutePath),
      lstat(absolutePath)
    ]);

    if (!isWithin(rootReal, targetReal)) {
      throw new RepoReaderError("SYMLINK_ESCAPE_REJECTED", `Path escapes approved repository: ${normalized}`);
    }
    const realRepoPath = normalizeRepoPath(relative(rootReal, targetReal));
    if (isDelegationControlArtifact(realRepoPath)) {
      throw internalArtifactBlocked();
    }
    if (stat.isBlockDevice() || stat.isCharacterDevice() || stat.isFIFO() || stat.isSocket()) {
      throw new RepoReaderError("UNSUPPORTED_FILE_TYPE", `Unsupported file type: ${normalized}`);
    }

    return { repoPath: normalized, absolutePath: targetReal, stat };
  }

  async classifyBoundary(repoPath: string): Promise<BoundaryClassification> {
    const normalized = validateRepoPath(repoPath);
    const absolutePath = join(this.root, normalized);

    try {
      const dotGit = await lstat(join(absolutePath, ".git"));
      if (dotGit.isDirectory()) {
        return { kind: "nested_repo", path: normalized };
      }
      if (dotGit.isFile()) {
        return { kind: "submodule", path: normalized };
      }
    } catch {
      // Absence of .git means normal boundary.
    }

    return { kind: "normal", path: normalized };
  }
}

function internalArtifactBlocked(): RepoReaderError {
  return new RepoReaderError("INTERNAL_ARTIFACT_BLOCKED", "Internal delegation control artifact blocked.");
}

export function validateRepoPath(repoPath: string): string {
  if (repoPath.length === 0) {
    return ".";
  }
  // `win32.isAbsolute` is checked in addition to the platform's own, so a POSIX
  // host still rejects "C:\..." and "\\server\share". The bare drive-letter
  // regex catches the drive-*relative* form "C:file", which win32.isAbsolute
  // reports as false yet Windows resolves against that drive's current
  // directory - outside the repository. NUL is rejected because the path would
  // be truncated at the first NUL by the underlying syscall.
  if (
    repoPath.includes("\0") ||
    isAbsolute(repoPath) ||
    win32.isAbsolute(repoPath) ||
    /^[A-Za-z]:/.test(repoPath)
  ) {
    throw new RepoReaderError("ABSOLUTE_PATH_REJECTED", `Absolute paths are not allowed: ${repoPath}`);
  }

  const normalized = posix.normalize(normalizeRepoPath(repoPath));
  if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new RepoReaderError("PATH_TRAVERSAL_REJECTED", `Path traversal is not allowed: ${repoPath}`);
  }
  return normalized === "." ? "." : normalized.replace(/^\.\//, "");
}

/// Containment test. `relative` returns an ABSOLUTE path when the two sides
/// share no common root, which on Windows is any cross-drive pair: C:\repo
/// against D:\elsewhere yields "D:\elsewhere", a string containing no ".." at
/// all. A check that only looked for ".." therefore reported a different drive
/// as contained. Comparing to ".." exactly rather than with startsWith also
/// keeps a legitimate file named "..config" from being read as traversal.
function isWithin(rootPath: string, targetPath: string): boolean {
  const rel = relative(resolve(rootPath), resolve(targetPath));
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}
