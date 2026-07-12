import { api, pollJob } from './api.js';
import { renderTree } from './components/folder-tree.js';
import { renderMessages } from './components/message-list.js';
import { showMenu } from './components/context-menu.js';
import { confirmInBar, showProgress } from './components/confirm-bar.js';
import { showFolderPicker } from './components/folder-picker.js';

const state = {
  accounts: [],
  foldersByAccount: new Map(),
  expanded: new Set(JSON.parse(localStorage.getItem('expanded') || '[]')),
  selectedFolderId: null,
  messages: [],
  selection: new Set(),
  lastCheckedIndex: null,
  expandedBodies: new Map(), // msgId -> {mode, body, loading}
  redundant: null,           // {folderId, byId: Map(msgId -> containedInId), scanned}
  filters: { quietMonths: null, done: 'all', doneBefore: null },
  inlineAdd: null,           // {accountId, parentPath}
  inlineRename: null,        // folderId
  inlineRenameDraft: null,   // text typed so far (survives mid-edit redraws)
  lastMoveTarget: null,      // folder row
};

const $ = (id) => document.getElementById(id);

/* ---------- toasts ---------- */
function toast(message, type = 'error') {
  const div = document.createElement('div');
  div.className = 'toast' + (type === 'info' ? ' info' : '');
  div.textContent = message;
  div.addEventListener('click', () => div.remove());
  $('toasts').appendChild(div);
  setTimeout(() => div.remove(), type === 'info' ? 4000 : 12000);
}

async function guard(fn) {
  try { return await fn(); }
  catch (err) { toast(err.message); }
}

/* ---------- data loading ---------- */
function getFolderById(id) {
  for (const folders of state.foldersByAccount.values()) {
    const f = folders.find((x) => x.id === id);
    if (f) return f;
  }
  return null;
}

async function reloadFolders(accountId) {
  state.foldersByAccount.set(accountId, await api.folders(accountId));
}

async function reloadAllFolders() {
  await Promise.all(state.accounts.map((a) => reloadFolders(a.id)));
}

async function loadEverything() {
  state.accounts = await api.accounts();
  await reloadAllFolders();
  // First run for an account: populate its folder list from the server.
  for (const account of state.accounts) {
    if (!(state.foldersByAccount.get(account.id) ?? []).length) {
      await guard(async () => {
        state.foldersByAccount.set(account.id, await api.syncAccount(account.id));
      });
    }
  }
  redrawTree();
}

/* ---------- rendering ---------- */
function redrawTree() {
  renderTree($('sidebar'), state, treeHandlers);
}

function redrawMessages() {
  const folder = getFolderById(state.selectedFolderId);
  $('folder-header').hidden = !folder;
  if (folder) {
    $('folder-title').textContent = folder.path.replaceAll(folder.delimiter || '/', ' / ');
    const synced = folder.last_synced_at ? `synced ${folder.last_synced_at.slice(0, 16)}Z` : 'never synced';
    $('folder-meta').textContent = `${folder.msg_count ?? '?'} messages · ${synced}`;
  }
  renderMessages($('message-pane'), state, messageHandlers);
  redrawBatchBar();
}

function redrawBatchBar() {
  const bar = $('batch-bar');
  if (bar.classList.contains('confirming')) return;
  const n = state.selection.size;
  const red = state.redundant?.folderId === state.selectedFolderId && state.redundant.byId.size
    ? state.redundant : null;
  bar.innerHTML = '';
  if (!n && !red) { bar.hidden = true; return; }
  bar.hidden = false;

  if (n) {
    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = `${n} selected`;

    const move = document.createElement('button');
    move.textContent = 'Move to…';
    move.addEventListener('click', () => pickMoveTarget([...state.selection]));

    bar.append(count, move);

    if (state.lastMoveTarget && getFolderById(state.lastMoveTarget.id)) {
      const again = document.createElement('button');
      again.textContent = `Move to ${state.lastMoveTarget.name}`;
      again.addEventListener('click', () => moveMessages([...state.selection], state.lastMoveTarget));
      bar.appendChild(again);
    }

    const del = document.createElement('button');
    del.className = 'danger';
    del.textContent = 'Delete';
    del.addEventListener('click', () => deleteMessages([...state.selection]));

    const clear = document.createElement('button');
    clear.textContent = 'Clear';
    clear.addEventListener('click', () => { state.selection.clear(); redrawMessages(); });

    bar.append(del, clear);
  }

  if (red) {
    const loaded = state.messages.filter((m) => red.byId.has(m.id));
    const select = document.createElement('button');
    select.textContent = `Select ${loaded.length} redundant`;
    select.addEventListener('click', () => {
      for (const m of loaded) state.selection.add(m.id);
      // Never queue messages the user can't see for deletion.
      const unloaded = red.byId.size - loaded.length;
      if (unloaded > 0) toast(`${unloaded} redundant message${unloaded > 1 ? 's are' : ' is'} beyond the ${state.messages.length} loaded rows and stayed unselected`, 'info');
      redrawMessages();
    });

    const dismiss = document.createElement('button');
    dismiss.textContent = 'Dismiss';
    dismiss.addEventListener('click', () => { state.redundant = null; redrawMessages(); });

    bar.append(select, dismiss);
  }
}

/* ---------- folder selection & sync ---------- */
async function selectFolder(folder, { forceSync = false } = {}) {
  state.selectedFolderId = folder.id;
  state.selection.clear();
  state.expandedBodies.clear();
  state.lastCheckedIndex = null;
  state.messages = [];
  if (state.redundant && state.redundant.folderId !== folder.id) state.redundant = null;
  redrawTree();
  redrawMessages();
  await guard(async () => {
    if (forceSync || !folder.last_synced_at) {
      $('folder-meta').textContent = 'syncing…';
      await api.syncFolder(folder.id);
      await reloadFolders(folder.account_id);
    }
    const { messages } = await api.messages(folder.id);
    state.messages = messages;
    redrawTree();
    redrawMessages();
  });
}

function goToFolder(folder) {
  // Expand every ancestor so the folder is visible in the tree.
  const delim = folder.delimiter || '/';
  const parts = folder.path.split(delim);
  let path = null;
  for (const part of parts.slice(0, -1)) {
    path = path ? path + delim + part : part;
    state.expanded.add(`${folder.account_id}:${path}`);
  }
  localStorage.setItem('expanded', JSON.stringify([...state.expanded]));
  selectFolder(folder); // redraws the tree synchronously before its first await
  document.querySelector('.folder-row.selected')?.scrollIntoView({ block: 'nearest' });
}

async function afterMutation(accountIds) {
  await Promise.all([...new Set(accountIds)].map(reloadFolders));
  if (state.selectedFolderId) {
    const folder = getFolderById(state.selectedFolderId);
    if (folder) {
      const { messages } = await api.messages(folder.id);
      state.messages = messages;
      for (const id of [...state.selection]) {
        if (!messages.some((m) => m.id === id)) state.selection.delete(id);
      }
      if (state.redundant) {
        for (const id of [...state.redundant.byId.keys()]) {
          if (!messages.some((m) => m.id === id)) state.redundant.byId.delete(id);
        }
        if (!state.redundant.byId.size) state.redundant = null;
      }
    } else {
      state.selectedFolderId = null;
      state.messages = [];
      state.selection.clear();
      state.redundant = null;
    }
  }
  redrawTree();
  redrawMessages();
}

async function runJob(startPromise, progressLabel, accountIds) {
  await guard(async () => {
    const { jobId } = await startPromise;
    const job = await pollJob(jobId, (j) => {
      showProgress(`${progressLabel} ${j.done}/${j.total || '?'}…`);
    });
    if (job.errors.length) toast(job.errors.join('\n'));
    else toast(`${progressLabel} done`, 'info');
  });
  $('batch-bar').hidden = true;
  await afterMutation(accountIds);
}

/* ---------- redundant-message scan ---------- */
// Read-only job (unlike runJob's users): nothing to re-sync, but we need
// job.result. Marks land in state.redundant; deletion stays with the
// normal reviewed selection -> Delete flow.
async function scanRedundant(folder) {
  await guard(async () => {
    const { jobId } = await api.scanRedundant(folder.id);
    const job = await pollJob(jobId, (j) => showProgress(`Scanning bodies ${j.done}/${j.total || '?'}…`));
    $('batch-bar').hidden = true;
    if (job.errors.length) toast(job.errors.join('\n'));
    if (!job.result) return;
    state.redundant = {
      folderId: folder.id,
      byId: new Map(job.result.redundant.map((r) => [r.id, r.containedIn])),
      scanned: job.result.scanned,
    };
    if (state.selectedFolderId === folder.id) {
      // The scan re-synced the folder; reload so marks line up with fresh rows.
      const { messages } = await api.messages(folder.id);
      state.messages = messages;
      await reloadFolders(folder.account_id);
      redrawTree();
      redrawMessages();
    } else {
      goToFolder(getFolderById(folder.id) ?? folder);
    }
    const n = state.redundant.byId.size;
    toast(`${n} redundant message${n === 1 ? '' : 's'} of ${job.result.scanned} in "${folder.name}"`, 'info');
  });
}

/* ---------- move/delete actions (batch bar and per-message menu) ---------- */
function messagesLabel(ids) {
  return `${ids.length} message${ids.length > 1 ? 's' : ''}`;
}

async function deleteMessages(ids, label = messagesLabel(ids)) {
  const folder = getFolderById(state.selectedFolderId);
  const ok = await confirmInBar(`Delete ${label} from "${folder?.name}"?`, 'Delete');
  if (!ok) return;
  await runJob(api.deleteMessages(ids), 'Deleting', [folder.account_id]);
}

function pickMoveTarget(ids, label, opts) {
  showFolderPicker(
    {
      accounts: state.accounts,
      foldersByAccount: state.foldersByAccount,
      excludeFolderId: state.selectedFolderId,
      preferredAccountId: getFolderById(state.selectedFolderId)?.account_id,
    },
    (target) => moveMessages(ids, target, label, opts)
  );
}

async function moveMessages(ids, target, label = messagesLabel(ids), { confirm = true } = {}) {
  const source = getFolderById(state.selectedFolderId);
  if (confirm) {
    const cross = source && source.account_id !== target.account_id;
    const targetLabel = cross
      ? `${state.accounts.find((a) => a.id === target.account_id)?.name} / ${target.path}`
      : target.path;
    const ok = await confirmInBar(`Move ${label} to "${targetLabel}"?`, 'Move');
    if (!ok) return;
  }
  state.lastMoveTarget = target;
  await runJob(api.moveMessages(ids, target.id), 'Moving', [source.account_id, target.account_id]);
}

/* ---------- tree handlers ---------- */
const treeHandlers = {
  onSelect: (folder) => selectFolder(folder),
  onToggle: (key) => {
    if (state.expanded.has(key)) state.expanded.delete(key);
    else state.expanded.add(key);
    localStorage.setItem('expanded', JSON.stringify([...state.expanded]));
    redrawTree();
  },
  onFolderMenu: (folder, x, y) => {
    const account = state.accounts.find((a) => a.id === folder.account_id);
    const folders = state.foldersByAccount.get(folder.account_id) ?? [];
    const delim = folder.delimiter || '/';
    const subtree = folders.filter((f) => f.path.startsWith(folder.path + delim));
    const items = [];

    if (!folder.no_inferiors) {
      items.push({ label: 'Add subfolder', action: () => {
        state.inlineAdd = { accountId: folder.account_id, parentPath: folder.path };
        state.expanded.add(`${folder.account_id}:${folder.path}`);
        redrawTree();
      } });
    }
    if (!folder.special_use && folder.path.toUpperCase() !== 'INBOX') {
      items.push({ label: 'Rename', action: () => {
        state.inlineRename = folder.id;
        state.inlineRenameDraft = null;
        redrawTree();
      } });
    }
    if (folder.selectable) {
      items.push({ label: 'Sync folder', action: () => guard(async () => {
        await api.syncFolder(folder.id);
        await reloadFolders(folder.account_id);
        redrawTree();
        if (folder.id === state.selectedFolderId) selectFolder(getFolderById(folder.id));
      }) });
      items.push({ label: 'Find redundant messages', action: () => scanRedundant(folder) });
      items.push({ label: folder.done_at ? 'Clear done mark' : 'Mark done', action: () => guard(async () => {
        await api.setDone(folder.id, !folder.done_at);
        await reloadFolders(folder.account_id);
        redrawTree();
      }) });
    }
    if (subtree.length) {
      items.push('-');
      items.push({ label: `Flatten ${subtree.length} subfolder${subtree.length > 1 ? 's' : ''} into this`, action: async () => {
        const msgs = subtree.reduce((sum, f) => sum + (f.msg_count ?? 0), 0);
        const ok = await confirmInBar(
          `Move ~${msgs} messages from ${subtree.length} subfolder${subtree.length > 1 ? 's' : ''} into "${folder.name}", then delete them?`,
          'Flatten');
        if (!ok) return;
        await runJob(api.flatten(folder.id), 'Flattening', [folder.account_id]);
      } });
    }
    items.push('-');
    items.push({ label: 'Delete folder', danger: true, action: async () => {
      if (subtree.length) return toast(`"${folder.name}" has subfolders — flatten or delete them first`);
      const n = folder.msg_count ?? 0;
      const ok = await confirmInBar(
        n > 0 ? `Delete "${folder.name}" and its ${n} messages?` : `Delete empty folder "${folder.name}"?`,
        'Delete');
      if (!ok) return;
      await guard(() => api.deleteFolder(folder.id, n > 0));
      if (state.selectedFolderId === folder.id) state.selectedFolderId = null;
      await afterMutation([folder.account_id]);
    } });

    showMenu(x, y, items);
    void account;
  },
  onAccountMenu: (account, x, y) => {
    showMenu(x, y, [
      { label: 'Add top-level folder', action: () => {
        state.inlineAdd = { accountId: account.id, parentPath: null };
        redrawTree();
      } },
      { label: 'Sync account (folder list)', action: () => guard(async () => {
        state.foldersByAccount.set(account.id, await api.syncAccount(account.id));
        redrawTree();
        toast(`${account.name}: folder list synced`, 'info');
      }) },
      '-',
      { label: 'Edit account', action: () => openAccountDialog(account) },
      { label: 'Remove account', danger: true, action: async () => {
        const ok = await confirmInBar(`Remove account "${account.name}"? (local only — nothing is deleted on the server)`, 'Remove');
        if (!ok) return;
        await guard(() => api.deleteAccount(account.id));
        await loadEverything();
      } },
    ]);
  },
  onInlineRenameDraft: (value) => { state.inlineRenameDraft = value; },
  onInlineRenameFinish: (result) => {
    state.inlineRename = null;
    state.inlineRenameDraft = null;
    redrawTree();
    if (!result) return;
    guard(async () => {
      const renamed = await api.renameFolder(result.folder.id, result.name);
      // Rewrite expansion keys under the old path so the subtree stays open.
      const delim = renamed.delimiter || '/';
      const oldKey = `${renamed.account_id}:${result.folder.path}`;
      const newKey = `${renamed.account_id}:${renamed.path}`;
      for (const key of [...state.expanded]) {
        if (key === oldKey || key.startsWith(oldKey + delim)) {
          state.expanded.delete(key);
          state.expanded.add(newKey + key.slice(oldKey.length));
        }
      }
      localStorage.setItem('expanded', JSON.stringify([...state.expanded]));
      await reloadFolders(renamed.account_id);
      redrawTree();
      redrawMessages(); // folder header shows the path
    });
  },
  onInlineAddFinish: (result) => {
    state.inlineAdd = null;
    redrawTree();
    if (!result) return;
    guard(async () => {
      await api.createFolder(result);
      await reloadFolders(result.accountId);
      redrawTree();
    });
  },
};

/* ---------- message handlers ---------- */
async function loadBody(msg, mode) {
  state.expandedBodies.set(msg.id, { loading: true, mode });
  redrawMessages();
  await guard(async () => {
    const body = await api.body(msg.id, mode);
    state.expandedBodies.set(msg.id, { mode, body });
  });
  if (state.expandedBodies.get(msg.id)?.loading) state.expandedBodies.delete(msg.id);
  redrawMessages();
}

const messageHandlers = {
  onCheck: (msg, index, shiftKey) => {
    const nowChecked = !state.selection.has(msg.id);
    if (shiftKey && state.lastCheckedIndex != null) {
      const [lo, hi] = [Math.min(state.lastCheckedIndex, index), Math.max(state.lastCheckedIndex, index)];
      for (let i = lo; i <= hi; i++) {
        const m = state.messages[i];
        if (nowChecked) state.selection.add(m.id);
        else state.selection.delete(m.id);
      }
    } else if (nowChecked) {
      state.selection.add(msg.id);
    } else {
      state.selection.delete(msg.id);
    }
    state.lastCheckedIndex = index;
    redrawMessages();
  },
  onCheckAll: (checked) => {
    if (checked) for (const m of state.messages) state.selection.add(m.id);
    else state.selection.clear();
    redrawMessages();
  },
  onRowClick: (msg) => {
    if (state.expandedBodies.has(msg.id)) {
      state.expandedBodies.delete(msg.id);
      redrawMessages();
    } else {
      loadBody(msg, 'preview');
    }
  },
  onRowDblClick: (msg) => {
    const current = state.expandedBodies.get(msg.id);
    if (current?.mode === 'full' && !current.loading) {
      state.expandedBodies.delete(msg.id);
      redrawMessages();
    } else {
      loadBody(msg, 'full');
    }
  },
  onRowMenu: (msg, x, y) => {
    const ids = [msg.id];
    const subject = msg.subject || '(no subject)';
    const label = `"${subject.length > 60 ? subject.slice(0, 59) + '…' : subject}"`;
    const items = [
      { label: 'Open full message', action: () => window.open(`/api/messages/${msg.id}/view`, '_blank') },
      { label: 'Show source', action: () => window.open(`/api/messages/${msg.id}/source`, '_blank') },
      '-',
      { label: 'Move to…', action: () => pickMoveTarget(ids, label, { confirm: false }) },
    ];
    if (state.lastMoveTarget && getFolderById(state.lastMoveTarget.id)) {
      items.push({ label: `Move to ${state.lastMoveTarget.name}`, action: () => moveMessages(ids, state.lastMoveTarget, label, { confirm: false }) });
    }
    items.push('-', { label: 'Delete', danger: true, action: () => deleteMessages(ids, label) });
    showMenu(x, y, items);
  },
};

/* ---------- account dialog ---------- */
function openAccountDialog(account = null) {
  const dialog = $('account-dialog');
  const form = $('account-form');
  form.reset();
  $('account-dialog-title').textContent = account ? `Edit ${account.name}` : 'Add account';
  $('account-test-result').textContent = '';
  form.dataset.accountId = account?.id ?? '';
  if (account) {
    form.name.value = account.name;
    form.host.value = account.host;
    form.port.value = account.port;
    form.secure.checked = !!account.secure;
    form.username.value = account.username;
    form.allowUntrustedCert.checked = !!account.allow_untrusted_cert;
    form.password.required = false;
  } else {
    form.port.value = 993;
    form.password.required = true;
  }
  dialog.showModal();
}

function accountFormBody(form) {
  return {
    name: form.name.value.trim(),
    host: form.host.value.trim(),
    port: Number(form.port.value) || 993,
    secure: form.secure.checked,
    username: form.username.value.trim(),
    password: form.password.value,
    allowUntrustedCert: form.allowUntrustedCert.checked,
  };
}

function wireAccountDialog() {
  const dialog = $('account-dialog');
  const form = $('account-form');

  $('btn-cancel-account').addEventListener('click', () => dialog.close());

  $('btn-test-account').addEventListener('click', () => guard(async () => {
    const el = $('account-test-result');
    el.textContent = 'testing…';
    el.className = '';
    const body = accountFormBody(form);
    if (form.dataset.accountId) body.id = Number(form.dataset.accountId);
    const result = await api.testAccount(body);
    el.textContent = result.ok ? 'Connected ✓' : result.error;
    el.className = result.ok ? 'ok' : 'err';
  }));

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    guard(async () => {
      const body = accountFormBody(form);
      const id = form.dataset.accountId;
      if (id) {
        await api.updateAccount(Number(id), body);
      } else {
        const created = await api.createAccount(body);
        state.foldersByAccount.set(created.id, await api.syncAccount(created.id));
      }
      dialog.close();
      await loadEverything();
    });
  });
}

/* ---------- top bar ---------- */
function wireTopbar() {
  $('btn-add-account').addEventListener('click', () => openAccountDialog());

  $('btn-goto').addEventListener('click', () => {
    showFolderPicker(
      {
        accounts: state.accounts,
        foldersByAccount: state.foldersByAccount,
        preferredAccountId: getFolderById(state.selectedFolderId)?.account_id,
      },
      (folder) => goToFolder(folder)
    );
  });

  $('btn-sync-all').addEventListener('click', () => guard(async () => {
    for (const account of state.accounts) {
      state.foldersByAccount.set(account.id, await api.syncAccount(account.id));
    }
    redrawTree();
    toast('All folder lists synced', 'info');
  }));

  $('btn-refresh-folder').addEventListener('click', () => {
    const folder = getFolderById(state.selectedFolderId);
    if (folder) selectFolder(folder, { forceSync: true });
  });

  const applyFilters = () => {
    state.filters.quietMonths = $('filter-quiet').checked ? Number($('filter-months').value) || 6 : null;
    state.filters.done = $('filter-done').value;
    $('filter-done-date').hidden = state.filters.done !== 'donebefore';
    state.filters.doneBefore = $('filter-done-date').value || null;
    redrawTree();
  };
  for (const id of ['filter-quiet', 'filter-months', 'filter-done', 'filter-done-date']) {
    $(id).addEventListener('change', applyFilters);
  }
}

/* ---------- boot ---------- */
wireTopbar();
wireAccountDialog();
guard(loadEverything).then(() => {
  if (!state.accounts.length) openAccountDialog();
});
