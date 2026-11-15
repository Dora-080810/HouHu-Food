/* =========================================================
   后湖小区 · 美食地图 —— 同步服务
   零依赖 Node 服务：托管静态文件 + 一个 JSON 数据接口 + SSE 推送
   启动：node server.js    （默认 8080，可用 PORT 环境变量改）
   ========================================================= */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, 'data.json');
const PORT = Number(process.env.PORT) || 8080;
const MAX_BODY = 40 * 1024 * 1024; // 40MB，够放几十张压缩图

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

let db = readDb();
const clients = new Set();

function readDb() {
  try {
    const j = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (j && typeof j.version === 'number' && j.data) return j;
  } catch (e) { /* 第一次运行还没有数据文件 */ }
  return { version: 0, updatedAt: 0, data: null };
}

function writeDb(next) {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next));
  fs.renameSync(tmp, DATA_FILE);
}

function broadcast() {
  const msg = 'event: update\ndata: ' + JSON.stringify({ version: db.version }) + '\n\n';
  for (const res of clients) {
    try { res.write(msg); } catch (e) { clients.delete(res); }
  }
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('not found');
}

function readBody(req, res, done) {
  let size = 0;
  const chunks = [];
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BODY) {
      res.writeHead(413, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('too large');
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => done(Buffer.concat(chunks).toString('utf8')));
  req.on('error', () => notFound(res));
}

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch (e) {
    return notFound(res);
  }
  const p = url.pathname;

  /* ---------- 数据接口 ---------- */
  if (p === '/api/data') {
    if (req.method === 'GET') {
      return json(res, 200, { version: db.version, updatedAt: db.updatedAt, data: db.data });
    }
    if (req.method === 'PUT') {
      return readBody(req, res, (body) => {
        let payload;
        try { payload = JSON.parse(body); } catch (e) { return json(res, 400, { error: 'bad-json' }); }
        if (!payload || typeof payload.data !== 'object' || payload.data === null) {
          return json(res, 400, { error: 'no-data' });
        }
        const next = { version: db.version + 1, updatedAt: Date.now(), data: payload.data };
        try { writeDb(next); } catch (e) { return json(res, 500, { error: 'write-failed' }); }
        db = next;
        broadcast();
        return json(res, 200, { version: db.version, updatedAt: db.updatedAt });
      });
    }
    return json(res, 405, { error: 'method-not-allowed' });
  }

  /* ---------- 实时推送 ---------- */
  if (p === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write('retry: 3000\n\n');
    res.write('event: hello\ndata: ' + JSON.stringify({ version: db.version }) + '\n\n');
    clients.add(res);

    const ping = setInterval(() => {
      try { res.write(': ping\n\n'); } catch (e) { /* ignore */ }
    }, 25000);

    req.on('close', () => {
      clearInterval(ping);
      clients.delete(res);
    });
    return;
  }

  /* ---------- 静态文件 ---------- */
  if (req.method !== 'GET' && req.method !== 'HEAD') return notFound(res);

  let file = p === '/' ? '/index.html' : p;
  try { file = decodeURIComponent(file); } catch (e) { return notFound(res); }
  const abs = path.join(ROOT, path.normalize(file).replace(/^([/\\])+/, ''));
  if (!abs.startsWith(ROOT)) return notFound(res);

  fs.stat(abs, (err, st) => {
    if (err || !st.isFile()) return notFound(res);
    const ext = path.extname(abs).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache'
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(abs).pipe(res);
  });
});

server.listen(PORT, () => {
  const lines = ['', '  后湖小区 · 美食地图  已启动', ''];
  lines.push('  本机：   http://localhost:' + PORT);
  const nets = os.networkInterfaces();
  Object.keys(nets).forEach((name) => {
    (nets[name] || []).forEach((n) => {
      if (n.family === 'IPv4' && !n.internal) {
        lines.push('  局域网： http://' + n.address + ':' + PORT + '   (手机用这个)');
      }
    });
  });
  lines.push('');
  lines.push('  数据文件：' + DATA_FILE);
  lines.push('  按 Ctrl+C 停止');
  lines.push('');
  console.log(lines.join('\n'));
});
