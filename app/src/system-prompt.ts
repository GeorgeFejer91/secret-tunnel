import { invoke } from "@tauri-apps/api/core";

/// The System Prompt tab: what this connection tells ChatGPT about itself
/// before ChatGPT touches a shared file.
///
/// Loaded once when the window opens rather than on the status poll. Two of
/// the four boxes are being typed into, and a four-second refresh would
/// overwrite a half-written sentence.

type SystemPrompt = {
  builtIn: string;
  customText: string;
  skillLinksText: string;
  /// Composed by the backend, which is the copy the MCP child is given.
  effective: string;
};

const element = <T extends HTMLElement>(id: string): T => {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing System Prompt control: ${id}`);
  return value as T;
};

export function wireSystemPrompt(fit: () => void): void {
  const builtIn = element<HTMLTextAreaElement>("system-prompt-builtin");
  const custom = element<HTMLTextAreaElement>("system-prompt-custom");
  const links = element<HTMLTextAreaElement>("system-prompt-links");
  const effective = element<HTMLTextAreaElement>("system-prompt-effective");
  const save = element<HTMLButtonElement>("system-prompt-save");
  const message = element<HTMLParagraphElement>("system-prompt-message");
  let busy = false;

  function note(text: string) {
    message.textContent = text;
    message.title = text;
    fit();
  }

  /// The same three rules as `effective_prompt` in `system_prompt.rs`: built-in
  /// first, then the custom text if there is any, then the non-blank links
  /// under one heading. A preview only - every load and save replaces it with
  /// the backend's own string, so a difference shows up rather than hiding.
  function preview() {
    const parts = [builtIn.value];
    if (custom.value.trim()) parts.push(custom.value.trim());
    const urls = links.value.split("\n").map((line) => line.trim()).filter(Boolean);
    if (urls.length) parts.push(`Skill links:\n${urls.join("\n")}`);
    effective.value = parts.join("\n\n");
  }

  function apply(state: SystemPrompt) {
    builtIn.value = state.builtIn;
    custom.value = state.customText;
    links.value = state.skillLinksText;
    effective.value = state.effective;
  }

  for (const box of [custom, links]) {
    box.addEventListener("input", preview);
  }

  save.addEventListener("click", () => {
    if (busy) return;
    busy = true;
    save.disabled = true;
    note("Saving. The local server restarts so the next connection sees this.");
    void invoke<SystemPrompt>("system_prompt_set", {
      customText: custom.value,
      skillLinksText: links.value,
    })
      .then((state) => {
        apply(state);
        note("Saved. ChatGPT reads this when it next connects to this tunnel.");
      })
      .catch((error: unknown) => note(errorText(error)))
      .finally(() => {
        busy = false;
        save.disabled = false;
      });
  });

  void invoke<SystemPrompt>("system_prompt_get")
    .then((state) => {
      apply(state);
      note("");
    })
    .catch((error: unknown) => note(errorText(error)));
}

function errorText(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) return String(error.message);
  return "The system prompt could not be read or saved.";
}
