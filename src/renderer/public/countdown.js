// Warning shown before Face Guard signs you out / locks the PC. The main process owns the real
// timer; this page only displays it. Closing the window (Cancel / Esc) cancels, when allowed.
const params = new URLSearchParams(location.search);
const action = params.get('action') === 'lock' ? 'lock' : 'signout';
const canCancel = params.get('cancel') === '1';
const deadline = Date.now() + Number(params.get('seconds') || 15) * 1000;

document.getElementById('headline').textContent = action === 'lock' ? 'Locking your PC' : 'Signing you out';
document.getElementById('reason').textContent = params.get('reason') || '';
if (action === 'lock') document.querySelector('.save').hidden = true;

const cancel = document.getElementById('cancel');
cancel.hidden = !canCancel;
if (canCancel) {
  cancel.addEventListener('click', () => window.close());
  document.addEventListener('keydown', (e) => e.key === 'Escape' && window.close());
  cancel.focus();
}

const secs = document.getElementById('seconds');
const tick = () => {
  secs.textContent = String(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
};
tick();
setInterval(tick, 200);
