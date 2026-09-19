import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";

type Ticket = {
  id: string; revision: number; workspace_id: string; title: string; summary: string;
  outcome: string; effects: string[]; inputs: string[]; steps: unknown[]; verification: unknown[];
};
type Review = { ticket: Ticket; review_digest: string; checks_only: boolean; inputs: unknown[] };
type Receipt = {
  id: string; revision: number; title: string; attempt_id: string; status: string;
  verification_status: string; error?: string; export_error?: string;
  steps?: { id: string; title: string; phase: string; status: string; error?: string }[];
};
type Snapshot = {
  workspace: string; workspace_id: string; pending: Review[]; backlog: number; scan_truncated: boolean;
  active: Receipt | null; queued: Receipt[]; history: Receipt[]; errors: { file: string; message: string }[];
  paused: boolean; policy: { remaining: number; expires_at: number } | null; last_error: string | null; template: unknown;
};
type Selection = { id: string; revision: number; review_digest: string };
const element = <T extends HTMLElement>(id: string) => {
  const found = document.getElementById(id); if (!found) throw new Error(`Missing Actions element: ${id}`); return found as T;
};
const selection = (view: Review): Selection => ({ id: view.ticket.id, revision: view.ticket.revision, review_digest: view.review_digest });
let snapshot: Snapshot | null = null;
let busy = false;
let refreshing = false;
let pendingKey = "";
let reviewing: Review[] = [];
const selected = new Set<string>();
const reviewDialog = element<HTMLDialogElement>("review-dialog");
const receiptDialog = element<HTMLDialogElement>("receipt-dialog");

function node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag);
  if (text !== undefined) result.textContent = text;
  if (className) result.className = className;
  return result;
}
function button(text: string, click: () => void) { const result = node("button", text); result.addEventListener("click", click); return result; }
function message(value: string, error = false) {
  const target = element("message"); target.textContent = value; target.classList.toggle("error", error);
}
const call = <T>(method: string, params: object = {}) => invoke<T>("actions_request", { method, params });
async function act<T>(work: () => Promise<T>, success?: string): Promise<T | undefined> {
  if (busy) return;
  busy = true;
  element<HTMLButtonElement>("confirm-review").disabled = true;
  try { const result = await work(); if (success) message(success); return result; }
  catch (error) { message((error as { message?: string }).message ?? String(error), true); }
  finally { busy = false; element<HTMLButtonElement>("confirm-review").disabled = false; await refresh(); }
}
async function refresh() {
  if (refreshing || busy) return;
  refreshing = true;
  try { render(await call<Snapshot>("list")); }
  catch (error) { message((error as { message?: string }).message ?? String(error), true); }
  finally { refreshing = false; }
}
function beginReview(views: Review[]) {
  if (!views.length || busy) return;
  reviewing = structuredClone(views);
  element("review-title").textContent = `Approve ${views.length} exact action pack${views.length === 1 ? "" : "s"}`;
  const code = views.some(v => !v.checks_only);
  element("review-warning").textContent = code
    ? "These packs execute project or custom code as your operating-system user. They are not sandboxed and may access files or network resources outside the project. Review the complete steps below. This approves only the displayed revisions, not future tickets."
    : "These packs run application-owned file checks and write reports. This approves only the displayed revisions. Checks do not execute scripts or applications.";
  const content = element("review-content"); content.replaceChildren();
  for (const view of reviewing) {
    const card = node("article", undefined, "card"); card.append(node("h3", view.ticket.title), node("p", view.ticket.summary));
    card.append(node("p", `Outcome: ${view.ticket.outcome}`));
    card.append(node("pre", JSON.stringify({ ticket: view.ticket, bound_inputs: view.inputs }, null, 2)));
    content.append(card);
  }
  element("confirm-review").textContent = `Execute ${views.length} pack${views.length === 1 ? "" : "s"}`;
  reviewDialog.showModal();
}
function updateSelected() {
  const count = snapshot?.pending.filter(v => selected.has(v.review_digest)).length ?? 0;
  const control = element<HTMLButtonElement>("approve-selected"); control.disabled = count === 0;
  control.textContent = count ? `Review selected (${count})` : "Review selected";
}
function render(state: Snapshot) {
  snapshot = state;
  element("workspace").textContent = state.workspace;
  element<HTMLInputElement>("auto-checks").checked = state.policy !== null;
  element("policy-status").textContent = state.policy
    ? `${state.policy.remaining} built-in check packs left. Expires at ${new Date(state.policy.expires_at).toLocaleTimeString()}. No script or executable auto-approval.`
    : "Off. Scripts and executables always require approval. Enable for at most five check-only packs or 30 minutes.";
  element<HTMLButtonElement>("pause").disabled = state.paused;
  element<HTMLButtonElement>("resume").disabled = !state.paused;
  element<HTMLButtonElement>("cancel").disabled = !state.active && state.queued.length === 0;
  element<HTMLButtonElement>("approve-buffer").disabled = !state.pending.length || state.paused;
  element("count").textContent = `${state.pending.length} / 5`;
  element("backlog").textContent = `${state.backlog ? `${state.backlog} additional packs wait behind this buffer. ` : ""}${state.scan_truncated ? "Scan limit reached. Archive old inbox files locally to reveal more tickets. " : ""}${state.paused ? "Queue paused. Already-approved work requires Resume; new tickets remain unapproved." : "At most five packs can be approved or running at once."}`;
  const key = state.pending.map(v => v.review_digest).join(":");
  if (key !== pendingKey || !element("pending").childNodes.length) {
    pendingKey = key;
    const target = element("pending"); target.replaceChildren();
    const available = new Set(state.pending.map(v => v.review_digest));
    for (const id of selected) if (!available.has(id)) selected.delete(id);
    if (!state.pending.length) target.append(node("p", "No unapproved packs. Set up the inbox, then ask the agent to fill the reusable template."));
    for (const view of state.pending) {
      const ticket = view.ticket; const card = node("article", undefined, "card");
      const label = node("label"); const check = node("input"); check.type = "checkbox"; check.checked = selected.has(view.review_digest);
      check.addEventListener("change", () => { if (check.checked) selected.add(view.review_digest); else selected.delete(view.review_digest); updateSelected(); });
      label.append(check, node("span", ticket.title));
      card.append(label, node("p", `${ticket.id} · revision ${ticket.revision}`, "meta"), node("p", ticket.summary), node("p", `Outcome: ${ticket.outcome}`));
      card.append(node("span", `${ticket.steps.length} execution steps + ${ticket.verification.length} checks`, "tag"), node("span", view.checks_only ? "Built-in checks" : "Executes code · not sandboxed", "tag"));
      if (ticket.effects.length) card.append(node("p", `Declared effects: ${ticket.effects.join("; ")}`));
      const details = node("details"); details.append(node("summary", "Review exact steps and input bindings"), node("pre", JSON.stringify({ ticket, bound_inputs: view.inputs }, null, 2)));
      const controls = node("div", undefined, "toolbar");
      controls.append(button("Review & execute once", () => beginReview([view])), button("Reject revision", () => { void act(() => call("reject", { selection: selection(view) }), "Revision rejected; no action executed."); }));
      card.append(details, controls); target.append(card);
    }
  }
  updateSelected();
  const running = element("running"); running.replaceChildren();
  if (state.active) {
    const active = state.active; const card = node("article", undefined, "card");
    card.append(node("h3", active.title), node("p", `${active.status} · verification: ${active.verification_status}`));
    for (const step of active.steps ?? []) card.append(node("p", `${step.phase}/${step.id}: ${step.status}${step.error ? ` — ${step.error}` : ""}`, "meta"));
    running.append(card);
  } else running.append(node("p", "No pack is running."));
  if (state.queued.length) running.append(node("p", `Approved queue: ${state.queued.map(r => r.title).join(" → ")}`));
  const errors = element("errors"); errors.replaceChildren();
  for (const error of state.errors) errors.append(node("p", `${error.file}: ${error.message}`));
  if (state.last_error) errors.append(node("p", state.last_error));
  const history = element("history"); history.replaceChildren();
  if (!state.history.length) history.append(node("p", "No execution receipts yet."));
  for (const receipt of state.history) {
    const row = node("div", undefined, "receipt-row");
    row.append(node("span", `${receipt.title} · r${receipt.revision} · ${receipt.status} · verification: ${receipt.verification_status}`));
    row.append(button("Inspect receipt", () => { void act(async () => {
      const result = await call("detail", { id: receipt.id, revision: receipt.revision });
      element("receipt-content").textContent = JSON.stringify(result, null, 2) + `\n\nProject copy:\n.chatgpt/actions/reports/${receipt.id}/${receipt.attempt_id}/`;
      receiptDialog.showModal();
    }); }));
    history.append(row);
  }
}
element("initialize").addEventListener("click", () => { void act(() => call("initialize"), "Inbox and reusable template created in .chatgpt/actions/. Writing a ticket does not execute it."); });
element("copy-template").addEventListener("click", () => { void act(async () => { if (snapshot) await writeText(JSON.stringify(snapshot.template, null, 2)); }, "Template copied. Edit it and save under .chatgpt/actions/inbox/<id>.json."); });
element("refresh").addEventListener("click", () => { void refresh(); });
element("pause").addEventListener("click", () => { void act(() => call("pause"), "Queue paused; the current step may finish. Use Cancel to stop outstanding work."); });
element("resume").addEventListener("click", () => { void act(() => call("resume"), "Resuming the already-approved batch. New packs still require review."); });
element("cancel").addEventListener("click", () => { void act(() => call("cancel"), "Cancellation requested. Already-completed side effects are not rolled back."); });
element<HTMLInputElement>("auto-checks").addEventListener("change", event => { const enabled = (event.target as HTMLInputElement).checked; void act(() => call("auto_checks", { enabled }), enabled ? "Temporary check-only policy enabled. Scripts and executables remain manual." : "Automatic checks disabled."); });
element("approve-selected").addEventListener("click", () => beginReview(snapshot?.pending.filter(v => selected.has(v.review_digest)) ?? []));
element("approve-buffer").addEventListener("click", () => beginReview(snapshot?.pending ?? []));
element("dismiss-review").addEventListener("click", () => reviewDialog.close());
element("close-receipt").addEventListener("click", () => receiptDialog.close());
element("confirm-review").addEventListener("click", () => { void act(async () => {
  await call("approve", { selections: reviewing.map(selection) }); selected.clear(); reviewDialog.close();
}, "The reviewed packs were approved. Progress and verification will appear below."); });
void refresh();
window.setInterval(() => { void refresh(); }, 2000);
