const el = () => document.getElementById('context-menu');

export function showMenu(x, y, items) {
  const menu = el();
  menu.innerHTML = '';
  for (const item of items) {
    if (item === '-') {
      menu.appendChild(Object.assign(document.createElement('div'), { className: 'sep' }));
      continue;
    }
    const div = document.createElement('div');
    div.className = 'item' + (item.danger ? ' danger' : '');
    div.textContent = item.label;
    div.addEventListener('click', () => { hideMenu(); item.action(); });
    menu.appendChild(div);
  }
  menu.hidden = false;
  // Position, then nudge inside the viewport.
  menu.style.left = '0px'; menu.style.top = '0px';
  const rect = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - rect.width - 8) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - rect.height - 8) + 'px';
}

export function hideMenu() { el().hidden = true; }

document.addEventListener('click', (e) => {
  if (!el().hidden && !el().contains(e.target)) hideMenu();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideMenu(); });
