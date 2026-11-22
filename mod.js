// Moderator desk: review submitted frames, mark valid (with points) / invalid.
const $ = id => document.getElementById(id);
const STATUS = {pending: 'на проверке', valid: 'валид', invalid: 'невалид'};
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c]);
let filter = 'pending';

async function api(path, body) {
  const res = await fetch('/api/' + path, body ? {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)} : {});
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { show(false); throw new Error(data.error || 'Нужен вход'); }
  if (!res.ok) throw new Error(data.error || 'Ошибка ' + res.status);
  return data;
}

function show(isMod) {
  $('login').hidden = isMod; $('desk').hidden = !isMod; $('logout').hidden = !isMod;
  if (isMod) load(); else $('password').focus();
}

$('loginForm').onsubmit = async e => {
  e.preventDefault();
  try { await api('mod/login', {password: $('password').value}); $('password').value = ''; $('loginMsg').textContent = ''; show(true); }
  catch (err) { $('loginMsg').textContent = err.message; $('loginMsg').className = 'form-msg err'; }
};
$('logout').onclick = async () => { await api('mod/logout', {}).catch(() => {}); show(false); };

for (const b of $('filters').children) b.onclick = () => {
  filter = b.dataset.s;
  for (const x of $('filters').children) x.classList.toggle('on', x === b);
  load();
};

const date = t => t ? new Date(t * 1000).toLocaleString('ru-RU', {day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'}) : '—';

function card(s) {
  const el = document.createElement('article');
  el.className = 'item ' + s.status;
  el.innerHTML = `
    <button class="shot" type="button" aria-label="Открыть фото"><img loading="lazy" alt="" src="/api/mod/photo/${s.id}">
      <span class="badge ${s.status}">${STATUS[s.status]}${s.status === 'valid' ? ' +' + s.points : ''}</span><span class="id">#${s.id}</span></button>
    <div class="body">
      <h3>${esc(s.place)}</h3>
      <p class="meta">от <b>${esc(s.player)}</b> · ${date(s.created)}${s.reviewed ? ' · проверено ' + date(s.reviewed) : ''}</p>
      <p class="desc">${esc(s.description)}</p>
      <div class="controls">
        <input type="number" min="0" max="100" step="5" value="${s.status === 'valid' ? s.points : 10}" aria-label="Очки" title="Очки за валидный кадр">
        <input type="text" maxlength="300" value="${esc(s.note)}" placeholder="комментарий автору (необязательно)" aria-label="Комментарий">
      </div>
      <div class="acts">
        <button class="btn yes" type="button">✓ валид</button>
        <button class="btn no" type="button">✕ невалид</button>
        ${s.status !== 'pending' ? '<button class="ghost back" type="button" title="Вернуть на проверку">↺</button>' : ''}
      </div>
      <p class="msg"></p>
    </div>`;
  const [pts, note] = el.querySelectorAll('.controls input');
  const decide = async status => {
    el.querySelectorAll('button').forEach(b => b.disabled = true);
    try { await api('mod/submissions/' + s.id, {status, points: Number(pts.value), note: note.value}); load(); }
    catch (err) { el.querySelector('.msg').textContent = err.message; el.querySelectorAll('button').forEach(b => b.disabled = false); }
  };
  el.querySelector('.yes').onclick = () => decide('valid');
  el.querySelector('.no').onclick = () => decide('invalid');
  el.querySelector('.back')?.addEventListener('click', () => decide('pending'));
  el.querySelector('.shot').onclick = () => { $('viewerImg').src = '/api/mod/photo/' + s.id; $('viewer').showModal(); };
  return el;
}

async function load() {
  try {
    const {items, counts} = await api('mod/submissions?status=' + filter);
    for (const b of $('filters').children) { const n = b.querySelector('b'); if (n) n.textContent = counts[b.dataset.s] || 0; }
    $('queue').replaceChildren(...(items.length ? items.map(card) : [Object.assign(document.createElement('p'), {className: 'muted', textContent: 'Пусто. Новых кадров нет.'})]));
  } catch (err) { if (!$('desk').hidden) $('queue').textContent = err.message; }
}

$('viewerClose').onclick = () => $('viewer').close();
$('viewer').onclick = e => { if (e.target === $('viewer')) $('viewer').close(); };
setInterval(() => { if (!document.hidden && !$('desk').hidden && !$('queue').contains(document.activeElement)) load(); }, 45000);

fetch('/api/mod/me').then(r => r.json()).then(d => show(!!d.mod)).catch(() => show(false));
