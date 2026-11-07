#!/usr/bin/env python3
"""
Bloom Skin Clinic — local reservation server.

Python standard library only (no installs). Serves the website and a JSON API,
stores bookings in data/bloom.db (SQLite).

    python server.py            # start on port 8080
    python server.py --demo     # also seed today's schedule with demo bookings

Env vars: BLOOM_PORT, BLOOM_ADMIN_PIN, BLOOM_DOCTOR, BLOOM_PUBLIC_URL
"""
import json
import math
import os
import re
import secrets
import socket
import sqlite3
import string
import sys
import threading
from datetime import date, datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

# ----------------------------------------------------------------- config
BASE = Path(__file__).resolve().parent
DATA_DIR = BASE / "data"
DB_PATH = DATA_DIR / "bloom.db"
HOST = os.environ.get("BLOOM_HOST", "0.0.0.0")
PORT = int(os.environ.get("BLOOM_PORT", "8080"))
ADMIN_PIN = os.environ.get("BLOOM_ADMIN_PIN", "1234")
DOCTOR_NAME = os.environ.get("BLOOM_DOCTOR", "[اسم الدكتورة]")
# Clinic clock: Baghdad is UTC+3 all year (no DST), so cloud servers on UTC still get the right slots
CLINIC_TZ = timezone(timedelta(hours=float(os.environ.get("BLOOM_UTC_OFFSET", "3"))))
LOGIN_MAX_FAILS, LOGIN_WINDOW_S = 5, 600   # 5 wrong PINs per IP per 10 minutes

OPEN_TIME, CLOSE_TIME = "10:00", "20:00"
CLOSED_WEEKDAYS = {4}       # Python weekday(): Friday = 4
STEP_MIN = 15               # start-time granularity
CAPACITY = 2                # patients that can be in session at once
BOOK_AHEAD_DAYS = 21
MIN_LEAD_MIN = 15           # earliest same-day slot = now + this

SERVICES = [
    {"id": "laser-hair",    "name": "إزالة الشعر بالليزر",      "cat": "laser",   "minutes": 60},
    {"id": "laser-pigment", "name": "ليزر التصبغات والكلف",     "cat": "laser",   "minutes": 30},
    {"id": "fractional",    "name": "ليزر الفراكشنال",          "cat": "laser",   "minutes": 45},
    {"id": "deep-clean",    "name": "تنظيف البشرة العميق",      "cat": "care",    "minutes": 60},
    {"id": "hydrafacial",   "name": "هايدرافيشل",               "cat": "care",    "minutes": 45},
    {"id": "peel",          "name": "التقشير الكيميائي",        "cat": "care",    "minutes": 30},
    {"id": "acne",          "name": "علاج حب الشباب",           "cat": "medical", "minutes": 30},
    {"id": "derm",          "name": "استشارة أمراض جلدية",      "cat": "medical", "minutes": 20},
    {"id": "botox",         "name": "البوتوكس والفيلر",         "cat": "rejuv",   "minutes": 30},
    {"id": "meso",          "name": "الميزوثيرابي والبلازما",   "cat": "rejuv",   "minutes": 30},
    {"id": "consult",       "name": "استشارة وفحص بشرة",        "cat": "medical", "minutes": 20},
]
SERVICE_BY_ID = {s["id"]: s for s in SERVICES}

WAITING = ("booked", "confirmed", "arrived")
ACTIVE = WAITING + ("in_session",)
OCCUPYING = ACTIVE + ("done",)
ALL_STATUSES = ACTIVE + ("done", "no_show", "cancelled")

STATIC_EXT = {
    ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".webp": "image/webp", ".ico": "image/x-icon", ".woff2": "font/woff2",
}

WRITE_LOCK = threading.Lock()
ADMIN_TOKENS = set()
LOGIN_FAILS = {}  # ip -> [timestamps]


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status, self.message = status, message


# ----------------------------------------------------------------- helpers
def to_min(t):
    h, m = map(int, t.split(":"))
    return h * 60 + m


def fmt_min(m):
    return f"{m // 60:02d}:{m % 60:02d}"


def clinic_now():
    return datetime.now(CLINIC_TZ).replace(tzinfo=None)


def now_min():
    n = clinic_now()
    return n.hour * 60 + n.minute


def today_str():
    return clinic_now().date().isoformat()


def open_days():
    t = clinic_now().date()
    days = (t + timedelta(days=i) for i in range(BOOK_AHEAD_DAYS))
    return [d.isoformat() for d in days if d.weekday() not in CLOSED_WEEKDAYS]


_DIGITS = str.maketrans("٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹", "01234567890123456789")


def normalize_phone(raw):
    digits = re.sub(r"\D", "", str(raw or "").translate(_DIGITS))
    if digits.startswith("00964"):
        digits = digits[5:]
    elif digits.startswith("964"):
        digits = digits[3:]
    if len(digits) == 10 and digits.startswith("7"):
        digits = "0" + digits
    if not re.fullmatch(r"07\d{9}", digits):
        raise ApiError(400, "رقم الموبايل لازم يكون عراقي، مثل 07XX XXX XXXX")
    return digits


def lan_ip():
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))  # no packet is sent
            return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"


PUBLIC_URL_ENV = os.environ.get("BLOOM_PUBLIC_URL", "").rstrip("/")
PUBLIC_URL = PUBLIC_URL_ENV or f"http://{lan_ip()}:{PORT}"


# ----------------------------------------------------------------- database
def db():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    DATA_DIR.mkdir(exist_ok=True)
    with db() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS bookings (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                code        TEXT UNIQUE NOT NULL,
                service     TEXT NOT NULL,
                date        TEXT NOT NULL,
                time        TEXT NOT NULL,
                minutes     INTEGER NOT NULL,
                name        TEXT NOT NULL,
                phone       TEXT NOT NULL,
                notes       TEXT DEFAULT '',
                status      TEXT NOT NULL DEFAULT 'booked',
                source      TEXT NOT NULL DEFAULT 'web',
                created_at  TEXT NOT NULL,
                updated_at  TEXT NOT NULL
            )""")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings(date)")


def gen_code(conn):
    letters = "ABCDEFGHJKLMNPRSTUVWXYZ"
    for attempt in range(400):
        width = 2 if attempt < 100 else 3
        code = secrets.choice(letters) + str(secrets.randbelow(9 * 10 ** (width - 1)) + 10 ** (width - 1))
        if not conn.execute("SELECT 1 FROM bookings WHERE code=?", (code,)).fetchone():
            return code
    raise ApiError(500, "تعذّر توليد رقم حجز")


def get_booking(conn, code):
    row = conn.execute("SELECT * FROM bookings WHERE code=?", (str(code).upper(),)).fetchone()
    if not row:
        raise ApiError(404, "ما لگينا هذا الحجز")
    return row


def free_slots(conn, service_id, day, exclude_code=None):
    svc = SERVICE_BY_ID.get(service_id)
    if not svc:
        raise ApiError(400, "العلاج غير معروف")
    if day not in open_days():
        return []
    dur = svc["minutes"]
    rows = conn.execute(
        f"SELECT code, time, minutes FROM bookings WHERE date=? AND status IN ({','.join('?' * len(OCCUPYING))})",
        (day, *OCCUPYING)).fetchall()
    busy = [(to_min(r["time"]), to_min(r["time"]) + r["minutes"]) for r in rows if r["code"] != exclude_code]
    earliest = now_min() + MIN_LEAD_MIN if day == today_str() else 0
    slots = []
    for start in range(to_min(OPEN_TIME), to_min(CLOSE_TIME) - dur + 1, STEP_MIN):
        if start < earliest:
            continue
        end = start + dur
        # peak concurrency inside [start, end) must stay below capacity
        points = [start] + [s for s, _ in busy if start < s < end]
        peak = max(sum(1 for s, e in busy if s <= p < e) for p in points)
        if peak < CAPACITY:
            slots.append(fmt_min(start))
    return slots


def queue_state(conn, row):
    """Live position for bookings that are today and still active."""
    if row["date"] != today_str() or row["status"] not in ACTIVE:
        return None
    rows = conn.execute(
        f"SELECT code, time, minutes, status FROM bookings WHERE date=? AND status IN ({','.join('?' * len(ACTIVE))}) "
        "ORDER BY time, created_at", (row["date"], *ACTIVE)).fetchall()
    serving = [r for r in rows if r["status"] == "in_session"]
    waiting = [r for r in rows if r["status"] in WAITING]
    if row["status"] == "in_session":
        return {"ahead": 0, "in_session": True, "serving": len(serving), "est_time": None}
    ahead = []
    for r in waiting:
        if r["code"] == row["code"]:
            break
        ahead.append(r)
    # rough estimate: queue ahead drains across CAPACITY chairs; never before the booked time
    busy_until = now_min() + math.ceil(sum(r["minutes"] for r in ahead) / CAPACITY)
    if len(serving) >= CAPACITY:
        busy_until += 10
    est = max(to_min(row["time"]), busy_until)
    return {"ahead": len(ahead), "in_session": False, "serving": len(serving),
            "est_time": fmt_min(min(est, 23 * 60 + 59))}


def public_view(conn, row):
    svc = SERVICE_BY_ID.get(row["service"], {"name": row["service"]})
    return {
        "code": row["code"], "first_name": row["name"].split()[0], "service": svc["name"],
        "service_id": row["service"], "date": row["date"], "time": row["time"],
        "minutes": row["minutes"], "status": row["status"], "doctor": DOCTOR_NAME,
        "phone_hint": "•••• " + row["phone"][-2:], "queue": queue_state(conn, row),
    }


def admin_view(row):
    d = dict(row)
    d["service_name"] = SERVICE_BY_ID.get(row["service"], {"name": row["service"]})["name"]
    return d


def check_owner(row, body):
    p4 = re.sub(r"\D", "", str(body.get("phone4", "")).translate(_DIGITS))
    if len(p4) != 4 or p4 != row["phone"][-4:]:
        raise ApiError(403, "آخر 4 أرقام من الموبايل ما تطابق الحجز")


def validate_name(name):
    name = " ".join(str(name or "").split())
    if not 2 <= len(name) <= 60:
        raise ApiError(400, "اكتبي اسمك (حرفين على الأقل)")
    return name


def insert_booking(conn, service, day, time, name, phone, notes, status="booked", source="web"):
    stamp = clinic_now().isoformat(timespec="seconds")
    code = gen_code(conn)
    conn.execute(
        "INSERT INTO bookings (code, service, date, time, minutes, name, phone, notes, status, source, created_at, updated_at)"
        " VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        (code, service, day, time, SERVICE_BY_ID[service]["minutes"], name, phone, notes, status, source, stamp, stamp))
    return code


# ----------------------------------------------------------------- API handlers
def api_config(q, body, conn):
    return {"services": SERVICES, "open_days": open_days(), "today": today_str(),
            "open": OPEN_TIME, "close": CLOSE_TIME, "doctor": DOCTOR_NAME, "public_url": PUBLIC_URL_ENV or q.get("_base") or PUBLIC_URL}


def api_slots(q, body, conn):
    service = q.get("service", [""])[0]
    day = q.get("date", [""])[0]
    exclude = (q.get("exclude", [""])[0] or "").upper() or None
    return {"date": day, "service": service, "slots": free_slots(conn, service, day, exclude)}


def api_create(q, body, conn):
    service = str(body.get("service", ""))
    day, time = str(body.get("date", "")), str(body.get("time", ""))
    name = validate_name(body.get("name"))
    phone = normalize_phone(body.get("phone"))
    notes = str(body.get("notes", ""))[:300].strip()
    if service not in SERVICE_BY_ID:
        raise ApiError(400, "اختاري العلاج")
    with WRITE_LOCK:
        dup = conn.execute(
            f"SELECT code FROM bookings WHERE phone=? AND date=? AND status IN ({','.join('?' * len(ACTIVE))})",
            (phone, day, *ACTIVE)).fetchone()
        if dup:
            raise ApiError(409, f"عندك موعد بنفس اليوم (رقم الحجز {dup['code']})")
        if time not in free_slots(conn, service, day):
            raise ApiError(409, "هذا الوقت انحجز هسه، اختاري وقت ثاني")
        code = insert_booking(conn, service, day, time, name, phone, notes)
        conn.commit()
    return public_view(conn, get_booking(conn, code))


def api_queue(code):
    def handler(q, body, conn):
        return public_view(conn, get_booking(conn, code))
    return handler


def api_patient_action(code, action):
    def handler(q, body, conn):
        with WRITE_LOCK:
            row = get_booking(conn, code)
            check_owner(row, body)
            if row["status"] not in ("booked", "confirmed"):
                raise ApiError(409, "ما يمكن تعديل هذا الحجز هسه")
            stamp = clinic_now().isoformat(timespec="seconds")
            if action == "confirm":
                conn.execute("UPDATE bookings SET status='confirmed', updated_at=? WHERE code=?", (stamp, row["code"]))
            elif action == "cancel":
                conn.execute("UPDATE bookings SET status='cancelled', updated_at=? WHERE code=?", (stamp, row["code"]))
            elif action == "reschedule":
                day, time = str(body.get("date", "")), str(body.get("time", ""))
                if time not in free_slots(conn, row["service"], day, exclude_code=row["code"]):
                    raise ApiError(409, "هذا الوقت مو متاح، اختاري وقت ثاني")
                conn.execute("UPDATE bookings SET date=?, time=?, status='booked', updated_at=? WHERE code=?",
                             (day, time, stamp, row["code"]))
            conn.commit()
            return public_view(conn, get_booking(conn, code))
    return handler


def api_admin_login(q, body, conn):
    ip, t = q.get("_ip", "?"), datetime.now(timezone.utc).timestamp()
    fails = [x for x in LOGIN_FAILS.get(ip, []) if t - x < LOGIN_WINDOW_S]
    if len(fails) >= LOGIN_MAX_FAILS:
        raise ApiError(429, "محاولات كثيرة، جربي بعد 10 دقائق")
    if not secrets.compare_digest(str(body.get("pin", "")), ADMIN_PIN):
        LOGIN_FAILS[ip] = fails + [t]
        raise ApiError(403, "الرمز غلط")
    LOGIN_FAILS.pop(ip, None)
    token = secrets.token_urlsafe(24)
    ADMIN_TOKENS.add(token)
    return {"token": token}


def api_admin_list(q, body, conn):
    day = q.get("date", [today_str()])[0]
    rows = conn.execute("SELECT * FROM bookings WHERE date=? ORDER BY time, created_at", (day,)).fetchall()
    return {"date": day, "bookings": [admin_view(r) for r in rows], "doctor": DOCTOR_NAME, "public_url": PUBLIC_URL_ENV or q.get("_base") or PUBLIC_URL}


def api_admin_status(code):
    def handler(q, body, conn):
        status = str(body.get("status", ""))
        if status not in ALL_STATUSES:
            raise ApiError(400, "حالة غير معروفة")
        with WRITE_LOCK:
            row = get_booking(conn, code)
            conn.execute("UPDATE bookings SET status=?, updated_at=? WHERE code=?",
                         (status, clinic_now().isoformat(timespec="seconds"), row["code"]))
            conn.commit()
        return admin_view(get_booking(conn, code))
    return handler


def api_admin_walkin(q, body, conn):
    service = str(body.get("service", ""))
    name = validate_name(body.get("name"))
    phone = normalize_phone(body.get("phone"))
    if service not in SERVICE_BY_ID:
        raise ApiError(400, "اختاري العلاج")
    with WRITE_LOCK:
        slots = free_slots(conn, service, today_str())
        # walk-ins can start right now: allow the current quarter-hour too
        if not slots:
            raise ApiError(409, "ماكو وقت فارغ اليوم لهذا العلاج")
        code = insert_booking(conn, service, today_str(), slots[0], name, phone, "", status="arrived", source="walkin")
        conn.commit()
    return admin_view(get_booking(conn, code))


# ----------------------------------------------------------------- routing
CODE_RE = r"([A-Za-z]\d{2,4})"


def route(method, path):
    if method == "GET":
        if path == "/api/config":
            return api_config, False
        if path == "/api/slots":
            return api_slots, False
        if path == "/api/admin/bookings":
            return api_admin_list, True
        m = re.fullmatch(r"/api/q/" + CODE_RE, path)
        if m:
            return api_queue(m.group(1)), False
    elif method == "POST":
        if path == "/api/bookings":
            return api_create, False
        if path == "/api/admin/login":
            return api_admin_login, False
        if path == "/api/admin/walkin":
            return api_admin_walkin, True
        m = re.fullmatch(r"/api/q/" + CODE_RE + r"/(confirm|cancel|reschedule)", path)
        if m:
            return api_patient_action(m.group(1), m.group(2)), False
        m = re.fullmatch(r"/api/admin/bookings/" + CODE_RE + r"/status", path)
        if m:
            return api_admin_status(m.group(1)), True
    return None, False


class Handler(BaseHTTPRequestHandler):
    server_version = "Bloom/1.0"

    def log_message(self, fmt, *args):
        if "/api/" in self.path and not self.path.startswith("/api/q/"):
            sys.stderr.write(f"[{clinic_now():%H:%M:%S}] {self.command} {self.path}\n")

    def client_ip(self):
        # behind Caddy the real client is the last X-Forwarded-For hop
        fwd = self.headers.get("X-Forwarded-For")
        return fwd.split(",")[-1].strip() if fwd else self.client_address[0]

    def send_json(self, status, obj):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def handle_api(self, method):
        url = urlparse(self.path)
        handler, needs_admin = route(method, url.path)
        if not handler:
            return self.send_json(404, {"error": "not found"})
        if needs_admin and self.headers.get("X-Admin-Token") not in ADMIN_TOKENS:
            return self.send_json(401, {"error": "سجّلي دخول من جديد"})
        body = {}
        if method == "POST":
            length = int(self.headers.get("Content-Length") or 0)
            if length > 16_384:
                return self.send_json(413, {"error": "too large"})
            try:
                body = json.loads(self.rfile.read(length) or b"{}")
                if not isinstance(body, dict):
                    raise ValueError
            except ValueError:
                return self.send_json(400, {"error": "طلب غير صالح"})
        conn = db()
        try:
            q = parse_qs(url.query)
            q["_ip"] = self.client_ip()
            host = self.headers.get("X-Forwarded-Host") or self.headers.get("Host")
            if host and re.fullmatch(r"[A-Za-z0-9.\-]+(:\d+)?", host) and not host.startswith(("localhost", "127.")):
                proto = self.headers.get("X-Forwarded-Proto", "http").split(",")[0].strip()
                q["_base"] = f"{'https' if proto == 'https' else 'http'}://{host}"
            self.send_json(200, handler(q, body, conn))
        except ApiError as e:
            self.send_json(e.status, {"error": e.message})
        except Exception as e:  # keep the server alive during the demo
            sys.stderr.write(f"ERROR {e!r}\n")
            self.send_json(500, {"error": "صار خطأ بالسيرفر"})
        finally:
            conn.close()

    def serve_static(self):
        path = unquote(urlparse(self.path).path)
        if path in ("/", ""):
            path = "/index.html"
        elif path.rstrip("/") == "/admin":
            path = "/admin.html"
        elif re.fullmatch(r"/q/" + CODE_RE + "/?", path):
            path = "/queue.html"
        target = (BASE / path.lstrip("/")).resolve()
        ok = (BASE in target.parents and target.is_file() and target.suffix.lower() in STATIC_EXT
              and DATA_DIR not in target.parents)
        if not ok:
            data = "<h1>404</h1>".encode()
            self.send_response(404)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            return self.wfile.write(data)
        data = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", STATIC_EXT[target.suffix.lower()])
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.startswith("/api/"):
            return self.handle_api("GET")
        self.serve_static()

    def do_POST(self):
        if self.path.startswith("/api/"):
            return self.handle_api("POST")
        self.send_json(404, {"error": "not found"})


# ----------------------------------------------------------------- demo data
def seed_demo():
    """Fill today with a realistic schedule so the queue and dashboard have something to show."""
    names = ["سارة أحمد", "نور علي", "زينب حسين", "مريم كريم", "هبة عباس", "رُسل جاسم", "آية محمد", "دعاء سالم"]
    services = ["hydrafacial", "laser-pigment", "acne", "deep-clean", "consult", "peel", "laser-hair", "botox"]
    statuses = ["done", "in_session", "arrived", "confirmed", "booked", "booked", "booked", "booked"]
    day = today_str()
    with db() as conn:
        conn.execute("DELETE FROM bookings WHERE date=? AND source='demo'", (day,))
        start = max(to_min(OPEN_TIME), (now_min() // 15) * 15 - 60)
        for i, (n, s, st) in enumerate(zip(names, services, statuses)):
            t = min(start + i * 30, to_min(CLOSE_TIME) - SERVICE_BY_ID[s]["minutes"])
            phone = "07" + "".join(secrets.choice(string.digits) for _ in range(9))
            insert_booking(conn, s, day, fmt_min(t), n, phone, "", status=st, source="demo")
    print(f"  Seeded {len(names)} demo bookings for {day}")


def main():
    init_db()
    if "--demo" in sys.argv:
        seed_demo()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print("\n  Bloom Skin Clinic — reservation server")
    print(f"  Website     http://localhost:{PORT}")
    print(f"  On Wi-Fi    {PUBLIC_URL}")
    print(f"  Reception   http://localhost:{PORT}/admin" + ("   (PIN: 1234)" if ADMIN_PIN == "1234" else ""))
    if ADMIN_PIN == "1234":
        print("  WARNING: default admin PIN. Set BLOOM_ADMIN_PIN before going public.")
    print("  Ctrl+C to stop\n")
    sys.stdout.flush()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  Stopped.")


if __name__ == "__main__":
    main()
