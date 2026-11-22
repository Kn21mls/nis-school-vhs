// End-to-end check of api/_core.js against in-memory Postgres (pglite).
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {createApi, parseCookies} from '../api/_core.js';

const db = new PGlite();
const store = new Map();
const api = createApi({
  query: async (text, params) => (await db.query(text, params)).rows,
  putPhoto: async (name, buf) => { const ref = 'blob://' + name; store.set(ref, buf); return ref; },
  getPhoto: async ref => store.has(ref) ? {stream: store.get(ref), contentType: 'image/jpeg'} : null,
  password: 'secret-pass',
});

let cookie = '';
const call = (method, path, {body, token, query = {}} = {}) => api({
  method, path, query, body,
  headers: token ? {authorization: 'Bearer ' + token} : {},
  cookies: parseCookies(cookie), ip: '1.2.3.4',
});
const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(5000, 1)]).toString('base64');

let r = await call('POST', 'players', {body: {name: '  Арман  10B '}});
assert.equal(r.status, 201); assert.equal(r.json.name, 'Арман 10B');
const token = r.json.token;
assert.equal((await call('POST', 'players', {body: {name: 'арман 10b'}})).status, 409);
assert.equal((await call('POST', 'players', {body: {name: '<x>'}})).status, 400);

assert.equal((await call('POST', 'submissions', {body: {place: 'Атриум', description: 'нет скамейки у окна', photo: jpg}})).status, 401);
assert.equal((await call('POST', 'submissions', {token, body: {place: 'Атриум', description: 'коротко', photo: jpg}})).status, 400);
assert.equal((await call('POST', 'submissions', {token, body: {place: 'Атриум', description: 'нет скамейки у окна', photo: 'AAAA'}})).status, 400);
r = await call('POST', 'submissions', {token, body: {place: 'Атриум', description: 'нет скамейки у окна', photo: jpg}});
assert.equal(r.status, 201); const id = r.json.id;
await call('POST', 'submissions', {token, body: {place: 'Галерея', description: 'другие перила на втором этаже', photo: jpg}});

r = await call('GET', 'me', {token});
assert.equal(r.json.submissions.length, 2); assert.equal(r.json.points, 0);
assert.equal(typeof r.json.submissions[0].created, 'number');

assert.equal((await call('GET', 'mod/submissions')).status, 401);
assert.equal((await call('GET', 'mod/photo/' + id)).status, 401);
assert.equal((await call('POST', 'mod/login', {body: {password: 'nope'}})).status, 403);
r = await call('POST', 'mod/login', {body: {password: 'secret-pass'}});
assert.equal(r.json.mod, true);
cookie = r.cookie.split(';')[0];
assert.equal((await call('GET', 'mod/me')).json.mod, true);

r = await call('GET', 'mod/submissions', {query: {status: 'pending'}});
assert.equal(r.json.items.length, 2); assert.equal(r.json.counts.pending, 2); assert.equal(r.json.items[0].player, 'Арман 10B');
r = await call('GET', 'mod/photo/' + id);
assert.equal(r.status, 200); assert.ok(r.file.stream.length > 2000);

assert.equal((await call('GET', 'leaderboard')).json.length, 0);
r = await call('POST', 'mod/submissions/' + id, {body: {status: 'valid', points: 15, note: 'поправим'}});
assert.equal(r.json.ok, true);
await call('POST', 'mod/submissions/' + (id + 1), {body: {status: 'invalid', note: 'совпадает'}});
assert.equal((await call('POST', 'mod/submissions/999', {body: {status: 'valid'}})).status, 404);
assert.equal((await call('POST', 'mod/submissions/' + id, {body: {status: 'valid', points: 500}})).status, 400);

r = await call('GET', 'leaderboard');
assert.deepEqual(r.json, [{name: 'Арман 10B', points: 15, count: 1}]);
r = await call('GET', 'me', {token});
assert.equal(r.json.points, 15);
r = await call('GET', 'mod/submissions', {query: {status: 'all'}});
assert.deepEqual(r.json.counts, {valid: 1, invalid: 1});

// back to pending removes points
await call('POST', 'mod/submissions/' + id, {body: {status: 'pending'}});
assert.equal((await call('GET', 'leaderboard')).json.length, 0);

// tampered session cookie is rejected
cookie = cookie.replace(/.$/, c => (c === 'a' ? 'b' : 'a'));
assert.equal((await call('GET', 'mod/submissions')).status, 401);

// login lockout after repeated failures
for (let i = 0; i < 6; i++) await call('POST', 'mod/login', {body: {password: 'x'}});
assert.equal((await call('POST', 'mod/login', {body: {password: 'secret-pass'}})).status, 429);

console.log('api: all checks passed');
