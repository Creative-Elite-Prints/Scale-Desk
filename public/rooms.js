// Project rooms: private shared spaces for a client and a developer.
// A room stays open until the client approves AND the full payment is recorded, then it closes.
const fs = require('fs'), path = require('path'), crypto = require('crypto');

const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const HOOK_SECRET = process.env.PAYMENT_WEBHOOK_SECRET || '';
const ROOM_DAYS = +process.env.ROOM_DAYS || 60;                       // room expires if never finished
const DOWNLOAD_DAYS = +process.env.DOWNLOAD_DAYS_AFTER_CLOSE || 7;    // then files are deleted
const MAX_FILE = 7 * 1024 * 1024;
const DAY = 86400000;
const SEC = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' };

fs.mkdirSync(path.join(DATA, 'files'), { recursive: true });
const DBF = path.join(DATA, 'rooms.json');
let db = { rooms: {} };
try { db = JSON.parse(fs.readFileSync(DBF, 'utf8')); } catch (e) { /* first run */ }
const save = () => { fs.writeFileSync(DBF + '.tmp', JSON.stringify(db)); fs.renameSync(DBF + '.tmp', DBF); };

const now = () => Date.now();
const sha = x => crypto.createHash('sha256').update(String(x)).digest('hex');
const same = (a, b) => crypto.timingSafeEqual(Buffer.from(sha(a)), Buffer.from(sha(b)));
const rid = () => crypto.randomBytes(6).toString('hex');
const secret = () => crypto.randomBytes(24).toString('base64url');
const clip = (s, n) => String(s || '').trim().slice(0, n);

const pages = {
  '/admin': fs.readFileSync(path.join(__dirname, 'public', 'admin.html')),
  '/r': fs.readFileSync(path.join(__dirname, 'public', 'room.html'))
};

// ---- Guessing protection: 15 wrong keys in 10 minutes blocks an address ----
const fails = new Map();
const recent = ip => (fails.get(ip) || []).filter(t => now() - t < 600000);
const blocked = ip => recent(ip).length >= 15;
const fail = ip => fails.set(ip, recent(ip).concat(now()));

// ---- Room rules ----
const paidFull = r => r.paidCents >= r.amountCents;
const windowOpen = r => r.status === 'open' || now() < r.closedAt + DOWNLOAD_DAYS * DAY;
function closeRoom(r, why) { r.status = 'closed'; r.closedAt = now(); r.reason = why; r.log.push([now(), 'closed: ' + why]); save(); }
function refresh(r) { if (r.status === 'open' && now() > r.expiresAt) closeRoom(r, 'expired'); }
function maybeClose(r) {
  if (r.status === 'open' && r.approved && paidFull(r)) closeRoom(r, 'approved and paid in full'); else save();
}
function purgeRoom(r) {
  for (const f of r.files) { try { fs.unlinkSync(path.join(DATA, 'files', r.id + '-' + f.id)); } catch (e) { /* already gone */ } }
  r.status = 'purged'; r.files = []; r.messages = []; r.tokens = {}; r.payUrl = '';
  r.log.push([now(), 'files and messages deleted']); save();
}
function pay(r, amount, ref) {
  const n = +amount;
  if (!(n > 0)) return { code: 400, body: { error: 'Amount must be more than zero' } };
  ref = clip(ref, 80) || 'manual-' + rid();
  if (r.payments.some(p => p.ref === ref)) return { code: 200, body: { ok: true, duplicate: true } };
  const cents = Math.round(n * 100);
  r.payments.push({ ref, cents, at: now() }); r.paidCents += cents;
  r.log.push([now(), 'payment ' + (cents / 100).toFixed(2) + ' (' + ref + ')']);
  maybeClose(r);
  return { code: 200, body: { ok: true, paidCents: r.paidCents, status: r.status } };
}
const label = (r, role) => role === 'client' ? r.clientName : role === 'developer' ? 'Developer' : 'Scale Desk';
function view(r, role) {
  return {
    id: r.id, title: r.title, clientName: r.clientName, currency: r.currency, role,
    amountCents: r.amountCents, paidCents: r.paidCents, approved: r.approved,
    status: r.status, reason: r.reason || '', expiresAt: r.expiresAt,
    downloadsUntil: r.status === 'closed' ? r.closedAt + DOWNLOAD_DAYS * DAY : 0,
    canApprove: role === 'client' && r.status === 'open' && !r.approved,
    payUrl: paidFull(r) ? '' : r.payUrl,
    files: r.files.map(f => ({ id: f.id, name: f.name, size: f.size, final: f.final, by: f.by, at: f.at,
      locked: f.final && role === 'client' && !paidFull(r) }))
  };
}

// ---- Who is calling? ----
function who(req, ip, roomId) {
  if (blocked(ip)) return { err: 429 };
  const ak = req.headers['x-admin-key'];
  if (ak) { if (ADMIN_KEY && same(ak, ADMIN_KEY)) return { role: 'owner' }; fail(ip); return { err: 401 }; }
  const m = /^Bearer (\w+)\.([\w-]+)$/.exec(req.headers.authorization || '');
  if (m) {
    const r = db.rooms[m[1]], h = sha(m[2]);
    if (r && (!roomId || roomId === r.id)) {
      for (const role of ['client', 'developer']) {
        const t = r.tokens[role];
        if (t && t.length === h.length && crypto.timingSafeEqual(Buffer.from(h), Buffer.from(t))) return { role };
      }
    }
  }
  fail(ip); return { err: 401 };
}

// ---- Small HTTP helpers ----
function send(res, code, obj) { res.writeHead(code, Object.assign({ 'Content-Type': 'application/json' }, SEC)); res.end(JSON.stringify(obj)); }
function readBody(req, max) {
  return new Promise((ok, no) => {
    let n = 0; const chunks = [];
    req.on('data', c => { n += c.length; if (n > max) { no(new Error('too big')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
    req.on('error', no);
  });
}
const json = async (req, max = 20000) => { try { return JSON.parse((await readBody(req, max)) || '{}'); } catch (e) { return null; } };

async function run(req, res, u) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'x';
  const p = u.pathname, m = req.method;
  if (blocked(ip)) return send(res, 429, { error: 'Too many attempts. Try again later.' });

  // Payment confirmation from your payment provider (or an automation tool), signed with a shared secret.
  if (p === '/api/webhooks/payment' && m === 'POST') {
    if (!HOOK_SECRET) return send(res, 404, { error: 'Not enabled' });
    const raw = await readBody(req, 20000);
    const want = crypto.createHmac('sha256', HOOK_SECRET).update(raw).digest('hex');
    const got = String(req.headers['x-signature'] || '');
    if (got.length !== want.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want))) { fail(ip); return send(res, 401, { error: 'Bad signature' }); }
    let d; try { d = JSON.parse(raw); } catch (e) { return send(res, 400, { error: 'Bad JSON' }); }
    const r = db.rooms[d.roomId];
    if (!r || r.status === 'purged') return send(res, 404, { error: 'Room not found' });
    const out = pay(r, d.amount, d.reference);
    return send(res, out.code, out.body);
  }

  if (p === '/api/rooms') {
    const a = who(req, ip, null);
    if (a.err) return send(res, a.err, { error: 'Not authorised' });
    if (a.role !== 'owner') return send(res, 403, { error: 'Not allowed' });
    if (m === 'GET') {
      return send(res, 200, Object.values(db.rooms).filter(r => r.status !== 'purged').map(r => ({
        id: r.id, title: r.title, clientName: r.clientName, status: r.status, reason: r.reason || '', approved: r.approved,
        amountCents: r.amountCents, paidCents: r.paidCents, currency: r.currency, expiresAt: r.expiresAt, closedAt: r.closedAt || 0 })));
    }
    if (m === 'POST') {
      const d = await json(req), amount = d && +d.amount;
      if (!d || !clip(d.title, 120) || !clip(d.clientName, 80) || !(amount > 0)) return send(res, 400, { error: 'Title, client name and amount are required' });
      const payUrl = /^https:\/\//i.test(d.payUrl || '') ? clip(d.payUrl, 500) : '';
      const days = Math.min(365, Math.max(1, +d.days || ROOM_DAYS));
      const id = rid(), tk = { client: secret(), developer: secret() };
      db.rooms[id] = {
        id, title: clip(d.title, 120), clientName: clip(d.clientName, 80),
        currency: (clip(d.currency, 3) || 'USD').toUpperCase(), amountCents: Math.round(amount * 100), paidCents: 0, payments: [],
        payUrl, approved: false, status: 'open', createdAt: now(), expiresAt: now() + days * DAY,
        tokens: { client: sha(tk.client), developer: sha(tk.developer) }, messages: [], files: [], log: [[now(), 'created']]
      };
      save();
      return send(res, 201, { id, tokens: { client: id + '.' + tk.client, developer: id + '.' + tk.developer } });
    }
    return send(res, 405, { error: 'Method not allowed' });
  }

  const mm = /^\/api\/rooms\/(\w+)(?:\/(\w+))?(?:\/(\w+))?$/.exec(p);
  if (!mm) return send(res, 404, { error: 'Not found' });
  const [, id, act, sub] = mm;
  const a = who(req, ip, id);
  if (a.err) return send(res, a.err, { error: 'Not authorised' });
  const r = db.rooms[id];
  if (!r) return send(res, 404, { error: 'Not found' });
  refresh(r);
  if (r.status === 'purged') return send(res, 410, { error: 'This room has been deleted' });
  const role = a.role, owner = role === 'owner', open = r.status === 'open';

  if (!act && m === 'GET') return send(res, 200, view(r, role));

  if (act === 'messages') {
    if (m === 'GET') { const since = +u.searchParams.get('since') || 0; return send(res, 200, r.messages.filter(x => x.id > since)); }
    if (m === 'POST') {
      if (!open) return send(res, 403, { error: 'This room is closed' });
      const d = await json(req), text = d && clip(d.body, 4000);
      if (!text) return send(res, 400, { error: 'Message is empty' });
      const msg = { id: (r.nextMsg = (r.nextMsg || 0) + 1), role, name: label(r, role), body: text, at: now() };
      r.messages.push(msg); if (r.messages.length > 2000) r.messages.shift();
      save(); return send(res, 201, msg);
    }
  }

  if (act === 'files' && !sub && m === 'POST') {
    if (!open) return send(res, 403, { error: 'This room is closed' });
    if (r.files.length >= 100) return send(res, 400, { error: 'File limit reached' });
    const d = await json(req, Math.ceil(MAX_FILE * 1.4) + 2000);
    if (!d || typeof d.data !== 'string') return send(res, 400, { error: 'No file received' });
    const buf = Buffer.from(d.data, 'base64');
    if (!buf.length || buf.length > MAX_FILE) return send(res, 413, { error: 'File must be under 7 MB' });
    const f = { id: rid(), name: String(d.name || 'file').replace(/[^\w.\- ]/g, '_').slice(0, 100), size: buf.length, final: !!d.final && role !== 'client', by: role, at: now() };
    fs.writeFileSync(path.join(DATA, 'files', id + '-' + f.id), buf);
    r.files.push(f); save();
    return send(res, 201, view(r, role));
  }
  if (act === 'files' && sub && m === 'GET') {
    const f = r.files.find(x => x.id === sub);
    if (!f) return send(res, 404, { error: 'File not found' });
    if (!owner && !windowOpen(r)) return send(res, 403, { error: 'The download period has ended' });
    if (f.final && role === 'client' && !paidFull(r)) return send(res, 402, { error: 'Final files unlock after full payment' });
    const buf = fs.readFileSync(path.join(DATA, 'files', id + '-' + f.id));
    res.writeHead(200, Object.assign({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="' + f.name + '"', 'Content-Length': buf.length }, SEC));
    return res.end(buf);
  }

  if (act === 'approve' && m === 'POST') {
    if (role !== 'client') return send(res, 403, { error: 'Only the client can approve' });
    if (!open) return send(res, 403, { error: 'This room is closed' });
    r.approved = true; r.log.push([now(), 'client approved']); maybeClose(r);
    return send(res, 200, view(r, role));
  }

  if (!owner) return send(res, 403, { error: 'Not allowed' });   // everything below is for you only
  if (m !== 'POST') return send(res, 405, { error: 'Method not allowed' });
  const d = (await json(req)) || {};
  if (act === 'payment') { const out = pay(r, d.amount, d.reference); return send(res, out.code, out.body); }
  if (act === 'close') { if (open) closeRoom(r, 'closed by owner'); return send(res, 200, { status: r.status }); }
  if (act === 'extend') {
    const days = Math.min(365, Math.max(1, +d.days || 14));
    if (open) r.expiresAt += days * DAY;
    else if (r.reason !== 'approved and paid in full') { r.status = 'open'; r.closedAt = 0; r.reason = ''; r.expiresAt = now() + days * DAY; r.log.push([now(), 'reopened']); }
    else return send(res, 400, { error: 'This room finished normally and cannot be reopened' });
    save(); return send(res, 200, { status: r.status, expiresAt: r.expiresAt });
  }
  if (act === 'relink') {
    const role2 = d.role === 'developer' ? 'developer' : 'client', s = secret();
    r.tokens[role2] = sha(s); r.log.push([now(), 'new ' + role2 + ' link']); save();
    return send(res, 200, { token: id + '.' + s });
  }
  if (act === 'payurl') { r.payUrl = /^https:\/\//i.test(d.payUrl || '') ? clip(d.payUrl, 500) : ''; save(); return send(res, 200, { payUrl: r.payUrl }); }
  if (act === 'purge') { purgeRoom(r); return send(res, 200, { status: r.status }); }
  return send(res, 404, { error: 'Not found' });
}

exports.handle = (req, res, u) => {
  const p = u.pathname.replace(/\/+$/, '') || '/';
  if (pages[p] && req.method === 'GET') {
    res.writeHead(200, Object.assign({ 'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'" }, SEC));
    res.end(pages[p]); return true;
  }
  if (!u.pathname.startsWith('/api/rooms') && u.pathname !== '/api/webhooks/payment') return false;
  run(req, res, u).catch(e => { console.error('rooms:', e.message); if (!res.headersSent) send(res, 500, { error: 'Server error' }); });
  return true;
};

// Hourly: close expired rooms and delete files once the download period is over.
const sweep = () => { for (const r of Object.values(db.rooms)) { if (r.status === 'purged') continue; refresh(r); if (r.status === 'closed' && !windowOpen(r)) purgeRoom(r); } };
setInterval(sweep, 3600000); sweep();
