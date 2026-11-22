// API for Vercel: same contract as server.py, storage in Postgres (Neon) + Vercel Blob.
// Built as a factory so it can be tested against an in-memory Postgres.
import crypto from 'node:crypto';

const MAX_PHOTO = 3 * 1024 * 1024;   // Vercel functions accept ≤4.5 MB bodies
const MAX_PENDING = 15;
const MAX_PER_DAY = 30;
const SESSION_TTL = 12 * 3600;
const NAME_RE = /^[\p{L}\p{N}_\- .]{2,24}$/u;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS players(
     id SERIAL PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE,
     token_hash TEXT NOT NULL UNIQUE, ip TEXT NOT NULL DEFAULT '', created TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS submissions(
     id SERIAL PRIMARY KEY, player_id INT NOT NULL REFERENCES players(id),
     place TEXT NOT NULL, description TEXT NOT NULL, photo TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'pending', points INT NOT NULL DEFAULT 0, note TEXT NOT NULL DEFAULT '',
     created TIMESTAMPTZ NOT NULL DEFAULT now(), reviewed TIMESTAMPTZ)`,
  `CREATE INDEX IF NOT EXISTS sub_status ON submissions(status)`,
  `CREATE INDEX IF NOT EXISTS sub_player ON submissions(player_id)`,
  `CREATE TABLE IF NOT EXISTS login_fails(ip TEXT NOT NULL, t TIMESTAMPTZ NOT NULL DEFAULT now())`,
];

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, message) => { throw new HttpError(status, message); };
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest('hex');
const tokenHash = t => hmac('tape-player', t);
const epoch = col => `extract(epoch from ${col})::float8`;

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * deps.query(text, params) -> rows
 * deps.putPhoto(name, buffer) -> stored reference (url)
 * deps.getPhoto(ref) -> {stream|buffer, contentType} | null
 * deps.password -> moderator password
 */
export function createApi(deps) {
  let ready = null;
  const q = (text, params = []) => deps.query(text, params);
  const init = () => (ready ??= (async () => { for (const s of SCHEMA) await q(s); })().catch(e => { ready = null; throw e; }));

  const sessionKey = () => {
    if (!deps.password) fail(503, 'Модерация не настроена: задай MOD_PASSWORD');
    return 'mod|' + deps.password;
  };
  function isMod(cookies) {
    const v = cookies.mod || '';
    const [exp, sig] = v.split('.');
    if (!exp || !sig || Number(exp) < Date.now() / 1000 || !deps.password) return false;
    return safeEqual(sig, hmac(sessionKey(), exp));
  }
  async function player(headers) {
    const auth = headers.authorization || '';
    if (!auth.startsWith('Bearer ')) return null;
    const rows = await q('SELECT * FROM players WHERE token_hash=$1', [tokenHash(auth.slice(7).trim())]);
    return rows[0] || null;
  }
  const requireMod = c => { if (!isMod(c)) fail(401, 'Нужен вход модератора'); };

  // ---- routes: each returns {status, json} or {status, stream/buffer, headers}
  async function route({method, path, query, body, headers, cookies, ip}) {
    await init();

    if (method === 'GET' && path === 'leaderboard') {
      const rows = await q(`SELECT p.name, SUM(s.points)::int AS points, COUNT(s.id)::int AS count
        FROM submissions s JOIN players p ON p.id=s.player_id WHERE s.status='valid'
        GROUP BY p.id HAVING SUM(s.points)>0 ORDER BY points DESC, MIN(s.reviewed) ASC LIMIT 50`);
      return {json: rows, cache: 's-maxage=20'};
    }

    if (method === 'GET' && path === 'me') {
      const p = await player(headers); if (!p) fail(401, 'Сначала введи ник');
      const subs = await q(`SELECT id, place, status, points, note, ${epoch('created')} AS created
        FROM submissions WHERE player_id=$1 ORDER BY id DESC LIMIT 60`, [p.id]);
      const total = subs.filter(s => s.status === 'valid').reduce((a, s) => a + s.points, 0);
      return {json: {name: p.name, points: total, submissions: subs}};
    }

    if (method === 'POST' && path === 'players') {
      const name = String(body?.name ?? '').split(/\s+/).filter(Boolean).join(' ');
      if (!NAME_RE.test(name)) fail(400, 'Ник: 2–24 символа, буквы, цифры, пробел, _ - .');
      const [{n}] = await q(`SELECT COUNT(*)::int AS n FROM players WHERE ip=$1 AND created > now() - interval '1 hour'`, [ip]);
      if (n >= 12) fail(429, 'Слишком много регистраций, попробуй позже');
      const token = crypto.randomBytes(24).toString('base64url');
      const rows = await q(`INSERT INTO players(name,name_key,token_hash,ip) VALUES($1,$2,$3,$4)
        ON CONFLICT (name_key) DO NOTHING RETURNING id`, [name, name.toLowerCase(), tokenHash(token), ip]);
      if (!rows.length) fail(409, 'Такой ник уже занят');
      return {status: 201, json: {name, token}};
    }

    if (method === 'POST' && path === 'submissions') {
      const p = await player(headers); if (!p) fail(401, 'Сначала введи ник');
      const place = String(body?.place ?? '').split(/\s+/).filter(Boolean).join(' ').slice(0, 80);
      const desc = String(body?.description ?? '').trim().slice(0, 1200);
      if (place.length < 2) fail(400, 'Укажи место');
      if (desc.length < 10) fail(400, 'Опиши, что не так с моделью (от 10 символов)');
      const raw = String(body?.photo ?? '');
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) fail(400, 'Фото повреждено');
      const photo = Buffer.from(raw, 'base64');
      if (photo.length < 2000 || photo[0] !== 0xff || photo[1] !== 0xd8 || photo[2] !== 0xff) fail(400, 'Нужно фото JPEG');
      if (photo.length > MAX_PHOTO) fail(413, 'Слишком большой файл');
      const [{pending, today}] = await q(`SELECT
          COUNT(*) FILTER (WHERE status='pending')::int AS pending,
          COUNT(*) FILTER (WHERE created > now() - interval '1 day')::int AS today
        FROM submissions WHERE player_id=$1`, [p.id]);
      if (pending >= MAX_PENDING || today >= MAX_PER_DAY) fail(429, 'Лимит фото: дождись проверки');
      const ref = await deps.putPhoto(`photos/${Date.now()}-${crypto.randomBytes(6).toString('hex')}.jpg`, photo);
      const [{id}] = await q(`INSERT INTO submissions(player_id,place,description,photo) VALUES($1,$2,$3,$4) RETURNING id`,
        [p.id, place, desc, ref]);
      return {status: 201, json: {id}};
    }

    if (method === 'GET' && path === 'mod/me') return {json: {mod: isMod(cookies)}};

    if (method === 'POST' && path === 'mod/login') {
      sessionKey();
      const [{n}] = await q(`SELECT COUNT(*)::int AS n FROM login_fails WHERE ip=$1 AND t > now() - interval '5 minutes'`, [ip]);
      if (n >= 6) fail(429, 'Слишком много попыток, подожди 5 минут');
      if (!safeEqual(body?.password ?? '', deps.password)) {
        await q('INSERT INTO login_fails(ip) VALUES($1)', [ip]);
        await q(`DELETE FROM login_fails WHERE t < now() - interval '1 day'`);
        fail(403, 'Неверный пароль');
      }
      const exp = String(Math.floor(Date.now() / 1000) + SESSION_TTL);
      return {json: {mod: true}, cookie: `mod=${exp}.${hmac(sessionKey(), exp)}; HttpOnly; Secure; SameSite=Strict; Path=/api/; Max-Age=${SESSION_TTL}`};
    }

    if (method === 'POST' && path === 'mod/logout') {
      return {json: {mod: false}, cookie: 'mod=; HttpOnly; Secure; SameSite=Strict; Path=/api/; Max-Age=0'};
    }

    if (method === 'GET' && path === 'mod/submissions') {
      requireMod(cookies);
      const status = query.status || 'pending';
      const all = status === 'all';
      const rows = await q(`SELECT s.id, s.place, s.description, s.status, s.points, s.note,
          ${epoch('s.created')} AS created, ${epoch('s.reviewed')} AS reviewed, p.name AS player
        FROM submissions s JOIN players p ON p.id=s.player_id
        ${all ? '' : 'WHERE s.status=$1'} ORDER BY s.id ${status === 'pending' ? 'ASC' : 'DESC'} LIMIT 300`, all ? [] : [status]);
      const counts = Object.fromEntries((await q('SELECT status, COUNT(*)::int AS n FROM submissions GROUP BY status')).map(r => [r.status, r.n]));
      return {json: {items: rows, counts}};
    }

    let m;
    if (method === 'GET' && (m = path.match(/^mod\/photo\/(\d+)$/))) {
      requireMod(cookies);
      const [row] = await q('SELECT photo FROM submissions WHERE id=$1', [Number(m[1])]);
      const file = row && await deps.getPhoto(row.photo);
      if (!file) fail(404, 'Фото не найдено');
      return {status: 200, file, headers: {'Content-Type': file.contentType || 'image/jpeg', 'Cache-Control': 'private, max-age=3600'}};
    }

    if (method === 'POST' && (m = path.match(/^mod\/submissions\/(\d+)$/))) {
      requireMod(cookies);
      const status = body?.status;
      if (!['valid', 'invalid', 'pending'].includes(status)) fail(400, 'Статус: valid / invalid / pending');
      const points = status === 'valid' ? Math.trunc(Number(body?.points) || 0) : 0;
      if (points < 0 || points > 100) fail(400, 'Очки: 0–100');
      const note = String(body?.note ?? '').trim().slice(0, 300);
      const rows = await q(`UPDATE submissions SET status=$1, points=$2, note=$3,
          reviewed = CASE WHEN $1='pending' THEN NULL ELSE now() END WHERE id=$4 RETURNING id`,
        [status, points, note, Number(m[1])]);
      if (!rows.length) fail(404, 'Фото не найдено');
      return {json: {ok: true}};
    }

    fail(404, 'Нет такого адреса');
  }

  return async function handle(req) {
    try {
      return await route(req);
    } catch (e) {
      if (e instanceof HttpError) return {status: e.status, json: {error: e.message}};
      console.error(e);
      return {status: 500, json: {error: 'Сбой сервера'}};
    }
  };
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
