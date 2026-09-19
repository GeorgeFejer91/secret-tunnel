import { invoke } from '@tauri-apps/api/core';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';

type Root = { repo_id: string; display_name: string; root: string };
type Device = { id: string; label?: string; mode: string; expiresAt: number | null; online?: boolean };
type NetworkStatus = { roots: Root[]; peers: Device[]; invitations: Device[]; upstream: { origin: string; expiresAt: number | null; problem: string | null } | null };
const element = <T extends HTMLElement>(id: string): T => {
  const value = document.getElementById(id); if (!value) throw new Error(`Missing Network control: ${id}`); return value as T;
};
export function wireNetwork(fit: () => void): void {
  const panel = element<HTMLElement>('panel-network');
  const mode = element<HTMLFieldSetElement>('network-mode');
  // One three-way choice, so one source of truth: whichever radio is checked.
  // There is no second copy of the selection to keep in step with it.
  const choices = [...mode.querySelectorAll<HTMLInputElement>('input[name="network-purpose"]')];
  const selectedMode = (): string => choices.find(choice => choice.checked)?.value ?? choices[0]!.value;
  const message = element<HTMLElement>('network-message');
  const roots = element<HTMLSelectElement>('network-roots');
  const devices = element<HTMLSelectElement>('network-devices');
  const outgoing = element<HTMLInputElement>('network-outgoing');
  const incoming = element<HTMLInputElement>('network-incoming');
  const name = element<HTMLInputElement>('network-name');
  const filePassword = element<HTMLInputElement>('network-file-password');
  const short = element<HTMLInputElement>('network-short');
  const fileMode = element<HTMLInputElement>('network-file-mode');
  const passwordOrThrow = (): string => {
    const password = filePassword.value;
    // The file's whole strength is this string, so the floor is enforced here
    // rather than left to whoever is in a hurry.
    if (password.length < 8) throw new Error('Choose a file password of at least 8 characters.');
    return password;
  };
  let expiry = 0; let busy = false;
  const request = <T>(action: string, input: unknown = {}): Promise<T> => invoke<T>('network_request', { action, input });
  function note(text: string) { message.textContent = text; message.title = text; fit(); }
  function showMode() {
    const purpose = selectedMode();
    const profile = purpose === 'profile';
    element<HTMLElement>('network-grants').hidden = profile;
    element<HTMLElement>('network-profile-options').hidden = !profile;
    element<HTMLElement>('network-mode-note').textContent = profile
      ? 'Copies portable settings, not shared-URL failover. Local folders and tunnel identity stay separate.'
      : purpose === 'temporary' ? 'The invited PC shares selected folders for 24 hours after joining. This gateway must stay on.'
      : 'The invited PC shares selected folders until revoked. This gateway must stay on.';
    outgoing.value = ''; fit();
  }
  /// One switch decides how an invitation travels, and the controls of the
  /// other way are removed rather than left on screen to be wondered about.
  /// Both halves of the exchange move together: a file is saved on one PC and
  /// opened on the other, so a password field that belongs to neither half
  /// alone sits above both areas.
  function showShareMethod() {
    const asFile = fileMode.checked;
    element<HTMLElement>('network-short-row').hidden = asFile;
    filePassword.hidden = !asFile;
    element<HTMLElement>('network-copy-link').hidden = asFile;
    element<HTMLElement>('network-save-file').hidden = !asFile;
    element<HTMLElement>('network-open-file').hidden = !asFile;
    // In file mode the box is filled by Open file, never typed into, so it
    // says where its contents come from instead of inviting a paste.
    incoming.readOnly = asFile;
    incoming.placeholder = asFile ? 'Open a file to fill this' : 'Paste the invitation here';
    fit();
  }
  async function refresh() {
    if (busy || panel.hidden) return;
    try {
      const status = await request<NetworkStatus>('status');
      const selected = new Set([...roots.selectedOptions].map(option => option.value));
      roots.replaceChildren(...status.roots.map(root => {
        const option = new Option(root.display_name, root.repo_id, false, selected.has(root.repo_id)); option.title = root.root; return option;
      }));
      const current = devices.value;
      const entries = [...status.peers, ...status.invitations];
      devices.replaceChildren(...entries.map(device => {
        const state = device.expiresAt !== null && device.expiresAt <= Date.now() ? 'expired' : device.online === undefined ? 'invitation' : device.online ? 'online' : 'offline';
        return new Option(`${device.label ?? device.mode} — ${state}`, device.id, false, current === device.id);
      }));
      if (!entries.length) devices.add(new Option('No devices or pending invitations', ''));
      if (expiry && Date.now() >= expiry) { outgoing.value = ''; expiry = 0; }
      if (status.upstream) note(status.upstream.problem ? `Gateway: ${status.upstream.problem}` : `Joined ${status.upstream.origin}`);
      fit();
    } catch (error) { note(errorText(error)); }
  }
  async function act(work: () => Promise<void>) {
    if (busy) return; busy = true;
    const buttons = [...panel.querySelectorAll<HTMLButtonElement>('button')]; buttons.forEach(button => button.disabled = true);
    // The purpose is locked for the duration too: an in-flight invitation or
    // join must not be relabelled as another mode while it is running.
    mode.disabled = true;
    try { await work(); } catch (error) { note(errorText(error)); }
    finally { busy = false; mode.disabled = false; buttons.forEach(button => button.disabled = false); await refresh(); }
  }
  element<HTMLButtonElement>('network-create').addEventListener('click', () => { void act(async () => {
    // The short form is a property of the code, so asking for it while sharing
    // by file is not a state the panel offers - and the hidden switch keeps
    // whatever it was last set to, which is why this reads the method too.
    const wantShort = !fileMode.checked && short.checked;
    const result = await request<{ link: string; code: string; short: string | null; expiresAt: number }>('create', { mode: selectedMode(), short: wantShort, includeGitHub: element<HTMLInputElement>('network-include-github').checked });
    // One box, one form in it. The stn1 encoding is the same capability as the
    // link in different clothes, so it is no longer offered as a second thing
    // to copy; a code produced elsewhere still pastes into the box below.
    outgoing.value = wantShort && result.short ? result.short : result.link;
    expiry = result.expiresAt;
    note(wantShort
      ? 'One-use short invitation created. Redeem within 5 minutes. Treat it as a password.'
      : 'One-use invitation created. Redeem within 15 minutes. Treat it as a password.');
  }); });
  element<HTMLButtonElement>('network-copy-link').addEventListener('click', () => { void act(async () => { if (!outgoing.value) throw new Error('Create an invitation first.'); await writeText(outgoing.value); note('Invitation copied.'); }); });
  element<HTMLButtonElement>('network-join').addEventListener('click', () => { void act(async () => {
    if (selectedMode() === 'profile') {
      const result = await request<{ message: string }>('receive_profile', { invitation: incoming.value.trim(), confirm: element<HTMLInputElement>('network-confirm-import').checked });
      note(result.message);
    } else {
      const chosen = [...roots.selectedOptions].map(option => option.value);
      if (!chosen.length) throw new Error('Choose folders in the Folders tab, then select those to share here.');
      await request('join', { invitation: incoming.value.trim(), label: name.value.trim() || 'Joined PC', grant: { roots: chosen, writable: element<HTMLInputElement>('network-write').checked } });
      note('Joined. The gateway’s connected AI clients can access only the selected folders.');
    }
    incoming.value = '';
  }); });
  element<HTMLButtonElement>('network-save-file').addEventListener('click', () => { void act(async () => {
    if (!outgoing.value) throw new Error('Create an invitation first.');
    const password = passwordOrThrow();
    const file = await sealInvitation(outgoing.value, password);
    const saved = await request<{ saved: boolean }>('save_file', { contents: file });
    note(saved.saved
      ? 'Invitation file saved. Send the password by a different route; the file alone grants nothing.'
      : 'Save cancelled.');
  }); });
  element<HTMLButtonElement>('network-open-file').addEventListener('click', () => { void act(async () => {
    const password = passwordOrThrow();
    const opened = await request<{ contents: string | null }>('open_file');
    if (opened.contents === null) { note('Open cancelled.'); return; }
    // Filling the box is the whole effect. Joining stays behind Receive / join,
    // so a wrong file or a mistyped password costs nothing but a message.
    incoming.value = await openInvitation(opened.contents, password);
    note('Invitation file opened. Check the purpose and folders, then Receive / join.');
  }); });
  element<HTMLButtonElement>('network-revoke').addEventListener('click', () => { void act(async () => { if (devices.value) await request('revoke', { id: devices.value }); note('Device or invitation revoked.'); }); });
  element<HTMLButtonElement>('network-leave').addEventListener('click', () => { void act(async () => { await request('leave'); note('Left the gateway. Local files were not deleted.'); }); });
  mode.addEventListener('change', showMode);
  // Changing the form does not create anything; it clears the stale one on
  // screen so a 15-minute invitation is never read as a 5-minute one.
  short.addEventListener('change', () => {
    outgoing.value = ''; expiry = 0;
    note(short.checked
      ? 'Short codes last 5 minutes. Create an invitation to get one.'
      : 'Full invitations last 15 minutes. Create an invitation to get one.');
  });
  // Same reasoning as the short switch: changing how an invitation would
  // travel must not leave one made the other way sitting in the box.
  fileMode.addEventListener('change', () => {
    outgoing.value = ''; expiry = 0;
    showShareMethod();
    note(fileMode.checked
      ? 'Create an invitation, then save it as a file. Send the password separately.'
      : 'Create an invitation, then copy it to the other PC.');
  });
  new MutationObserver(() => { if (!panel.hidden) void refresh(); }).observe(panel, { attributes: true, attributeFilter: ['hidden'] });
  const timer = window.setInterval(() => { void refresh(); }, 5000);
  window.addEventListener('beforeunload', () => clearInterval(timer), { once: true });
  showMode(); showShareMethod(); void refresh();
}
/* The invitation file.
 *
 * The invitation text is already a bearer credential: whoever reads it can
 * redeem it within its fifteen minutes. Handing it over as a link means the
 * channel that carries it is the only thing protecting it. Encrypting it under
 * a password the recipient is told separately splits that into two secrets, so
 * a single intercepted message is not enough.
 *
 * What it is not: the file is only as strong as the password, because a
 * password is guessable in a way a 256-bit key is not. PBKDF2 at 600k
 * iterations makes each guess expensive and the fifteen-minute redemption
 * window makes offline cracking mostly pointless, but sending the file and the
 * password down the same wire puts it back where it started. The panel says so.
 *
 * WebCrypto only - PBKDF2 and AES-GCM are both in the webview already, so this
 * needs no dependency and no round trip to the network service.
 */
const FILE_KIND = 'secret-tunnel-invitation';
const FILE_ITERATIONS = 600_000;
const bytesToBase64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}
type InvitationFile = { v: 1; type: string; kdf: 'PBKDF2-SHA256'; iterations: number; salt: string; iv: string; data: string };
/// The key for one file, derived from its own salt and iteration count.
async function fileKey(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}
/// The header is authenticated as additional data, so the salt and the
/// iteration count cannot be lowered on the way without the open failing.
const fileHeader = (file: Pick<InvitationFile, 'v' | 'type' | 'kdf' | 'iterations' | 'salt'>): Uint8Array =>
  new TextEncoder().encode(`${file.v}.${file.type}.${file.kdf}.${file.iterations}.${file.salt}`);
async function sealInvitation(invitation: string, password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const header = { v: 1 as const, type: FILE_KIND, kdf: 'PBKDF2-SHA256' as const, iterations: FILE_ITERATIONS, salt: bytesToBase64(salt) };
  const key = await fileKey(password, salt, FILE_ITERATIONS);
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource, additionalData: fileHeader(header) as BufferSource },
    key, new TextEncoder().encode(invitation),
  );
  const file: InvitationFile = { ...header, iv: bytesToBase64(iv), data: bytesToBase64(new Uint8Array(sealed)) };
  return `${JSON.stringify(file, null, 2)}
`;
}
async function openInvitation(contents: string, password: string): Promise<string> {
  let file: InvitationFile;
  try { file = JSON.parse(contents) as InvitationFile; } catch { throw new Error('That file is not a Secret Tunnel invitation.'); }
  if (file?.v !== 1 || file.type !== FILE_KIND || file.kdf !== 'PBKDF2-SHA256') throw new Error('That file is not a Secret Tunnel invitation.');
  // A file may not ask this PC to spend an unbounded time deriving its key.
  if (!Number.isInteger(file.iterations) || file.iterations < 100_000 || file.iterations > 2_000_000) throw new Error('That invitation file asks for unusable password settings.');
  const key = await fileKey(password, base64ToBytes(file.salt), file.iterations);
  try {
    const opened = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBytes(file.iv) as BufferSource, additionalData: fileHeader(file) as BufferSource },
      key, base64ToBytes(file.data) as BufferSource,
    );
    return new TextDecoder().decode(opened);
  } catch {
    // One message for a wrong password and for a damaged file: the difference
    // is not something the person can act on, and saying which is a hint.
    throw new Error('Wrong password, or the file is not intact.');
  }
}
function errorText(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) return String(error.message);
  return 'Network request failed. Check the local app and installed runtime.';
}
