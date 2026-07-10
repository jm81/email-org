// Renders the folder tree for all accounts into #sidebar from the flat folder
// rows (nesting derived from parent_path).

function buildTree(folders) {
  const byPath = new Map(folders.map((f) => [f.path, { folder: f, children: [] }]));
  const roots = [];
  for (const node of byPath.values()) {
    const parent = node.folder.parent_path ? byPath.get(node.folder.parent_path) : null;
    (parent ? parent.children : roots).push(node);
  }
  const sort = (nodes) => {
    nodes.sort((a, b) => a.folder.name.localeCompare(b.folder.name, undefined, { sensitivity: 'base' }));
    nodes.forEach((n) => sort(n.children));
  };
  sort(roots);
  return roots;
}

function folderMatchesFilters(f, filters) {
  if (filters.quietMonths != null) {
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - filters.quietMonths);
    const hasRecent = f.last_msg_date && new Date(f.last_msg_date) >= cutoff;
    if (hasRecent) return false;
  }
  if (filters.done === 'notdone' && f.done_at) return false;
  if (filters.done === 'done' && !f.done_at) return false;
  if (filters.done === 'donebefore') {
    if (!f.done_at) return false;
    if (filters.doneBefore && f.done_at >= filters.doneBefore) return false;
  }
  return true;
}

// Visible set = matching folders plus all their ancestors.
function visiblePaths(folders, filters) {
  const active = filters.quietMonths != null || filters.done !== 'all';
  if (!active) return null;
  const byPath = new Map(folders.map((f) => [f.path, f]));
  const visible = new Set();
  for (const f of folders) {
    if (!folderMatchesFilters(f, filters)) continue;
    visible.add(f.path);
    let p = f.parent_path;
    while (p && !visible.has(p)) { visible.add(p); p = byPath.get(p)?.parent_path; }
  }
  return visible;
}

function fmtMonth(iso) {
  return iso ? iso.slice(0, 7) : null;
}

export function renderTree(container, state, handlers) {
  container.innerHTML = '';
  for (const account of state.accounts) {
    const folders = state.foldersByAccount.get(account.id) ?? [];
    const section = document.createElement('div');
    section.className = 'account';

    const header = document.createElement('div');
    header.className = 'account-header';
    header.textContent = account.name;
    const kebab = document.createElement('button');
    kebab.className = 'kebab';
    kebab.textContent = '⋮';
    header.appendChild(kebab);
    const openAccountMenu = (e) => {
      e.preventDefault(); e.stopPropagation();
      handlers.onAccountMenu(account, e.clientX, e.clientY);
    };
    kebab.addEventListener('click', openAccountMenu);
    header.addEventListener('contextmenu', openAccountMenu);
    section.appendChild(header);

    const visible = visiblePaths(folders, state.filters);
    const filterActive = visible != null;
    const ul = document.createElement('ul');
    ul.className = 'tree';
    for (const node of buildTree(folders)) {
      const li = renderNode(node, account, state, handlers, visible, filterActive);
      if (li) ul.appendChild(li);
    }
    if (state.inlineAdd && state.inlineAdd.accountId === account.id && state.inlineAdd.parentPath === null) {
      ul.appendChild(inlineAddInput(account.id, null, handlers));
    }
    section.appendChild(ul);
    container.appendChild(section);
  }
}

function renderNode(node, account, state, handlers, visible, filterActive) {
  const f = node.folder;
  if (visible && !visible.has(f.path)) return null;

  const li = document.createElement('li');
  const key = `${account.id}:${f.path}`;
  const expanded = filterActive || state.expanded.has(key);

  const row = document.createElement('div');
  row.className = 'folder-row' + (f.id === state.selectedFolderId ? ' selected' : '');
  row.dataset.folderId = f.id;

  const twisty = document.createElement('span');
  twisty.className = 'twisty';
  twisty.textContent = node.children.length ? (expanded ? '▾' : '▸') : '';
  twisty.addEventListener('click', (e) => { e.stopPropagation(); handlers.onToggle(key); });

  const name = document.createElement('span');
  name.className = 'folder-name';
  name.textContent = f.name;

  row.append(twisty, name);

  const lastMonth = fmtMonth(f.last_msg_date);
  if (lastMonth) {
    const hint = document.createElement('span');
    hint.className = 'folder-hint';
    hint.textContent = lastMonth;
    hint.title = 'Most recent message';
    row.appendChild(hint);
  }

  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = f.msg_count ?? '·';
  row.appendChild(badge);

  if (f.done_at) {
    const done = document.createElement('span');
    done.className = 'done-mark';
    done.textContent = '✓';
    done.title = `Done ${f.done_at.slice(0, 10)}`;
    row.appendChild(done);
  }

  const kebab = document.createElement('button');
  kebab.className = 'kebab';
  kebab.textContent = '⋮';
  row.appendChild(kebab);

  const openMenu = (e) => {
    e.preventDefault(); e.stopPropagation();
    handlers.onFolderMenu(f, e.clientX, e.clientY);
  };
  kebab.addEventListener('click', openMenu);
  row.addEventListener('contextmenu', openMenu);
  row.addEventListener('click', () => {
    if (f.selectable) handlers.onSelect(f);
    else handlers.onToggle(key);
  });
  row.addEventListener('dblclick', () => handlers.onToggle(key));

  li.appendChild(row);

  const showChildren = expanded && node.children.length;
  const addingHere = state.inlineAdd
    && state.inlineAdd.accountId === account.id && state.inlineAdd.parentPath === f.path;
  if (showChildren || addingHere) {
    const ul = document.createElement('ul');
    if (expanded) {
      for (const child of node.children) {
        const childLi = renderNode(child, account, state, handlers, visible, filterActive);
        if (childLi) ul.appendChild(childLi);
      }
    }
    if (addingHere) ul.appendChild(inlineAddInput(account.id, f.path, handlers));
    li.appendChild(ul);
  }
  return li;
}

function inlineAddInput(accountId, parentPath, handlers) {
  const li = document.createElement('li');
  const input = document.createElement('input');
  input.className = 'inline-input';
  input.placeholder = 'New folder name';
  let doneAlready = false;
  const finish = (commit) => {
    if (doneAlready) return;
    doneAlready = true;
    handlers.onInlineAddFinish(commit && input.value.trim() ? { accountId, parentPath, name: input.value.trim() } : null);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(false));
  li.appendChild(input);
  setTimeout(() => input.focus(), 0);
  return li;
}
