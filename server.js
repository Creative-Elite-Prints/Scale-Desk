// ScaleDesk live job server. Needs Node 18 or newer. No packages to install.
const http = require('http');
const fs = require('fs');
const path = require('path');
const rooms = require('./rooms');

const PORT = process.env.PORT || 3000;
const ACCESS_KEY = process.env.ACCESS_KEY || '';
const ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const FL_TOKEN = process.env.FREELANCER_TOKEN || '';
const SOURCES = (process.env.SOURCES || 'freelancer,remoteok').split(',').map(s => s.trim()).filter(Boolean);
const KEYWORDS = (process.env.FREELANCER_KEYWORDS || 'website,wordpress,game,mobile app,web app,chatbot')
  .split(',').map(s => s.trim()).filter(Boolean);
const FL_EVERY = (+process.env.FREELANCER_EVERY_SECONDS || 60) * 1000;
const MAX_JOBS = 500;

const CATS = [
  ['Games', /game|unity|unreal|godot|roblox/i],
  ['Mobile apps', /mobile|android|\bios\b|flutter|react native|swift|kotlin/i],
  ['AI and automation', /\bai\b|machine learning|chatbot|openai|automation|\bllm\b|gpt/i],
  ['Websites', /website|wordpress|shopify|landing|webflow|wix|squarespace|\bseo\b|html|css/i],
  ['Web apps', /web app|react|node|laravel|django|\bapi\b|saas|dashboard|php|javascript|typescript|backend|full.?stack/i]
];
const classify = text => { for (const [c, r] of CATS) if (r.test(text)) return c; return 'Web apps'; };
const strip = s => String(s || '').replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
const safeUrl = u => (/^https:\/\//i.test(u || '') ? u : '');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJson(url, headers) {
  const r = await fetch(url, {
    headers: Object.assign({ 'User-Agent': 'ScaleDesk/1.0', Accept: 'application/json' }, headers || {}),
    signal: AbortSignal.timeout(15000)
  });
  if (!r.ok) throw new Error(url.split('?')[0] + ' returned ' + r.status);
  return r.json();
}

// Freelancer.com
async function freelancer() {
  const out = [];
  for (const q of KEYWORDS) {
    try {
      const url = 'https://www.freelancer.com/api/projects/0.1/projects/active/?query=' +
        encodeURIComponent(q) + '&limit=20&job_details=true';
      const d = await getJson(url, FL_TOKEN ? { 'freelancer-oauth-v1': FL_TOKEN } : {});
      for (const p of (d.result && d.result.projects) || []) {
        const skills = (p.jobs || []).map(j => j.name).join(' ');
        const fullDesc = strip(p.preview_description || p.description || '');
        const shortSnippet = fullDesc.slice(0, 220);
        out.push({
          key: 'freelancer:' + p.id,
          t: p.title,
          d: (p.type === 'hourly' ? 'Hourly rate. ' : '') + shortSnippet,
          fullDesc: fullDesc,
          b: 0,
          s: 'Freelancer',
          loc: '',
          t0: (p.time_submitted ? p.time_submitted * 1000 : Date.now()),
          url: safeUrl('https://www.freelancer.com/projects/' + (p.seo_url || p.id)),
          c: classify(p.title + ' ' + shortSnippet + ' ' + skills)
        });
      }
    } catch (e) { console.error('freelancer', q, e.message); }
    await sleep(1000);
  }
  return out;
}

// RemoteOK
async function remoteok() {
  const a = await getJson('https://remoteok.com/api');
  return a.slice(1).filter(j => j && j.id).map(j => {
    const fullDesc = strip(j.description || '');
    return {
      key: 'remoteok:' + j.id,
      t: (j.position || 'Remote job') + (j.company ? ' at ' + j.company : ''),
      d: fullDesc.slice(0, 220),
      fullDesc: fullDesc,
      b: 0,
      s: 'RemoteOK',
      loc: j.location || 'Remote',
      t0: (j.epoch ? j.epoch * 1000 : Date.parse(j.date)) || Date.now(),
      url: safeUrl(j.url),
      c: classify((j.position || '') + ' ' + (j.tags || []).join(' '))
    };
  });
}

// Remotive
async function remotive() {
  const d = await getJson('https://remotive.com/api/remote-jobs?category=software-dev&limit=50');
  return (d.jobs || []).map(j => {
    const fullDesc = strip(j.description || '');
    return {
      key: 'remotive:' + j.id,
      t: j.title + (j.company_name ? ' at ' + j.company_name : ''),
      d: fullDesc.slice(0, 220),
      fullDesc: fullDesc,
      b: 0,
      s: 'Remotive',
      loc: j.candidate_required_location || 'Remote',
      t0: Date.parse(j.publication_date) || Date.now(),
      url: safeUrl(j.url),
      c: classify(j.title + ' ' + (j.tags || []).join(' '))
    };
  });
}

const SRC = {
  freelancer: { fn: freelancer, every: FL_EVERY },
  remoteok: { fn: remoteok, every: 15 * 60 * 1000 },
  remotive: { fn: remotive, every: 6 * 60 * 60 * 1000 }
};

const jobs = new Map();
const clients = new Set();
const lastRun = {};

function broadcast(list) {
  const msg = 'data: ' + JSON.stringify(list) + '\n\n';
  for (const res of clients) res.write(msg);
}

function ingest(list) {
  const fresh = [];
  for (const j of list) {
    if (!j.url || jobs.has(j.key)) continue;
    jobs.set(j.key, j);
    fresh.push(j);
  }
  if (jobs.size > MAX_JOBS) {
    const keep = [...jobs.values()].sort((a, b) => b.t0 - a.t0).slice(0, MAX_JOBS);
    jobs.clear();
    keep.forEach(j => jobs.set(j.key, j));
  }
  if (fresh.length) broadcast(fresh);
}

for (const name of SOURCES) {
  const s = SRC[name];
  if (!s) { console.error('Unknown source:', name); continue; }
  const run = async () => {
    try { ingest(await s.fn()); lastRun[name] = new Date().toISOString(); }
    catch (e) { console.error(name, e.message); }
  };
  run();
  setInterval(run, s.every);
}

setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000);

const send = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  res.setHeader('Access-Control-Allow-Origin', ORIGIN);
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Headers': '*' }); return res.end(); }
  if (u.pathname === '/api/health') return send(res, 200, { ok: true, jobs: jobs.size, sources: SOURCES, lastRun });
  if (rooms.handle(req, res, u)) return;
  if (ACCESS_KEY && u.searchParams.get('key') !== ACCESS_KEY) return send(res, 401, { error: 'Access key needed' });
  if (u.pathname === '/api/jobs') {
    return send(res, 200, [...jobs.values()].sort((a, b) => b.t0 - a.t0).slice(0, 200));
  }
  if (u.pathname === '/api/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(': connected\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  // Serve static files from the /public folder
  let file = u.pathname === '/' ? '/index.html' : u.pathname;
  let filePath = path.join(__dirname, 'public', file);

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg' };
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
    return res.end(fs.readFileSync(filePath));
  }

  send(res, 404, { error: 'Not found' });
}).listen(PORT, () => console.log('ScaleDesk server running on port ' + PORT + ' with sources: ' + SOURCES.join(', ')));
