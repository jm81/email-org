// Message table with checkbox selection (shift-click ranges) and inline body
// expansion: click a row to preview (~4 lines), double-click for full text,
// click again to collapse.

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
    <colgroup><col class="c-check"><col class="c-from"><col class="c-subject"><col class="c-date"><col class="c-to"></colgroup>
    <thead><tr>
      <th class="check"><input type="checkbox" id="check-all"></th>
      <th>From</th><th>Subject</th><th>Date</th><th>To</th>
    </tr></thead>`;
  const tbody = document.createElement('tbody');

  state.messages.forEach((msg, index) => {
    const tr = document.createElement('tr');
    tr.className = 'msg' + (state.selection.has(msg.id) ? ' checked' : '');
    tr.dataset.id = msg.id;

    const tdCheck = document.createElement('td');
    tdCheck.className = 'check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = state.selection.has(msg.id);
    cb.addEventListener('click', (e) => {
      e.stopPropagation();
      handlers.onCheck(msg, index, e.shiftKey);
    });
    tdCheck.appendChild(cb);

    const mk = (text, title) => {
      const td = document.createElement('td');
      td.textContent = text ?? '';
      td.title = title ?? text ?? '';
      return td;
    };
    tr.append(tdCheck, mk(msg.from_addr), mk(msg.subject || '(no subject)'),
      mk(fmtDate(msg.date)), mk(msg.to_addrs));

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

    tbody.appendChild(tr);

    const expansion = state.expandedBodies.get(msg.id);
    if (expansion) {
      const trBody = document.createElement('tr');
      trBody.className = 'msg-body';
      const td = document.createElement('td');
      td.colSpan = 5;
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

  const checkAll = table.querySelector('#check-all');
  checkAll.checked = state.messages.length > 0 && state.messages.every((m) => state.selection.has(m.id));
  checkAll.addEventListener('click', (e) => {
    e.stopPropagation();
    handlers.onCheckAll(checkAll.checked);
  });
}
