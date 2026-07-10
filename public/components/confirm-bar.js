// "Confirm but don't be whiny": the floating bar morphs into a one-click
// inline confirm. Enter confirms, Esc cancels, no modal.
const bar = () => document.getElementById('batch-bar');

export function confirmInBar(message, confirmLabel = 'Confirm') {
  return new Promise((resolve) => {
    const el = bar();
    const prev = { hidden: el.hidden, children: [...el.childNodes] };
    el.classList.add('confirming');
    el.innerHTML = '';
    el.hidden = false;

    const msg = document.createElement('span');
    msg.textContent = message;
    const yes = document.createElement('button');
    yes.className = 'danger';
    yes.textContent = confirmLabel;
    const no = document.createElement('button');
    no.textContent = 'Cancel';
    el.append(msg, yes, no);

    const finish = (result) => {
      document.removeEventListener('keydown', onKey, true);
      el.classList.remove('confirming');
      el.innerHTML = '';
      el.append(...prev.children);
      el.hidden = prev.hidden;
      resolve(result);
    };
    const onKey = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
    };
    yes.addEventListener('click', () => finish(true));
    no.addEventListener('click', () => finish(false));
    document.addEventListener('keydown', onKey, true);
    yes.focus();
  });
}

export function showProgress(text) {
  const el = bar();
  el.hidden = false;
  el.innerHTML = '';
  el.append(Object.assign(document.createElement('span'), { textContent: text }));
}
