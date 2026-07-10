// Popover listing every folder across all accounts with type-ahead filtering.
// Used for "Move to…" — picking a folder under another account is how
// cross-account moves happen.
let pickerEl = null;

export function showFolderPicker({ accounts, foldersByAccount, excludeFolderId }, onPick) {
  hideFolderPicker();

  const entries = [];
  for (const account of accounts) {
    for (const f of foldersByAccount.get(account.id) ?? []) {
      if (!f.selectable || f.id === excludeFolderId) continue;
      entries.push({ folder: f, account, label: f.path.replaceAll(f.delimiter || '/', ' / ') });
    }
  }

  pickerEl = document.createElement('div');
  pickerEl.id = 'folder-picker';
  const input = document.createElement('input');
  input.placeholder = 'Type to filter folders…';
  const list = document.createElement('div');
  list.className = 'list';
  pickerEl.append(input, list);
  document.body.appendChild(pickerEl);

  // Centered near the top so it works from both the batch bar and context menu.
  pickerEl.style.left = (window.innerWidth - 340) / 2 + 'px';
  pickerEl.style.top = '90px';

  let active = 0;
  let shown = entries;

  const render = () => {
    list.innerHTML = '';
    shown.forEach((entry, i) => {
      const div = document.createElement('div');
      div.className = 'pick' + (i === active ? ' active' : '');
      const acct = document.createElement('span');
      acct.className = 'acct';
      acct.textContent = entry.account.name + ' / ';
      div.append(acct, document.createTextNode(entry.label));
      div.addEventListener('click', () => { hideFolderPicker(); onPick(entry.folder); });
      list.appendChild(div);
    });
    list.children[active]?.scrollIntoView({ block: 'nearest' });
  };

  input.addEventListener('input', () => {
    const q = input.value.toLowerCase();
    shown = entries.filter((e) => (e.account.name + ' ' + e.label).toLowerCase().includes(q));
    active = 0;
    render();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { active = Math.min(active + 1, shown.length - 1); render(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { active = Math.max(active - 1, 0); render(); e.preventDefault(); }
    else if (e.key === 'Enter' && shown[active]) { const f = shown[active].folder; hideFolderPicker(); onPick(f); }
    else if (e.key === 'Escape') hideFolderPicker();
  });

  render();
  input.focus();
  setTimeout(() => document.addEventListener('click', onOutside), 0);
}

function onOutside(e) {
  if (pickerEl && !pickerEl.contains(e.target)) hideFolderPicker();
}

export function hideFolderPicker() {
  document.removeEventListener('click', onOutside);
  pickerEl?.remove();
  pickerEl = null;
}
