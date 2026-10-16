// Always-on-top alert window used by the desktop app. Message comes in via the query string.
const params = new URLSearchParams(location.search);
document.getElementById('title').textContent = params.get('title') || 'Hands off your face!';
document.getElementById('body').textContent = params.get('body') || '';
document.getElementById('toast').addEventListener('click', () => window.close());
