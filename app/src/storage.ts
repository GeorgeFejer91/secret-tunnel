import { invoke } from '@tauri-apps/api/core';

type Root = { repoId: string; name: string; writable: boolean };
type Status = {
  configured: boolean; enabled: boolean; readWrite: boolean; effectiveWrite: boolean;
  allowTransfers: boolean; host: string; user: string; port: number; revision: string; tested: boolean;
  busy: boolean; rclonePath: string; knownHostsPath: string; keyPath: string; passwordSaved: boolean;
  credentialStorage: string; localRoots: Root[];
};
type Entry = { name: string; path: string; directory: boolean; sizeBytes: number };
type Listing = { entries: Entry[]; nextOffset: number | null; snapshot: string; totalVisible: number; omitted: number };
type TextFile = { text: string; contentComplete: boolean; sha256: string | null; bytesRead: number; sizeBytes: number };
type Receipt = { requestId: string; state: string; result?: { verified?: string }; error?: { message: string }; message?: string };

const element = <T extends HTMLElement>(id: string): T => {
  const value = document.getElementById(id); if (!value) throw new Error(`Missing Storage control: ${id}`); return value as T;
};

/// The Storage Box tab. One configured Hetzner account, reached over SFTP by the
/// desktop itself: the browser never holds a credential, and every operation is
/// a fixed request the Rust side re-authorises before it runs.
export function wireStorage(fit: () => void): void {
  const panel = element<HTMLElement>('panel-storage');
  const input = (id: string) => element<HTMLInputElement>(id);
  const button = (id: string) => element<HTMLButtonElement>(id);
  const select = (id: string) => element<HTMLSelectElement>(id);
  const dialog = (id: string) => element<HTMLDialogElement>(id);
  const call = <T>(action: string, value: Record<string, unknown> = {}) =>
    invoke<T>('storage_request', { action, input: value });

  let status: Status | null = null;
  let entries: Entry[] = [];
  let nextOffset: number | null = null;
  let snapshot = '';
  let expectedHash: string | null = null;
  let loadedPath = '';
  let readerRevision = '';
  let polling = false;

  // The shared fitter owns the tooltip and the full-text cache, so a status
  // string only has to be written; it is measured against its box afterwards.
  function text(id: string, value: string) { element(id).textContent = value; fit(); }
  function message(value: string) { text('storage-message', value); }

  // Every control reports its own failure where the operator is looking, rather
  // than rejecting into the console.
  function safely(action: () => Promise<void>, target = 'storage-message') {
    return () => {
      void action().catch(e =>
        text(target, typeof e === 'object' && e && 'message' in e ? String(e.message) : String(e)));
    };
  }

  async function refresh() {
    status = await call<Status>('status');
    text('storage-account', status.configured ? `${status.user} · ${status.host}` : 'Not configured');
    text('storage-access', status.enabled ? (status.effectiveWrite ? 'Read + write' : 'Read only') : 'Disabled');
    button('storage-test').disabled = !status.configured || status.busy;
    button('storage-enable').disabled = !status.tested || status.enabled || status.busy;
    button('storage-disable').disabled = !status.enabled && !status.busy;
    for (const id of ['storage-browse', 'storage-open', 'storage-up']) button(id).disabled = !status.enabled || status.busy;
    button('storage-more').disabled = !status.enabled || status.busy || nextOffset === null;
    button('storage-new').disabled = !status.effectiveWrite || status.busy;
    button('storage-transfer').disabled = !status.effectiveWrite || !status.allowTransfers || status.busy;
  }

  async function browse(offset = 0) {
    if (!status) return;
    const page = await call<Listing>('list', {
      revision: status.revision, path: input('storage-path').value, offset, limit: 100,
      ...(offset ? { snapshot } : {}),
    });
    entries = page.entries; nextOffset = page.nextOffset; snapshot = page.snapshot;
    select('storage-files').replaceChildren(...entries.map(entry => {
      const option = document.createElement('option');
      option.value = entry.path;
      option.textContent = `${entry.directory ? '▸ ' : ''}${entry.name}${entry.directory ? '/' : ''}`;
      option.title = entry.path;
      return option;
    }));
    button('storage-more').disabled = nextOffset === null;
    message(`${entries.length ? offset + 1 : 0}–${offset + entries.length} of ${page.totalVisible} visible entries${
      page.omitted ? `; ${page.omitted} unsupported or blocked` : ''}.`);
  }

  async function openFile() {
    if (!status) return;
    const entry = entries.find(e => e.path === select('storage-files').value);
    if (!entry) return;
    if (entry.directory) { input('storage-path').value = entry.path; await browse(); return; }
    const value = await call<TextFile>('read', { revision: status.revision, path: entry.path, maxBytes: 131072 });
    // Only a complete read carries a whole-file hash, and only that hash can be
    // used as a replacement precondition. A preview opens read-only.
    readerRevision = status.revision; loadedPath = entry.path; expectedHash = value.sha256;
    input('storage-file-path').value = entry.path; input('storage-file-path').readOnly = true;
    element<HTMLTextAreaElement>('storage-text').value = value.text;
    element<HTMLTextAreaElement>('storage-text').readOnly = !status.effectiveWrite || !value.contentComplete;
    button('storage-write-file').disabled = !status.effectiveWrite || !value.contentComplete;
    text('storage-read-info', value.contentComplete
      ? `${value.bytesRead} bytes · complete read · SHA-256 checked before replacement`
      : `Preview: ${value.bytesRead} of ${value.sizeBytes} bytes. Whole-file replacement disabled.`);
    text('storage-reader-message', '');
    dialog('storage-reader').showModal();
  }

  // A submitted write or copy is a receipt, not an outcome. The wording here is
  // deliberate: the operator is told what to check, not that it worked.
  function acceptJob(receipt: Receipt) {
    input('storage-job-id').value = receipt.requestId;
    message(`${receipt.state}: ${receipt.requestId}. Submitted is not completed.`);
  }

  async function checkJob() {
    const requestId = input('storage-job-id').value.trim();
    if (!requestId) return;
    const receipt = await call<Receipt>('job', { requestId });
    message(`${receipt.state}: ${receipt.result?.verified || receipt.error?.message || receipt.message || receipt.requestId}`);
  }

  function authMode() {
    const key = select('storage-auth').value === 'key';
    element('storage-key-row').hidden = !key;
    element('storage-password-row').hidden = key;
  }

  function configure() {
    if (!status) return;
    for (const [id, value] of [
      ['storage-host', status.host], ['storage-user', status.user], ['storage-rclone', status.rclonePath],
      ['storage-known-hosts', status.knownHostsPath], ['storage-key', status.keyPath],
    ] as const) input(id).value = value;
    select('storage-port').value = String(status.port);
    select('storage-auth').value = status.keyPath ? 'key' : 'password';
    input('storage-password').value = '';
    input('storage-write').checked = status.readWrite;
    input('storage-transfers').checked = status.allowTransfers;
    text('storage-credential-kind', status.credentialStorage === 'windows_dpapi'
      ? 'Credentials: Windows user-scoped DPAPI.'
      : 'Credentials: permission-restricted file, not OS-encrypted. Prefer a protected private-key file.');
    text('storage-settings-message', '');
    authMode();
    dialog('storage-settings').showModal();
  }

  for (const closer of document.querySelectorAll<HTMLButtonElement>('[data-storage-close]')) {
    closer.addEventListener('click', () => closer.closest('dialog')?.close());
  }
  // The typed password never outlives the sheet it was typed into.
  dialog('storage-settings').addEventListener('close', () => { input('storage-password').value = ''; });
  button('storage-configure').addEventListener('click', configure);
  select('storage-auth').addEventListener('change', authMode);

  for (const picker of document.querySelectorAll<HTMLButtonElement>('[data-storage-pick]')) {
    picker.addEventListener('click', safely(async () => {
      const value = await call<string | null>('pick');
      if (value) input(picker.dataset.storagePick!).value = value;
    }, 'storage-settings-message'));
  }

  element<HTMLFormElement>('storage-settings-form').addEventListener('submit', event => {
    event.preventDefault();
    safely(async () => {
      const key = select('storage-auth').value === 'key';
      await call('save', {
        host: input('storage-host').value.trim().toLowerCase(),
        user: input('storage-user').value.trim(),
        port: Number(select('storage-port').value),
        rclonePath: input('storage-rclone').value.trim(),
        knownHostsPath: input('storage-known-hosts').value.trim(),
        keyPath: key ? input('storage-key').value.trim() : '',
        password: key ? '' : input('storage-password').value,
        readWrite: input('storage-write').checked,
        allowTransfers: input('storage-transfers').checked,
      });
      dialog('storage-settings').close();
      await refresh();
      message('Saved and disabled. Test the connection, then enable access.');
    }, 'storage-settings-message')();
  });

  for (const action of ['test', 'enable', 'disable'] as const) {
    button(`storage-${action}`).addEventListener('click', safely(async () => {
      message(action === 'test' ? 'Testing SSH identity, authentication and reading…' : 'Updating access…');
      await call(action);
      await refresh();
      message(action === 'test' ? 'Read-only connection test passed; no files changed.'
        : action === 'enable' ? 'Storage tools enabled for this account.'
        : 'Access revoked. Inspect any interrupted operation receipt.');
    }));
  }

  button('storage-browse').addEventListener('click', safely(() => browse()));
  button('storage-more').addEventListener('click', safely(() => browse(nextOffset ?? 0)));
  button('storage-up').addEventListener('click', safely(async () => {
    input('storage-path').value = input('storage-path').value.split('/').slice(0, -1).join('/');
    await browse();
  }));
  button('storage-open').addEventListener('click', safely(openFile));
  select('storage-files').addEventListener('dblclick', safely(openFile));

  button('storage-new').addEventListener('click', () => {
    if (!status) return;
    readerRevision = status.revision; loadedPath = ''; expectedHash = null;
    input('storage-file-path').value = input('storage-path').value ? `${input('storage-path').value}/` : '';
    input('storage-file-path').readOnly = false;
    element<HTMLTextAreaElement>('storage-text').value = '';
    element<HTMLTextAreaElement>('storage-text').readOnly = false;
    button('storage-write-file').disabled = !status.effectiveWrite;
    text('storage-read-info', 'Create-only: existing destinations are refused.');
    text('storage-reader-message', '');
    dialog('storage-reader').showModal();
  });

  button('storage-write-file').addEventListener('click', safely(async () => {
    const receipt = await call<Receipt>('write', {
      revision: readerRevision,
      path: loadedPath || input('storage-file-path').value,
      content: element<HTMLTextAreaElement>('storage-text').value,
      expectedSha256: expectedHash,
      requestId: crypto.randomUUID(),
    });
    acceptJob(receipt); dialog('storage-reader').close(); await refresh();
  }, 'storage-reader-message'));

  button('storage-transfer').addEventListener('click', () => {
    select('storage-local-root').replaceChildren(...(status?.localRoots ?? []).map(root => {
      const option = document.createElement('option');
      option.value = root.repoId; option.textContent = root.name || root.repoId;
      return option;
    }));
    input('storage-remote-path').value = select('storage-files').value || '';
    text('storage-copy-message', '');
    dialog('storage-copy').showModal();
  });

  element<HTMLFormElement>('storage-copy-form').addEventListener('submit', event => {
    event.preventDefault();
    safely(async () => {
      const receipt = await call<Receipt>('copy', {
        revision: status?.revision,
        direction: select('storage-direction').value,
        repoId: select('storage-local-root').value,
        localPath: input('storage-local-path').value,
        remotePath: input('storage-remote-path').value,
        requestId: crypto.randomUUID(),
      });
      acceptJob(receipt); dialog('storage-copy').close(); await refresh();
    }, 'storage-copy-message')();
  });

  button('storage-job-refresh').addEventListener('click', safely(checkJob));

  // A hidden panel has no box, so its strings are refitted the moment it opens,
  // and the status only polls while it is the sheet on top.
  new ResizeObserver(fit).observe(panel);
  new MutationObserver(() => { if (!panel.hidden) safely(refresh)(); })
    .observe(panel, { attributes: true, attributeFilter: ['hidden'] });
  setInterval(() => {
    if (panel.hidden || polling) return;
    polling = true;
    void (async () => { await refresh(); if (input('storage-job-id').value) await checkJob(); })()
      .catch(e => message(String(e)))
      .finally(() => { polling = false; });
  }, 3000);

  safely(refresh)();
}
