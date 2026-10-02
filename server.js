// ScaleDesk live job server. Needs Node 18 or newer. No packages to install.
const http = require('http');
const fs = require('fs');
const path = require('path');
const rooms = require('./rooms.js');

const PORT = process.env.PORT || 3000;
const ACCESS_KEY = process.env.ACCESS_KEY || '';
const ORIGIN = process.env.ALLOWED_ORIGIN || 'https://scale-desk.onrender.com';
const FL_TOKEN = process.env.FREELANCER_TOKEN || '';
const SOURCES = (process.env.SOURCES || 'freelancer,remoteok').split(',').map(s => s.trim()).filter(Boolean);
const KEYWORDS = (process.env.FREELANCER_KEYWORDS || 'website,wordpress,game,mobile app,web app,chatbot')
  .split(',').map(s => s.trim()).filter(Boolean);
const FL_EVERY = (+process.env.FREELANCER_EVERY_SECONDS || 60) * 1000;
const MAX_JOBS = 500;

const CATS = [
  ['Games', /game|unity|unreal|godot|roblox/i],
  ['Mobile apps', /mobile|android|ios|flutter|react native|swift|kotlin/i],
  ['AI and automation', /ai|machine learning|chatbot|openai|automation|llm|gpt/i],
  ['Websites', /website|wordpress|shopify|landing|webflow|wix|squarespace|html|css/i],
  ['Web apps', /web app|react|node|laravel|django|api|saas|dashboard|php|javascript|typescript|backend|fullstack/i]
];

function classify(text) {
  for (const [c, r] of CATS) if (r.test(text)) return c;
  return 'Web apps';
}

function strip(s) {
  return String(s || '').replace(/<[^>]*>/g, '').replace(/&[^;]+;/g, ' ').replace(/\s+/g, ' ').trim();
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJson(url, headers) {
  const r = await fetch(url, {
    headers: Object.assign({ 'User-Agent': 'ScaleDesk/1.0', Accept: 'application/json' }, headers || {}),
    signal: AbortSignal.timeout(15000)
  });
  if (!r.ok) throw new Error(url.split('?')[0] + ' returned ' + r.status);
  return r.json();
}

const jobs = new Map();
const clients = new Set();

function pushJob(j) {
  if (!j || !j.id || jobs.has(j.id)) return;
  jobs.set(j.id, j);
  if (jobs.size > MAX_JOBS) {
    const oldest = Array.from(jobs.keys())[0];
    jobs.delete(oldest);
  }
  const payload = 'data: ' + JSON.stringify(j) + '\n\n';
  for (const c of clients) c.write(payload);
}

async function fetchFreelancer() {
  for (const q of KEYWORDS) {
    try {
      const url = 'https://www.freelancer.com/api/projects/0.1/projects/active/?query=' +
        encodeURIComponent(q) + '&limit=20&job_details=true';
      const d = await getJson(url, FL_TOKEN ? { 'freelancer-oauth-v1': FL_TOKEN } : {});
      for (const p of (d.result && d.result.projects) || []) {
        const skills = (p.jobs || []).map(j => j.name).join(' ');
        const fullDescription = strip(p.preview_description || p.description || '');
        const shortSnippet = fullDescription.slice(0, 220);

        pushJob({
          id: 'freelancer:' + p.id,
          title: p.title,
          dir: shortSnippet,
          fullDesc: fullDescription,
          source: 'Freelancer',
          cat: classify(p.title + ' ' + shortSnippet + ' ' + skills),
          time: (p.time_submitted ? p.time_submitted * 1000 : Date.now()),
          url: p.seo_url ? ('https://www.freelancer.com/projects/' + p.seo_url) : ('https://www.freelancer.com/projects/' + p.id)
        });
      }
    } catch (e) {
      console.error('Freelancer error:', e.message);
    }
    await sleep(2000);
  }
}

async function fetchRemoteOk() {
  try {
    const data = await getJson('https://remoteok.com/api');
    for (const p of (Array.isArray(data) ? data.slice(1, 30) : [])) {
      if (!p || !p.id) continue;
      const fullDescription = strip(p.description || '');
      const shortSnippet = fullDescription.slice(0, 220);

      pushJob({
        id: 'remoteok:' + p.id,
        title: p.position + (p.company ? (' — ' + p.company) : ''),
        dir: shortSnippet,
        fullDesc: fullDescription,
        source: 'RemoteOK',
        cat: classify(p.position + ' ' + shortSnippet + ' ' + (p.tags || []).join(' ')),
        time: p.date ? new Date(p.date).getTime() : Date.now(),
        url: p.url || 'https://remoteok.com'
      });
    }
  } catch (e) {
    console.error('RemoteOK error:', e.message);
  }
}

const SRC = {
  freelancer: { fn: fetchFreelancer, every: FL_EVERY },
  remoteok: { fn: fetchRemoteOk, every: 300000 }
};

const lastRun = {};
for (const name of SOURCES) {
  const s = SRC[name];
  if (!s) { console.error('Unknown source:', name); continue; }
  const run = async () => {
    try { await s.fn(); lastRun[name] = new Date().toISOString(); }
    catch (e) { console.error(name, e.message); }
  };
  run();
  setInterval(run, s.every);
}

setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000);

// ---- Web server ----
const send = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.txt': 'text/plain'
};

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  res.setHeader('Access-Control-Allow-Origin', ORIGIN);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Headers': '*' });
    return res.end();
  }

  // API Endpoints
  if (u.pathname === '/api/health') return send(res, 200, { ok: true, jobs: jobs.size, sources: SOURCES, lastRun });
  if (rooms.handle(req, res, u)) return;
  if (ACCESS_KEY && u.searchParams.get('key') !== ACCESS_KEY) return send(res, 401, { error: 'Access key needed' });
  if (u.pathname === '/api/jobs') {
    return send(res, 200, [...jobs.values()].sort((a, b) => b.time - a.time).slice(0, 200));
  }
  if (u.pathname === '/api/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(': connected\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  // Static File Server (serves files from the /public folder)
  let file = u.pathname === '/' ? '/index.html' : u.pathname;
  let filePath = path.join(__dirname, 'public', file);

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    return res.end(fs.readFileSync(filePath));
  }

  // Fallback 404 for unknown routes
  send(res, 404, { error: 'Not found' });
}).listen(PORT, () => console.log('ScaleDesk server running on port ' + PORT));
