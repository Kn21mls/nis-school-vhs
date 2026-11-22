// Student side: callsign, photo upload, own submissions, leaderboard, OSD clocks.
const $ = id => document.getElementById(id);
const KEY = 'tapeKey';
const MAX_SIDE = 2400;
const STATUS = {pending: 'на проверке', valid: 'принят', invalid: 'отклонён'};
let token = read();
let photo = null;

function read() { try { return localStorage.getItem(KEY) || ''; } catch { return ''; } }
function save(t) { token = t; try { t ? localStorage.setItem(KEY, t) : localStorage.removeItem(KEY); } catch {} }
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c]);

async function api(path, {body, auth = true} = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (auth && token) headers.Authorization = 'Bearer ' + token;
  let res;
  try {
    res = await fetch('/api/' + path, {method: body ? 'POST' : 'GET', headers, body: body && JSON.stringify(body)});
  } catch { throw new Error('Нет связи с сервером'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Ошибка ' + res.status), {status: res.status});
  return data;
}

function msg(id, text, kind = '') { const el = $(id); el.textContent = text; el.className = 'form-msg ' + kind; }

// ---------- OSD clocks
const t0 = performance.now();
const pad = n => String(n).padStart(2, '0');
const months = ['ЯНВ', 'ФЕВ', 'МАР', 'АПР', 'МАЙ', 'ИЮН', 'ИЮЛ', 'АВГ', 'СЕН', 'ОКТ', 'НОЯ', 'ДЕК'];
function tick() {
  const s = Math.floor((performance.now() - t0) / 1000);
  const tc = `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
  $('timecode').textContent = tc; $('tourTime').textContent = tc;
  const d = new Date();
  $('clock').textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  $('tapeDate').textContent = `${months[d.getMonth()]} ${pad(d.getDate())} ${d.getFullYear()}`;
}
tick(); setInterval(tick, 1000);

// ---------- places suggestions
fetch('views.json').then(r => r.json()).then(v => {
  for (const p of v) { const o = document.createElement('option'); o.value = p.name; $('placeList').append(o); }
}).catch(() => {});

export function prefillPlace(name) {
  if (name) $('place').value = name;
  $('send').scrollIntoView({behavior: 'smooth'});
  setTimeout(() => $('desc').focus({preventScroll: true}), 500);
}

// ---------- player
function showPlayer(me) {
  $('joinBox').hidden = !!me; $('meBox').hidden = !me;
  $('sendBtn').disabled = !me;
  $('sendHint').textContent = me ? 'очки — после проверки' : 'сначала создай позывной';
  if (!me) return;
  $('meName').textContent = me.name; $('mePoints').textContent = me.points; $('meCode').textContent = token;
  $('myList').innerHTML = me.submissions.length ? me.submissions.map(s =>
    `<li><span>${esc(s.place)}${s.note ? `<small class="note">${esc(s.note)}</small>` : ''}</span>` +
    `<span class="badge ${s.status}">${STATUS[s.status] || s.status}${s.status === 'valid' ? ' +' + s.points : ''}</span></li>`
  ).join('') : '<li class="muted">пока пусто</li>';
}
async function refreshMe() {
  if (!token) return showPlayer(null);
  try { showPlayer(await api('me')); }
  catch (e) { if (e.status === 401) save(''); showPlayer(null); }
}

$('joinForm').onsubmit = async e => {
  e.preventDefault();
  try {
    const r = await api('players', {body: {name: $('joinName').value}, auth: false});
    save(r.token); msg('joinMsg', ''); await refreshMe(); loadBoard();
  } catch (err) { msg('joinMsg', err.message, 'err'); }
};
$('restoreForm').onsubmit = async e => {
  e.preventDefault();
  const prev = token; save($('restoreCode').value.trim());
  try { showPlayer(await api('me')); msg('joinMsg', ''); loadBoard(); }
  catch (err) { save(prev); msg('joinMsg', err.status === 401 ? 'Код не найден' : err.message, 'err'); }
};
$('logout').onclick = () => {
  if (!confirm('Выйти? Без кода доступа вернуться под этим позывным не получится.')) return;
  save(''); showPlayer(null);
};

// ---------- photo
async function decode(file) {
  try { return await createImageBitmap(file, {imageOrientation: 'from-image'}); }
  catch {
    const url = URL.createObjectURL(file);
    try { const img = new Image(); img.src = url; await img.decode(); return img; }
    finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
  }
}
// Re-encoding through a canvas drops EXIF (GPS, device) and caps the size.
async function prepare(file) {
  const img = await decode(file);
  const w = img.width, h = img.height, k = Math.min(1, MAX_SIDE / Math.max(w, h));
  const c = document.createElement('canvas'); c.width = Math.round(w * k); c.height = Math.round(h * k);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  img.close?.();
  for (const q of [.86, .75, .6]) {
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', q));
    if (blob && blob.size < 7.5e6) return blob;
  }
  throw new Error('Фото слишком большое');
}
async function pick(file) {
  if (!file) return;
  msg('sendMsg', 'обработка кадра…');
  try {
    photo = await prepare(file);
    const prev = $('preview'); if (prev.src) URL.revokeObjectURL(prev.src);
    prev.src = URL.createObjectURL(photo); prev.hidden = false;
    document.querySelector('.drop-empty').hidden = true; msg('sendMsg', '');
  } catch (e) {
    photo = null; msg('sendMsg', e.message.includes('большое') ? e.message : 'Не удалось открыть фото. Попробуй JPG или PNG.', 'err');
  }
}
$('photo').onchange = e => pick(e.target.files[0]);
const drop = $('drop');
drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
drop.ondragleave = () => drop.classList.remove('over');
drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); pick(e.dataTransfer.files[0]); };

const b64 = blob => new Promise((ok, no) => {
  const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.onerror = no; r.readAsDataURL(blob);
});

$('uploadForm').onsubmit = async e => {
  e.preventDefault();
  const place = $('place').value.trim(), description = $('desc').value.trim();
  if (place.length < 2) return msg('sendMsg', 'Укажи место', 'err');
  if (description.length < 10) return msg('sendMsg', 'Опиши, что не так (от 10 символов)', 'err');
  if (!photo) return msg('sendMsg', 'Добавь фото', 'err');
  $('sendBtn').disabled = true; msg('sendMsg', 'передача…');
  try {
    await api('submissions', {body: {place, description, photo: await b64(photo)}});
    msg('sendMsg', 'Кадр передан. Очки появятся после проверки.', 'ok');
    $('desc').value = ''; $('photo').value = ''; photo = null;
    $('preview').hidden = true; document.querySelector('.drop-empty').hidden = false;
    refreshMe();
  } catch (err) { msg('sendMsg', err.message, 'err'); }
  finally { $('sendBtn').disabled = !token; }
};

// ---------- leaderboard
async function loadBoard() {
  try {
    const rows = await api('leaderboard', {auth: false});
    const me = $('meName').textContent;
    $('boardList').innerHTML = rows.length ? rows.map(r =>
      `<li class="${token && r.name === me ? 'me' : ''}"><span class="who">${esc(r.name)}</span>` +
      `<span class="cnt">${r.count} кадр.</span><span class="pts">${r.points}</span></li>`).join('')
      : '<li class="muted">нет подтверждённых кадров</li>';
    const d = new Date(); $('boardTime').textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch { $('boardList').innerHTML = '<li class="muted">сигнал потерян — сервер недоступен</li>'; }
}

refreshMe().then(loadBoard);
setInterval(() => { if (!document.hidden) { loadBoard(); if (token) refreshMe(); } }, 60000);
