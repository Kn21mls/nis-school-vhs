// Vercel function: every /api/* request is rewritten here (see vercel.json).
// Env: DATABASE_URL (Neon), BLOB_READ_WRITE_TOKEN (Vercel Blob), MOD_PASSWORD,
// optional BLOB_ACCESS=public if the Blob store was created as public.
import {Readable} from 'node:stream';
import {neon} from '@neondatabase/serverless';
import {put, get} from '@vercel/blob';
import {createApi, parseCookies} from './_core.js';

const access = process.env.BLOB_ACCESS === 'public' ? 'public' : 'private';
let api;

function getApi() {
  if (api) return api;
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const sql = neon(url);
  api = createApi({
    query: (text, params) => sql.query(text, params),
    putPhoto: async (name, buffer) => (await put(name, buffer, {access, contentType: 'image/jpeg', addRandomSuffix: true})).url,
    getPhoto: async ref => {
      const r = await get(ref, {access});
      return r && r.statusCode === 200 ? {stream: r.stream, contentType: r.blob.contentType} : null;
    },
    password: (process.env.MOD_PASSWORD || '').trim(),
  });
  return api;
}

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://local');
  const path = (url.searchParams.get('p') || url.pathname.replace(/^\/api\//, '')).replace(/^\/+|\/+$/g, '');
  url.searchParams.delete('p');
  let out;
  try {
    out = await getApi()({
      method: req.method,
      path,
      query: Object.fromEntries(url.searchParams),
      body: typeof req.body === 'string' ? safeJson(req.body) : req.body,
      headers: req.headers,
      cookies: parseCookies(req.headers.cookie),
      ip: String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown',
    });
  } catch (e) {
    console.error(e);
    out = {status: 500, json: {error: 'Сервер не настроен'}};
  }
  res.statusCode = out.status || 200;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (out.cookie) res.setHeader('Set-Cookie', out.cookie);
  if (out.file) {
    for (const [k, v] of Object.entries(out.headers || {})) res.setHeader(k, v);
    Readable.fromWeb(out.file.stream).pipe(res);
    return;
  }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', out.cache && res.statusCode === 200 ? out.cache : 'no-store');
  res.end(JSON.stringify(out.json ?? {}));
}

function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }
