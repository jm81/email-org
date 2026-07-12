// Message table with checkbox selection (shift-click ranges) and inline body
// expansion: click a row to preview (~4 lines), double-click for full text,
// click again to collapse.

// How many messages each fetch asks for; the server defaults to the same.
export const PAGE_SIZE = 500;

// flags is a JSON array string from the cache (e.g. '["\\Seen"]'). Rows with
// no flags data are treated as read — better to under-bold than mislabel.
function isUnread(msg) {
  if (msg.flags == null) return false;
  try { return !JSON.parse(msg.flags).includes('\\Seen'); } catch { return false; }
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  return d.getFullYear() === now.getFullYear()
    ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function renderMessages(container, state, handlers) {
  container.innerHTML = '';
  if (!state.messages.length) {
    const p = document.createElement('p');
    p.className = 'placeholder';
    p.textContent = 'No messages in this folder.';
    container.appendChild(p);
    return;
  }

  const table = document.createElement('table');
  table.className = 'messages';
  table.innerHTML = `
    <colgroup><col class="c-check"><col class="c-from"><col class="c-subject"><col class="c-attach"><col class="c-date"><col class="c-to"></colgroup>
    <thead><tr>
      <th class="check"><input type="checkbox" id="check-all"></th>
      <th data-sort="from">From</th><th data-sort="subject">Subject</th><th class="attach" title="Attachments">📎</th><th data-sort="date">Date</th><th data-sort="to">To</th>
    </tr></thead>`;
  const tbody = document.createElement('tbody');

  state.messages.forEach((msg, index) => {
    const tr = document.createElement('tr');
    tr.className = 'msg' + (state.selection.has(msg.id) ? ' checked' : '');
    tr.dataset.id = msg.id;
    if (isUnread(msg)) tr.classList.add('unread');

    const tdCheck = document.createElement('td');
    tdCheck.className = 'check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = state.selection.has(msg.id);
    // The whole cell toggles the checkbox — the box itself is a small target
    // and near-misses used to open the preview instead. (Clicks on the box
    // bubble here too; onCheck derives the new state, so no double-toggle.)
    tdCheck.addEventListener('click', (e) => {
      e.stopPropagation();
      handlers.onCheck(msg, index, e.shiftKey);
    });
    tdCheck.addEventListener('dblclick', (e) => e.stopPropagation());
    tdCheck.appendChild(cb);

    const mk = (text, title) => {
      const td = document.createElement('td');
      td.textContent = text ?? '';
      td.title = title ?? text ?? '';
      return td;
    };
    const nAttach = msg.attachment_count;
    const tdAttach = mk(
      nAttach == null ? '?' : nAttach > 0 ? String(nAttach) : '',
      nAttach == null ? 'Attachment count unknown — sync this folder to fill it in'
        : nAttach > 0 ? `${nAttach} attachment${nAttach === 1 ? '' : 's'}` : 'No attachments');
    tdAttach.className = 'attach';
    const tdSubject = mk(msg.subject || '(no subject)');
    const red = state.redundant;
    if (red && red.folderId === state.selectedFolderId && red.byId.has(msg.id)) {
      tr.classList.add('redundant');
      const pill = document.createElement('span');
      pill.className = 'redundant-badge';
      pill.textContent = 'quoted in newer';
      const container = state.messages.find((m) => m.id === red.byId.get(msg.id));
      pill.title = container
        ? `Text contained in "${container.subject || '(no subject)'}" (${fmtDate(container.date)})`
        : 'Text contained in a newer message in this folder';
      tdSubject.appendChild(pill);
    }
    tr.append(tdCheck, mk(msg.from_addr), tdSubject,
      tdAttach, mk(fmtDate(msg.date)), mk(msg.to_addrs));

    // Click toggles preview, double-click opens full; timer disambiguates.
    let clickTimer = null;
    tr.addEventListener('click', (e) => {
      if (e.detail > 1) return;
      clearTimeout(clickTimer);
      clickTimer = setTimeout(() => handlers.onRowClick(msg), 230);
    });
    tr.addEventListener('dblclick', () => {
      clearTimeout(clickTimer);
      handlers.onRowDblClick(msg);
    });
    tr.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      handlers.onRowMenu(msg, e.clientX, e.clientY);
    });

    tbody.appendChild(tr);

    const expansion = state.expandedBodies.get(msg.id);
    if (expansion) {
      const trBody = document.createElement('tr');
      trBody.className = 'msg-body';
      const td = document.createElement('td');
      td.colSpan = 6;
      if (expansion.loading) {
        td.textContent = 'Loading…';
      } else {
        const span = document.createElement('span');
        if (expansion.mode === 'full') span.className = 'body-full';
        span.textContent = expansion.body.text;
        td.appendChild(span);
        if (expansion.mode === 'preview' && expansion.body.truncated) {
          td.appendChild(document.createTextNode('\n'));
          const more = document.createElement('span');
          more.className = 'truncated-note';
          more.textContent = '… show full message';
          more.addEventListener('click', () => handlers.onRowDblClick(msg));
          td.appendChild(more);
        }
      }
      trBody.appendChild(td);
      tbody.appendChild(trBody);
    }
  });

  table.appendChild(tbody);
  container.appendChild(table);

  const remaining = state.messagesTotal - state.messages.length;
  if (remaining > 0) {
    const footer = document.createElement('div');
    footer.className = 'load-more';
    if (remaining > PAGE_SIZE) {
      const more = document.createElement('button');
      more.textContent = `Load ${PAGE_SIZE} more`;
      more.addEventListener('click', () => handlers.onLoadMore(false));
      footer.appendChild(more);
    }
    const all = document.createElement('button');
    all.textContent = `Load all (${remaining} more)`;
    all.addEventListener('click', () => handlers.onLoadMore(true));
    footer.appendChild(all);
    container.appendChild(footer);
  }

  for (const th of table.querySelectorAll('th[data-sort]')) {
    if (state.sort?.key === th.dataset.sort) {
      const arrow = document.createElement('span');
      arrow.className = 'sort-arrow';
      arrow.textContent = state.sort.dir === 'asc' ? ' ▲' : ' ▼';
      th.appendChild(arrow);
    }
    th.addEventListener('click', () => handlers.onSort(th.dataset.sort));
  }

  const checkAll = table.querySelector('#check-all');
  checkAll.checked = state.messages.length > 0 && state.messages.every((m) => state.selection.has(m.id));
  table.querySelector('th.check').addEventListener('click', (e) => {
    if (e.target !== checkAll) checkAll.checked = !checkAll.checked;
    handlers.onCheckAll(checkAll.checked);
  });
}
