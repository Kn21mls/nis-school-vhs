"""Local server: static site from dist/ plus a small JSON API.

Photos and the database live in data/ (never committed).
Moderator password: env MOD_PASSWORD, otherwise data/mod_password.txt
(generated on first start).

    python server.py                 # http://127.0.0.1:8080
    python server.py --host 0.0.0.0  # reachable from phones on the same network
"""
import argparse
import base64
import hmac
import json
import os
import re
import secrets
import sqlite3
import threading
import time
import webbrowser
from contextlib import contextmanager
from http.cookies import SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).parent
DIST = ROOT / "dist"
DATA = ROOT / "data"
UPLOADS = DATA / "uploads"
DB_PATH = DATA / "db.sqlite3"

MAX_BODY = 14 * 1024 * 1024        # JSON with a base64 photo
MAX_PHOTO = 10 * 1024 * 1024
MAX_PENDING = 15                   # unchecked photos per player
MAX_PER_DAY = 30
SESSION_TTL = 12 * 3600
NAME_RE = re.compile(r"^[\w\- .]{2,24}$", re.UNICODE)

_lock = threading.Lock()
_sessions: dict[str, float] = {}
_fails: dict[str, list[float]] = {}
_signups: dict[str, list[float]] = {}


@contextmanager
def db():
    con = sqlite3.connect(DB_PATH, timeout=10)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys=ON")
    try:
        with con:
            yield con
    finally:
        con.close()


def init() -> str:
    UPLOADS.mkdir(parents=True, exist_ok=True)
    with db() as con:
        con.executescript("""
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS players(
          id INTEGER PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE,
          token_hash TEXT NOT NULL UNIQUE, created REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS submissions(
          id INTEGER PRIMARY KEY, player_id INTEGER NOT NULL REFERENCES players(id),
          place TEXT NOT NULL, description TEXT NOT NULL, file TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending', points INTEGER NOT NULL DEFAULT 0,
          note TEXT NOT NULL DEFAULT '', created REAL NOT NULL, reviewed REAL);
        CREATE INDEX IF NOT EXISTS sub_status ON submissions(status);
        CREATE INDEX IF NOT EXISTS sub_player ON submissions(player_id);
        """)
    password = os.environ.get("MOD_PASSWORD", "").strip()
    if not password:
        f = DATA / "mod_password.txt"
        if not f.exists():
            f.write_text(secrets.token_urlsafe(12), encoding="utf-8")
        password = f.read_text(encoding="utf-8").strip()
    return password


def token_hash(token: str) -> str:
    return hmac.new(b"tape-player", token.encode(), "sha256").hexdigest()


def rate(bucket: dict, key: str, window: float, limit: int) -> bool:
    """True if the key is still under its limit (and records the hit)."""
    now = time.time()
    with _lock:
        hits = [t for t in bucket.get(key, []) if now - t < window]
        bucket[key] = hits
        if len(hits) >= limit:
            return False
        hits.append(now)
        return True


class Handler(SimpleHTTPRequestHandler):
    server_version = "tape"
    sys_version = ""
    password = ""

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(DIST), **kw)

    def log_message(self, fmt, *args):
        if self.path.startswith("/api/"):
            super().log_message(fmt, *args)

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        super().end_headers()

    # ---------- helpers
    def reply(self, status=200, payload=None, headers=()):
        body = json.dumps(payload if payload is not None else {}, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        for k, v in headers:
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def fail(self, status, message):
        self.reply(status, {"error": message})

    def body(self):
        if "application/json" not in self.headers.get("Content-Type", ""):
            raise ValueError("Нужен JSON")
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            raise OverflowError
        try:
            return json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            raise ValueError("Плохой JSON")

    def player(self, con):
        auth = self.headers.get("Authorization", "")
        if not auth.startswith("Bearer "):
            return None
        return con.execute("SELECT * FROM players WHERE token_hash=?",
                           (token_hash(auth[7:].strip()),)).fetchone()

    def is_mod(self):
        cookie = SimpleCookie(self.headers.get("Cookie", ""))
        sid = cookie["mod"].value if "mod" in cookie else ""
        with _lock:
            exp = _sessions.get(sid)
            if exp and exp > time.time():
                return True
            _sessions.pop(sid, None)
        return False

    # ---------- routing
    def do_GET(self):
        url = urlparse(self.path)
        if not url.path.startswith("/api/"):
            return super().do_GET()
        try:
            self.get_api(url)
        except Exception as e:  # noqa: BLE001
            self.log_error("API error: %r", e)
            self.fail(500, "Сбой сервера")

    def do_POST(self):
        url = urlparse(self.path)
        try:
            self.post_api(url)
        except OverflowError:
            self.fail(413, "Слишком большой файл")
        except ValueError as e:
            self.fail(400, str(e))
        except Exception as e:  # noqa: BLE001
            self.log_error("API error: %r", e)
            self.fail(500, "Сбой сервера")

    def get_api(self, url):
        path = url.path
        with db() as con:
            if path == "/api/leaderboard":
                rows = con.execute("""
                  SELECT p.name, SUM(s.points) AS points, COUNT(s.id) AS count
                  FROM submissions s JOIN players p ON p.id=s.player_id
                  WHERE s.status='valid' GROUP BY p.id HAVING points>0
                  ORDER BY points DESC, MIN(s.reviewed) ASC LIMIT 50""").fetchall()
                return self.reply(200, [dict(r) for r in rows])
            if path == "/api/me":
                p = self.player(con)
                if not p:
                    return self.fail(401, "Нет позывного")
                subs = con.execute("""SELECT id, place, status, points, note, created
                    FROM submissions WHERE player_id=? ORDER BY id DESC LIMIT 60""", (p["id"],)).fetchall()
                total = sum(s["points"] for s in subs if s["status"] == "valid")
                return self.reply(200, {"name": p["name"], "points": total,
                                        "submissions": [dict(s) for s in subs]})
            if path == "/api/mod/me":
                return self.reply(200, {"mod": self.is_mod()})
            if not self.is_mod():
                return self.fail(401, "Нужен вход модератора")
            if path == "/api/mod/submissions":
                status = parse_qs(url.query).get("status", ["pending"])[0]
                where, args = ("", ()) if status == "all" else ("WHERE s.status=?", (status,))
                rows = con.execute(f"""
                  SELECT s.id, s.place, s.description, s.status, s.points, s.note, s.created,
                         s.reviewed, p.name AS player
                  FROM submissions s JOIN players p ON p.id=s.player_id {where}
                  ORDER BY s.id {'ASC' if status == 'pending' else 'DESC'} LIMIT 300""", args).fetchall()
                counts = dict(con.execute("SELECT status, COUNT(*) FROM submissions GROUP BY status").fetchall())
                return self.reply(200, {"items": [dict(r) for r in rows], "counts": counts})
            m = re.fullmatch(r"/api/mod/photo/(\d+)", path)
            if m:
                row = con.execute("SELECT file FROM submissions WHERE id=?", (int(m[1]),)).fetchone()
                f = UPLOADS / row["file"] if row else None
                if not f or not f.is_file():
                    return self.fail(404, "Нет файла")
                data = f.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "image/jpeg")
                self.send_header("Cache-Control", "private, max-age=3600")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                return self.wfile.write(data)
        self.fail(404, "Нет такого адреса")

    def post_api(self, url):
        path = url.path
        ip = self.client_address[0]
        if path == "/api/players":
            data = self.body()
            name = " ".join(str(data.get("name", "")).split())
            if not NAME_RE.match(name):
                raise ValueError("Позывной: 2–24 символа, буквы, цифры, пробел, _ - .")
            if not rate(_signups, ip, 3600, 12):
                return self.fail(429, "Слишком много позывных, попробуй позже")
            token = secrets.token_urlsafe(24)
            try:
                with db() as con:
                    con.execute("INSERT INTO players(name,name_key,token_hash,created) VALUES(?,?,?,?)",
                                (name, name.casefold(), token_hash(token), time.time()))
            except sqlite3.IntegrityError:
                return self.fail(409, "Такой позывной уже занят")
            return self.reply(201, {"name": name, "token": token})

        if path == "/api/submissions":
            data = self.body()
            with db() as con:
                p = self.player(con)
                if not p:
                    return self.fail(401, "Нет позывного")
                place = " ".join(str(data.get("place", "")).split())[:80]
                desc = str(data.get("description", "")).strip()[:1200]
                if len(place) < 2:
                    raise ValueError("Укажи место")
                if len(desc) < 10:
                    raise ValueError("Опиши, что не так с моделью (от 10 символов)")
                try:
                    photo = base64.b64decode(str(data.get("photo", "")), validate=True)
                except ValueError:
                    raise ValueError("Фото повреждено")
                if not photo.startswith(b"\xff\xd8\xff") or len(photo) < 2000:
                    raise ValueError("Нужно фото JPEG")
                if len(photo) > MAX_PHOTO:
                    raise OverflowError
                pending = con.execute("SELECT COUNT(*) FROM submissions WHERE player_id=? AND status='pending'",
                                      (p["id"],)).fetchone()[0]
                today = con.execute("SELECT COUNT(*) FROM submissions WHERE player_id=? AND created>?",
                                    (p["id"], time.time() - 86400)).fetchone()[0]
                if pending >= MAX_PENDING or today >= MAX_PER_DAY:
                    return self.fail(429, "Лимит записей: дождись проверки")
                name = f"{int(time.time())}-{secrets.token_hex(6)}.jpg"
                (UPLOADS / name).write_bytes(photo)
                cur = con.execute("""INSERT INTO submissions(player_id,place,description,file,created)
                                     VALUES(?,?,?,?,?)""", (p["id"], place, desc, name, time.time()))
                new_id = cur.lastrowid
            return self.reply(201, {"id": new_id})  # after commit

        if path == "/api/mod/login":
            data = self.body()
            if not rate(_fails, ip, 300, 6):
                return self.fail(429, "Слишком много попыток, подожди 5 минут")
            if not hmac.compare_digest(str(data.get("password", "")).encode(), self.password.encode()):
                time.sleep(0.6)
                return self.fail(403, "Неверный пароль")
            sid = secrets.token_urlsafe(32)
            with _lock:
                _sessions[sid] = time.time() + SESSION_TTL
                _fails.pop(ip, None)
            return self.reply(200, {"mod": True}, [(
                "Set-Cookie", f"mod={sid}; HttpOnly; SameSite=Strict; Path=/api/; Max-Age={SESSION_TTL}")])

        if path == "/api/mod/logout":
            cookie = SimpleCookie(self.headers.get("Cookie", ""))
            if "mod" in cookie:
                with _lock:
                    _sessions.pop(cookie["mod"].value, None)
            return self.reply(200, {"mod": False}, [("Set-Cookie", "mod=; Path=/api/; Max-Age=0")])

        m = re.fullmatch(r"/api/mod/submissions/(\d+)", path)
        if m:
            if not self.is_mod():
                return self.fail(401, "Нужен вход модератора")
            data = self.body()
            status = data.get("status")
            if status not in ("valid", "invalid", "pending"):
                raise ValueError("Статус: valid / invalid / pending")
            points = int(data.get("points") or 0) if status == "valid" else 0
            if not 0 <= points <= 100:
                raise ValueError("Очки: 0–100")
            note = str(data.get("note", "")).strip()[:300]
            with db() as con:
                cur = con.execute("""UPDATE submissions SET status=?, points=?, note=?, reviewed=?
                                     WHERE id=?""", (status, points, note,
                                                     None if status == "pending" else time.time(), int(m[1])))
                if not cur.rowcount:
                    return self.fail(404, "Нет записи")
            return self.reply(200, {"ok": True})

        self.fail(404, "Нет такого адреса")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()
    Handler.password = init()
    Handler.extensions_map = {**Handler.extensions_map, ".glb": "model/gltf-binary",
                              ".webp": "image/webp", ".js": "text/javascript"}
    with ThreadingHTTPServer((args.host, args.port), Handler) as server:
        url = f"http://127.0.0.1:{server.server_port}/"
        print(f"Сайт: {url}\nМодерация: {url}mod.html")
        if not os.environ.get("MOD_PASSWORD"):
            print(f"Пароль модератора: {DATA / 'mod_password.txt'}")
        if not args.no_browser:
            webbrowser.open(url)
        server.serve_forever()


if __name__ == "__main__":
    main()
