import { invoke } from "@tauri-apps/api/core";

/// What this section needs from the shared status poll. Deliberately partial:
/// the module reads the folder list and what the backend says is exposed, and
/// nothing else in the window is its business.
export type SmartFoldersStatus = {
  settings: {
    workspacePath: string | null;
    extraFolders: string[];
    smartScope: { name: string; matches: Array<{ project: string; folder: string }> } | null;
  };
  exposedRoots: Array<{ repoId: string; displayName: string; root: string }>;
  rootsError: string | null;
};

type ScanMatch = {
  project: string;
  projectName: string;
  folder: string;
  folderName: string;
};

type Scan = {
  projects: Array<{ path: string; name: string; complete: boolean; note: string | null }>;
  scanned: string[];
  candidates: Array<{ key: string; display: string; projects: number; matches: ScanMatch[] }>;
  truncated: boolean;
};

const element = <T extends HTMLElement>(id: string): T => {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing Smart folders control: ${id}`);
  return found as T;
};

/// Smart folders: the Folders tab's second section.
///
/// The draft lives here - which projects to look in, which name is selected -
/// and the applied scope lives in the backend. Nothing on this side changes a
/// permission: scanning and choosing a name only redraw the preview, and the
/// two buttons are the only calls that reach the settings.
export function wireSmartFolders(fit: () => void): {
  render: (status: SmartFoldersStatus) => void;
} {
  const projectList = element<HTMLUListElement>("smart-project-list");
  const preview = element<HTMLUListElement>("smart-preview");
  const nameSelect = element<HTMLSelectElement>("smart-name");
  const refresh = element<HTMLButtonElement>("smart-refresh");
  const apply = element<HTMLButtonElement>("smart-apply");
  const restore = element<HTMLButtonElement>("smart-restore");
  const state = element<HTMLParagraphElement>("smart-state");

  let status: SmartFoldersStatus | null = null;
  let scan: Scan | null = null;
  /// The draft selection. A project the person unticked stays unticked across
  /// a status poll, so a four-second refresh does not undo their choice.
  const chosen = new Set<string>();
  let chosenSeeded = false;
  let selectedKey = "";
  let busy = false;
  let message: { text: string; level: "" | "ok" | "bad" } = { text: "", level: "" };

  const projects = (value: SmartFoldersStatus) =>
    [value.settings.workspacePath, ...value.settings.extraFolders].filter(
      (path): path is string => Boolean(path),
    );

  function setMessage(text: string, level: "" | "ok" | "bad" = "") {
    message = { text, level };
    drawState();
  }

  /// One line about what is actually being served, taken from the backend
  /// rather than from what was just asked for. A message from an action wins
  /// while it is on screen, because a failure has to stay visible.
  function drawState() {
    delete state.dataset.fullText;
    state.textContent = stateLine();
    const level = stateLevel();
    state.classList.toggle("state-ok", level === "ok");
    state.classList.toggle("state-bad", level === "bad");
    // The shared fitter owns the tooltip and the full-text cache, so the
    // element is given the whole string and then refitted.
    fit();
  }

  function stateLine(): string {
    if (message.text) return message.text;
    if (!status || projects(status).length === 0) return "";
    // Before any folder is chosen there is nothing to serve and nothing wrong
    // with that, which is why the resolver's error is only read once there is.
    if (status.rootsError) return status.rootsError;
    const scope = status.settings.smartScope;
    if (!scope) return "Full-project access. Every folder above is exposed in full.";
    return `Smart scope active: ${scope.name} — ${status.exposedRoots.length} of ${scope.matches.length} approved folders exposed.`;
  }

  function stateLevel(): "" | "ok" | "bad" {
    if (message.text) return message.level;
    if (!status || projects(status).length === 0) return "";
    if (status.rootsError) return "bad";
    const scope = status.settings.smartScope;
    if (!scope) return "";
    // Fewer roots than approvals means some match could not be honoured, which
    // is a narrower endpoint than the person applied and worth saying.
    return status.exposedRoots.length === scope.matches.length ? "ok" : "bad";
  }

  function drawProjects() {
    if (!status) return;
    const known = projects(status);
    if (!chosenSeeded && known.length > 0) {
      for (const path of known) chosen.add(path);
      chosenSeeded = true;
    }
    // A folder that has been removed from the list above is no longer a draft
    // choice either.
    for (const path of [...chosen]) if (!known.includes(path)) chosen.delete(path);

    const scanned = new Map((scan?.projects ?? []).map((entry) => [entry.path, entry]));
    projectList.replaceChildren(
      ...known.map((path) => {
        const row = document.createElement("li");
        const label = document.createElement("label");

        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = chosen.has(path);
        box.addEventListener("change", () => {
          if (box.checked) chosen.add(path);
          else chosen.delete(path);
          // A draft change invalidates the preview it was drawn from, and
          // changes nothing about what is served until Apply is pressed.
          message = { text: "", level: "" };
          void runScan();
        });

        const name = document.createElement("span");
        name.className = "smart-project-name";
        name.textContent = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
        name.title = path;

        label.append(box, name);
        row.append(label);

        const found = scanned.get(path);
        if (found && !found.complete) {
          const note = document.createElement("span");
          note.className = "smart-project-note";
          note.textContent = found.note ?? "Not fully read";
          note.title = note.textContent;
          row.append(note);
        }
        return row;
      }),
    );
    if (known.length === 0) {
      const empty = document.createElement("li");
      empty.textContent = "Add folders above first.";
      projectList.append(empty);
    }
  }

  function drawNames() {
    const candidates = scan?.candidates ?? [];
    if (!candidates.some((entry) => entry.key === selectedKey)) {
      selectedKey = candidates[0]?.key ?? "";
    }
    nameSelect.replaceChildren(
      ...candidates.map((entry) => {
        const option = document.createElement("option");
        option.value = entry.key;
        const covered = scan?.scanned.length ?? 0;
        option.textContent = `${entry.display} — ${entry.projects} of ${covered} projects`;
        option.selected = entry.key === selectedKey;
        return option;
      }),
    );
    if (candidates.length === 0) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = scan ? "No repeated folder name found" : "Not scanned yet";
      nameSelect.append(option);
    }
    nameSelect.disabled = candidates.length === 0;
  }

  function drawPreview() {
    const candidate = scan?.candidates.find((entry) => entry.key === selectedKey);
    const exposed = new Set(
      (status?.exposedRoots ?? []).map((entry) => entry.root.toLowerCase()),
    );
    const rows: HTMLLIElement[] = [];
    for (const project of scan?.projects ?? []) {
      if (!(scan?.scanned ?? []).includes(project.path)) continue;
      const hits = (candidate?.matches ?? []).filter((entry) => entry.project === project.path);
      if (hits.length === 0) {
        rows.push(previewRow(project.name, project.path, null, null, false));
        continue;
      }
      // Every actual path, including two that differ only in case: what is on
      // disk is what gets authorised, so it is what is shown.
      for (const hit of hits) {
        rows.push(
          previewRow(
            project.name,
            hit.folder,
            hit.folderName,
            hit.folder,
            exposed.has(hit.folder.toLowerCase()),
          ),
        );
      }
    }
    preview.replaceChildren(...rows);
    apply.disabled = busy || !candidate || (candidate?.matches.length ?? 0) === 0;
    refresh.disabled = busy;
    restore.disabled = busy || !status?.settings.smartScope;
  }

  function previewRow(
    projectName: string,
    title: string,
    folderName: string | null,
    folder: string | null,
    isExposed: boolean,
  ): HTMLLIElement {
    const row = document.createElement("li");

    const name = document.createElement("span");
    name.className = "smart-project-name";
    name.textContent = projectName;
    name.title = title;

    row.append(name);

    if (folderName !== null) {
      // The spelling as it is on disk. Case is the whole point of grouping, so
      // the variant that was actually found keeps a slot that cannot be cut.
      const spelling = document.createElement("span");
      spelling.className = "smart-preview-spelling";
      spelling.textContent = folderName;
      row.append(spelling);
    }

    const path = document.createElement("span");
    path.className = folder ? "smart-preview-path" : "smart-preview-path smart-preview-missing";
    // The exact path, not a project-relative fragment: what is approved is a
    // real directory, so the person sees the real directory - in full on hover
    // and to assistive technology when the row is too narrow for all of it.
    path.textContent = folder ?? "No folder of that name";
    path.title = folder ?? `No matching folder in ${title}`;

    row.append(path);

    if (isExposed) {
      const tag = document.createElement("span");
      tag.className = "smart-preview-exposed";
      tag.textContent = "Exposed now";
      row.append(tag);
    }
    return row;
  }

  function draw() {
    drawProjects();
    drawNames();
    drawPreview();
    drawState();
  }

  /// Read the disk again. Never changes a permission, and says so when the
  /// person asked for it explicitly.
  async function runScan(announce = false) {
    if (!status || busy) return;
    busy = true;
    drawPreview();
    try {
      scan = await invoke<Scan>("smart_folders_scan", { projects: [...chosen] });
      if (announce) {
        message = {
          text: scan.truncated
            ? "Refreshed. Too many distinct names to list them all."
            : "Refreshed. Nothing served has changed.",
          level: "",
        };
      }
    } catch (error) {
      message = { text: describe(error), level: "bad" };
    } finally {
      busy = false;
      draw();
    }
  }

  /// Apply or restore: the only two calls here that change what is served.
  async function act(command: string, args?: Record<string, unknown>) {
    if (busy) return;
    busy = true;
    drawPreview();
    try {
      status = await invoke<SmartFoldersStatus>(command, args);
      // Nothing to announce: the derived line now describes the new state, and
      // it comes from the backend rather than from having asked for it.
      message = { text: "", level: "" };
    } catch (error) {
      // A failed apply leaves the scope stored and the services stopped, so the
      // window reports the failure rather than an optimistic success. The next
      // status poll shows whatever the backend actually ended up serving.
      message = { text: describe(error), level: "bad" };
    } finally {
      busy = false;
      draw();
    }
    // Re-read from whatever the backend ended up with, keeping any failure on
    // screen.
    const failure = message;
    await runScan();
    if (failure.level === "bad") setMessage(failure.text, "bad");
  }

  nameSelect.addEventListener("change", () => {
    selectedKey = nameSelect.value;
    // Changing the selection previews it. It does not apply it.
    message = { text: "", level: "" };
    drawPreview();
    drawState();
  });
  refresh.addEventListener("click", () => void runScan(true));
  apply.addEventListener("click", () => {
    const candidate = scan?.candidates.find((entry) => entry.key === selectedKey);
    if (!candidate || candidate.matches.length === 0) return;
    void act("smart_folders_apply", {
      name: candidate.display,
      folders: candidate.matches.map((entry) => entry.folder),
    });
  });
  restore.addEventListener("click", () => void act("smart_folders_clear"));

  return {
    render(next: SmartFoldersStatus) {
      const first = status === null;
      const folders = projects(next).join(" ");
      const changed = status !== null && projects(status).join(" ") !== folders;
      status = next;
      draw();
      // Scan when the panel first has folders to look in, and when that list
      // changes - not on every status poll.
      if (first || changed) void runScan();
    },
  };
}

function describe(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return "That did not work.";
}
