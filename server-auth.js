/* =========================================================
   后湖小区 · 美食地图 —— 部署版（带账号登录）
   零依赖 Node：静态托管 + 登录鉴权 + 数据接口 + SSE 实时推送

   认证方式：
     1) 本地账号（默认开启，管理员可在 /admin 管理）
     2) CAS 统一身份认证（配置 CAS_BASE_URL 即启用）
        CAS_BASE_URL=mock 时使用内置模拟 CAS，便于本地联调

   启动：node server-auth.js
   配置：见 deploy/.env.example
   ========================================================= */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

/* ---------------- 配置 ---------------- */
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const PORT = Number(process.env.PORT) || 8080;
const BASE_URL = (process.env.BASE_URL || 'http://localhost:' + PORT).replace(/\/$/, '');
const CAS_BASE = (process.env.CAS_BASE_URL || '').replace(/\/$/, '');
const CAS_SERVICE = process.env.CAS_SERVICE || BASE_URL + '/auth/cas/callback';
const ALLOW_LOCAL = process.env.ALLOW_LOCAL_LOGIN !== '0';
// 默认完全开放：任何人都能浏览和编辑。设 REQUIRE_LOGIN=1 才恢复「登录才能编辑」。
const REQUIRE_LOGIN = process.env.REQUIRE_LOGIN === '1';
const CAS_ADMIN_IDS = (process.env.CAS_ADMIN_IDS || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const SESSION_TTL = 7 * 24 * 3600 * 1000;
const MAX_BODY = 40 * 1024 * 1024;
const SECURE_COOKIE = /^https:/i.test(BASE_URL);

const MAP_FILE = path.join(DATA_DIR, 'map.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const SECRET_FILE = path.join(DATA_DIR, 'secret.key');

fs.mkdirSync(DATA_DIR, { recursive: true });

/* ---------------- 基础工具 ---------------- */
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}

function writeJson(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}

function uid() {
  return crypto.randomBytes(9).toString('base64url');
}

function nowIso() {
  return new Date().toISOString();
}

function loadSecret() {
  try { return fs.readFileSync(SECRET_FILE, 'utf8').trim(); } catch (e) { /* 首次运行 */ }
  const s = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(SECRET_FILE, s, { mode: 0o600 });
  return s;
}
const SECRET = loadSecret();

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}

function verifyPassword(password, user) {
  if (!user || !user.salt || !user.hash) return false;
  const h = Buffer.from(hashPassword(password, user.salt), 'hex');
  const a = Buffer.from(user.hash, 'hex');
  return h.length === a.length && crypto.timingSafeEqual(h, a);
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function unescapeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, function (m, d) { return String.fromCharCode(Number(d)); })
    .replace(/&amp;/g, '&');
}

/* ---------------- 数据 ---------------- */
let map = readJson(MAP_FILE, null);
if (!map) {
  // 从旧的局域网版 data.json 迁移一次
  const legacy = readJson(path.join(ROOT, 'data.json'), null);
  map = legacy && legacy.data
    ? { version: legacy.version || 1, updatedAt: legacy.updatedAt || Date.now(), by: '迁移', data: legacy.data }
    : { version: 0, updatedAt: 0, by: '', data: null };
  writeJson(MAP_FILE, map);
}

let users = readJson(USERS_FILE, null);
if (!Array.isArray(users)) {
  users = [];
  const pass = process.env.ADMIN_PASS || crypto.randomBytes(6).toString('base64url');
  const salt = crypto.randomBytes(16).toString('hex');
  users.push({
    id: uid(),
    username: process.env.ADMIN_USER || 'admin',
    name: process.env.ADMIN_NAME || '管理员',
    role: 'admin',
    source: 'local',
    salt: salt,
    hash: hashPassword(pass, salt),
    tokenVersion: 0,
    createdAt: nowIso()
  });
  writeJson(USERS_FILE, users);
  if (!process.env.ADMIN_PASS) {
    console.log('\n  已创建初始管理员账号');
    console.log('  用户名：' + (process.env.ADMIN_USER || 'admin'));
    console.log('  密　码：' + pass);
    console.log('  （密码只显示这一次，请立即登录后修改并妥善保存）\n');
  }
}

let history = readJson(HISTORY_FILE, []);
if (!Array.isArray(history)) history = [];

let usersMtime = 0;
function usersStamp() {
  try { return fs.statSync(USERS_FILE).mtimeMs; } catch (e) { return 0; }
}
usersMtime = usersStamp();

// 外部工具（tools/set-password.js）改过 users.json 后无需重启即可生效
function maybeReloadUsers() {
  const s = usersStamp();
  if (s && s !== usersMtime) {
    const fresh = readJson(USERS_FILE, null);
    if (Array.isArray(fresh) && fresh.length) {
      users = fresh;
      usersMtime = s;
    }
  }
}

function saveUsers() { writeJson(USERS_FILE, users); }
function saveMap() { writeJson(MAP_FILE, map); }
function pushHistory(by) {
  history.unshift({
    version: map.version,
    at: nowIso(),
    by: by,
    count: (map.data && map.data.buildings || []).reduce(function (s, b) { return s + (b.merchants || []).length; }, 0),
    data: map.data
  });
  if (history.length > 8) history.length = 8;
  writeJson(HISTORY_FILE, history);
}

/* ---------------- 会话 ---------------- */
const sseClients = new Set();
const loginAttempts = new Map();

function sign(s) {
  return crypto.createHmac('sha256', SECRET).update(s).digest('base64url');
}

function issueSession(user) {
  const payload = Buffer.from(JSON.stringify({
    uid: user.id,
    exp: Date.now() + SESSION_TTL,
    v: user.tokenVersion || 0
  })).toString('base64url');
  return payload + '.' + sign(payload);
}

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(function (part) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function currentUser(req) {
  const raw = parseCookies(req).sid;
  if (!raw) return null;
  const dot = raw.lastIndexOf('.');
  if (dot < 0) return null;
  const payload = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expect = sign(payload);
  if (sig.length !== expect.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;

  let body;
  try { body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch (e) { return null; }
  if (!body || !body.exp || body.exp < Date.now()) return null;
  const user = users.find(function (u) { return u.id === body.uid; });
  if (!user) return null;
  if ((user.tokenVersion || 0) !== body.v) return null;
  return user;
}

function cookieHeader(token, maxAge) {
  return 'sid=' + token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxAge + (SECURE_COOKIE ? '; Secure' : '');
}

function clearCookieHeader() {
  return 'sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' + (SECURE_COOKIE ? '; Secure' : '');
}

function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xff) return xff;
  }
  return req.socket.remoteAddress || 'unknown';
}

function rateLimited(ip) {
  const now = Date.now();
  const rec = loginAttempts.get(ip) || { n: 0, reset: now + 10 * 60 * 1000 };
  if (now > rec.reset) { rec.n = 0; rec.reset = now + 10 * 60 * 1000; }
  return rec.n >= 6;
}

function noteFailure(ip) {
  const rec = loginAttempts.get(ip) || { n: 0, reset: Date.now() + 10 * 60 * 1000 };
  rec.n += 1;
  loginAttempts.set(ip, rec);
}

/* ---------------- HTTP 工具 ---------------- */
function json(res, code, obj, headers) {
  const body = JSON.stringify(obj);
  const h = Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  }, headers || {});
  res.writeHead(code, h);
  res.end(body);
}

function html(res, code, body) {
  res.writeHead(code, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function redirect(res, location, headers) {
  res.writeHead(302, Object.assign({ Location: location, 'Cache-Control': 'no-store' }, headers || {}));
  res.end();
}

function readBody(req, res, done) {
  let size = 0;
  const chunks = [];
  req.on('data', function (c) {
    size += c.length;
    if (size > MAX_BODY) {
      res.writeHead(413); res.end('too large'); req.destroy(); return;
    }
    chunks.push(c);
  });
  req.on('end', function () { done(Buffer.concat(chunks).toString('utf8')); });
  req.on('error', function () { try { res.writeHead(400); res.end(); } catch (e) {} });
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // curl / 同源 GET 无 Origin
  try {
    return new URL(origin).host === new URL(BASE_URL).host;
  } catch (e) { return false; }
}

function publicUser(u) {
  return u ? { id: u.id, name: u.name, username: u.username, role: u.role } : null;
}

function canEdit(u) {
  return !!u && (u.role === 'admin' || u.role === 'editor');
}

/* ---------------- CAS ---------------- */
const tickets = new Map();

function casEnabled() { return CAS_BASE !== ''; }
function casIsMock() { return CAS_BASE === 'mock'; }

async function casValidate(ticket) {
  if (casIsMock()) {
    const t = tickets.get(ticket);
    if (!t || t.exp < Date.now()) return null;
    tickets.delete(ticket);
    return t.user;
  }
  const u = CAS_BASE + '/serviceValidate?service=' + encodeURIComponent(CAS_SERVICE) + '&ticket=' + encodeURIComponent(ticket);
  const res = await fetch(u, { headers: { Accept: 'text/xml' } });
  const xml = await res.text();
  if (!/<cas:authenticationSuccess/i.test(xml)) return null;
  const casUser = unescapeXml((/<cas:user>([\s\S]*?)<\/cas:user>/i.exec(xml) || [])[1] || '').trim();
  if (!casUser) return null;
  const name = unescapeXml((/<cas:name>([\s\S]*?)<\/cas:name>/i.exec(xml) || [])[1] || '').trim();
  const mail = unescapeXml((/<cas:mail>([\s\S]*?)<\/cas:mail>/i.exec(xml) || [])[1] || '').trim();
  return { id: casUser, name: name || casUser, mail: mail };
}

function upsertCasUser(info) {
  let user = users.find(function (u) { return u.source === 'cas' && u.username === info.id; });
  if (!user) {
    user = {
      id: uid(),
      username: info.id,
      name: info.name || info.id,
      role: CAS_ADMIN_IDS.indexOf(info.id) >= 0 ? 'admin' : 'editor',
      source: 'cas',
      salt: '',
      hash: '',
      tokenVersion: 0,
      createdAt: nowIso(),
      lastLogin: nowIso()
    };
    users.push(user);
    saveUsers();
  } else {
    user.name = info.name || user.name;
    user.lastLogin = nowIso();
    if (CAS_ADMIN_IDS.indexOf(info.id) >= 0) user.role = 'admin';
    saveUsers();
  }
  return user;
}

/* ---------------- 页面模板 ---------------- */
const PAGE_CSS = [
  '*{box-sizing:border-box}',
  'body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(120% 90% at 50% 0%,#eef5fc,#dce9f6);',
  'font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;color:#12222f}',
  '.card{width:min(420px,92vw);background:#fff;border:1px solid #d7e5f3;border-radius:18px;padding:30px 28px;',
  'box-shadow:0 24px 60px rgba(0,57,110,.14)}',
  '.brand{display:flex;align-items:center;gap:10px;margin-bottom:18px}',
  '.brand b{font-size:17px;color:#00376b;letter-spacing:.02em}',
  '.brand span{display:block;font-size:11px;color:#7c93ab;letter-spacing:.14em}',
  'h1{font-size:20px;margin:0 0 6px;color:#00376b}',
  'p.sub{margin:0 0 20px;color:#7c93ab;font-size:12.5px;line-height:1.7}',
  'label{display:block;font-size:12px;color:#5c7690;margin:14px 0 6px;letter-spacing:.06em}',
  'input{width:100%;height:42px;padding:0 12px;border:1px solid #d7e5f3;border-radius:10px;font:inherit;font-size:14px;outline:none}',
  'input:focus{border-color:#9fc3e6;box-shadow:0 0 0 4px rgba(0,87,168,.08)}',
  'button{width:100%;height:44px;margin-top:18px;border:none;border-radius:10px;font:inherit;font-weight:600;font-size:14px;',
  'background:linear-gradient(180deg,#0a6bc4,#0057a8);color:#fff;cursor:pointer;letter-spacing:.04em}',
  'button.ghost{background:#fff;border:1px solid #d7e5f3;color:#0057a8;margin-top:10px}',
  '.err{margin-top:14px;padding:9px 12px;border-radius:9px;background:#fdecea;color:#b3271c;font-size:12.5px}',
  '.foot{margin-top:20px;font-size:11px;color:#9aafc4;line-height:1.8;text-align:center}',
  'table{width:100%;border-collapse:collapse;font-size:13px}',
  'th,td{padding:10px 8px;text-align:left;border-bottom:1px solid #eef3f9}',
  'th{font-size:11px;color:#7c93ab;font-weight:600;letter-spacing:.08em}',
  'select{height:32px;border:1px solid #d7e5f3;border-radius:8px;font:inherit;font-size:12.5px;padding:0 6px}',
  'td form{display:inline}',
  'td button{width:auto;height:32px;margin:0;padding:0 14px;font-size:12.5px}',
  '.wide{width:min(880px,94vw)}'
].join('');

function emblem() {
  return '<svg width="38" height="38" viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="31" fill="#0057A8"/>' +
    '<circle cx="32" cy="32" r="26.5" fill="none" stroke="#fff" stroke-opacity=".5" stroke-width="1.1" stroke-dasharray="2 3.2"/>' +
    '<text x="32" y="39.6" text-anchor="middle" font-size="17" font-weight="700" fill="#fff" font-family="serif">中南</text></svg>';
}

function loginPage(err, next) {
  const sso = casEnabled()
    ? '<a href="/auth/cas/login?next=' + encodeURIComponent(next || '/') + '"><button class="ghost" type="button">使用中南大学统一身份认证登录</button></a>'
    : '';
  const localForm = ALLOW_LOCAL
    ? '<form method="post" action="/login">' +
      (next ? '<input type="hidden" name="next" value="' + escapeHtml(next) + '">' : '') +
      '<label>账号</label><input name="username" autocomplete="username" required>' +
      '<label>密码</label><input name="password" type="password" autocomplete="current-password" required>' +
      '<button type="submit">登录</button></form>'
    : '';
  return '<!doctype html><html lang="zh-CN"><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"><title>登录 · 后湖小区美食地图</title>' +
    '<style>' + PAGE_CSS + '</style><body><div class="card">' +
    '<div class="brand">' + emblem() + '<div><b>后湖小区 · 美食地图</b><span>清水路 · 社区美食</span></div></div>' +
    '<h1>登录后编辑</h1><p class="sub">浏览不需要登录；添加、修改、删除商户需要登录。</p>' +
    (err ? '<div class="err">' + escapeHtml(err) + '</div>' : '') +
    localForm + sso +
    '<div class="foot">仅限校内使用 · 请勿分享账号</div></div></body></html>';
}

function adminPage(me, msg) {
  const rows = users.map(function (u) {
    const opt = ['viewer', 'editor', 'admin'].map(function (r) {
      return '<option value="' + r + '"' + (u.role === r ? ' selected' : '') + '>' +
        ({ viewer: '只读', editor: '可编辑', admin: '管理员' })[r] + '</option>';
    }).join('');
    return '<tr><td><b>' + escapeHtml(u.name) + '</b><br><span style="color:#8fa6bc;font-size:11px">' +
      escapeHtml(u.username) + ' · ' + (u.source === 'cas' ? '统一认证' : '本地') + '</span></td>' +
      '<td><form method="post" action="/admin/role">' +
      '<input type="hidden" name="id" value="' + escapeHtml(u.id) + '">' +
      '<select name="role">' + opt + '</select> <button type="submit">保存</button></form></td>' +
      '<td style="color:#8fa6bc;font-size:11px">' + escapeHtml((u.lastLogin || u.createdAt || '').slice(0, 16).replace('T', ' ')) + '</td></tr>';
  }).join('');

  const hist = history.map(function (h) {
    return '<tr><td>v' + h.version + '</td><td>' + escapeHtml(h.by) + '</td><td>' + h.count + ' 家</td>' +
      '<td style="color:#8fa6bc;font-size:11px">' + escapeHtml(h.at.slice(0, 16).replace('T', ' ')) + '</td>' +
      '<td><form method="post" action="/admin/rollback" onsubmit="return confirm(\'回滚到 v' + h.version + '？\' )">' +
      '<input type="hidden" name="version" value="' + h.version + '"><button type="submit">回滚</button></form></td></tr>';
  }).join('') || '<tr><td colspan="5" style="color:#9aafc4">还没有历史版本</td></tr>';

  return '<!doctype html><html lang="zh-CN"><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"><title>管理 · 后湖小区美食地图</title>' +
    '<style>' + PAGE_CSS + '.wide{margin:30px auto}</style><body><div class="card wide">' +
    '<div class="brand">' + emblem() + '<div><b>管理后台</b><span>后湖小区 · 美食地图</span></div></div>' +
    (msg ? '<div class="err" style="background:#e9f6ef;color:#1f7a52">' + escapeHtml(msg) + '</div>' : '') +
    '<h1>成员权限</h1><table><tr><th>成员</th><th>权限</th><th>最近登录</th></tr>' + rows + '</table>' +
    '<h1 style="margin-top:28px">版本历史</h1><table><tr><th>版本</th><th>修改人</th><th>商户数</th><th>时间</th><th></th></tr>' + hist + '</table>' +
    '<div class="foot"><a href="/">返回地图</a> · <a href="/logout">退出登录</a></div></div></body></html>';
}

/* ---------------- 路由 ---------------- */
const server = http.createServer(function (req, res) {
  let parsed;
  try { parsed = new URL(req.url, BASE_URL); } catch (e) { return json(res, 400, { error: 'bad-url' }); }
  const p = parsed.pathname;

  maybeReloadUsers();

  /* ---- 当前身份 ---- */
  if (p === '/api/me') {
    if (!REQUIRE_LOGIN) {
      return json(res, 200, { auth: false, canEdit: true, open: true });
    }
    const u = currentUser(req);
    return json(res, 200, {
      auth: true,
      user: publicUser(u),
      canEdit: canEdit(u),
      sso: { enabled: casEnabled(), mock: casIsMock(), local: ALLOW_LOCAL }
    });
  }

  /* ---- 登录 / 退出 ---- */
  if (p === '/login' && req.method === 'POST') {
    const next = '/';
    if (!ALLOW_LOCAL) return redirect(res, '/login');
    return readBody(req, res, function (body) {
      const form = new URLSearchParams(body);
      const username = (form.get('username') || '').trim();
      const password = form.get('password') || '';
      const ip = clientIp(req);
      if (rateLimited(ip)) return html(res, 429, loginPage('尝试次数过多，请 10 分钟后再试', next));
      const user = users.find(function (u) { return u.username === username && u.source === 'local'; });
      if (!user || !verifyPassword(password, user)) {
        noteFailure(ip);
        return html(res, 401, loginPage('账号或密码不正确', next));
      }
      user.lastLogin = nowIso();
      saveUsers();
      res.writeHead(302, { Location: '/', 'Set-Cookie': cookieHeader(issueSession(user), SESSION_TTL / 1000) });
      res.end();
    });
  }

  if (p === '/login') {
    if (currentUser(req)) return redirect(res, '/');
    return html(res, 200, loginPage('', parsed.searchParams.get('next') || '/'));
  }

  if (p === '/logout') {
    return redirect(res, '/', { 'Set-Cookie': clearCookieHeader() });
  }

  /* ---- CAS ---- */
  if (p === '/auth/cas/login') {
    if (!casEnabled()) return redirect(res, '/login');
    const next = parsed.searchParams.get('next') || '/';
    const service = CAS_SERVICE + '?state=' + encodeURIComponent(next);
    const target = casIsMock()
      ? '/mock-cas/login?service=' + encodeURIComponent(service)
      : CAS_BASE + '/login?service=' + encodeURIComponent(service);
    return redirect(res, target);
  }

  if (p === '/auth/cas/callback') {
    const ticket = parsed.searchParams.get('ticket') || '';
    const state = parsed.searchParams.get('state') || '/';
    if (!ticket) return html(res, 400, loginPage('缺少 ticket，请重新登录', '/'));
    casValidate(ticket).then(function (info) {
      if (!info) return html(res, 401, loginPage('统一认证校验失败，请重试', '/'));
      const user = upsertCasUser(info);
      res.writeHead(302, { Location: state, 'Set-Cookie': cookieHeader(issueSession(user), SESSION_TTL / 1000) });
      res.end();
    }).catch(function () {
      html(res, 502, loginPage('暂时无法连接统一认证服务，请稍后再试', '/'));
    });
    return;
  }

  /* ---- 模拟 CAS（仅 CAS_BASE_URL=mock 时可用） ---- */
  if (p === '/mock-cas/login') {
    if (!casIsMock()) return json(res, 404, { error: 'not-found' });
    const service = parsed.searchParams.get('service') || '';
    const auto = parsed.searchParams.get('auto');
    if (auto) {   // 联调用：跳过表单直接发 ticket
      const ticket = 'ST-' + crypto.randomBytes(8).toString('hex');
      tickets.set(ticket, { user: { id: auto, name: '张同学' }, exp: Date.now() + 60000 });
      const to = service + (service.indexOf('?') >= 0 ? '&' : '?') + 'ticket=' + encodeURIComponent(ticket);
      return redirect(res, to);
    }
    if (req.method === 'POST') {
      return readBody(req, res, function (body) {
        const form = new URLSearchParams(body);
        const user = (form.get('username') || '').trim();
        if (!user) return html(res, 400, '<p>请输入学号</p>');
        const ticket = 'ST-' + crypto.randomBytes(8).toString('hex');
        tickets.set(ticket, { user: { id: user, name: (form.get('name') || user).trim() }, exp: Date.now() + 60000 });
        const to = service + (service.indexOf('?') >= 0 ? '&' : '?') + 'ticket=' + encodeURIComponent(ticket);
        return redirect(res, to);
      });
    }
    return html(res, 200,
      '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>模拟统一认证</title><style>' + PAGE_CSS + '</style>' +
      '<body><div class="card"><h1>模拟统一身份认证</h1>' +
      '<p class="sub">这是本地联调用的模拟门户，正式部署时把 CAS_BASE_URL 换成学校地址即可。</p>' +
      '<form method="post" action="/mock-cas/login?service=' + encodeURIComponent(service) + '">' +
      '<label>学号 / 工号</label><input name="username" value="20230001" required>' +
      '<label>姓名（可选）</label><input name="name" value="张同学">' +
      '<button type="submit">登录并返回</button></form></div></body></html>');
  }

  if (p === '/mock-cas/serviceValidate') {
    if (!casIsMock()) return json(res, 404, { error: 'not-found' });
    const t = tickets.get(parsed.searchParams.get('ticket') || '');
    res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
    if (!t || t.exp < Date.now()) {
      return res.end('<?xml version="1.0"?><cas:serviceResponse xmlns:cas="http://www.yale.edu/tp/cas"><cas:authenticationFailure code="INVALID_TICKET"/></cas:serviceResponse>');
    }
    return res.end('<?xml version="1.0"?><cas:serviceResponse xmlns:cas="http://www.yale.edu/tp/cas"><cas:authenticationSuccess>' +
      '<cas:user>' + escapeHtml(t.user.id) + '</cas:user><cas:attributes><cas:name>' + escapeHtml(t.user.name) + '</cas:name></cas:attributes>' +
      '</cas:authenticationSuccess></cas:serviceResponse>');
  }

  /* ---- 数据接口 ---- */
  if (p === '/api/data') {
    if (req.method === 'GET') {
      return json(res, 200, { version: map.version, updatedAt: map.updatedAt, data: map.data });
    }
    if (req.method === 'PUT') {
      const user = currentUser(req);
      if (REQUIRE_LOGIN) {
        if (!user) return json(res, 401, { error: 'login-required' });
        if (!canEdit(user)) return json(res, 403, { error: 'read-only' });
      }
      if (!sameOrigin(req)) return json(res, 403, { error: 'bad-origin' });
      return readBody(req, res, function (body) {
        let payload;
        try { payload = JSON.parse(body); } catch (e) { return json(res, 400, { error: 'bad-json' }); }
        const data = payload && payload.data;
        if (!data || !Array.isArray(data.buildings)) return json(res, 400, { error: 'bad-data' });
        const by = (user && (user.name || user.username)) || '访客';
        map = { version: map.version + 1, updatedAt: Date.now(), by: by, data: data };
        saveMap();
        pushHistory(map.by);
        broadcast();
        return json(res, 200, { version: map.version, updatedAt: map.updatedAt });
      });
    }
    return json(res, 405, { error: 'method-not-allowed' });
  }

  if (p === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write('retry: 3000\n\n');
    res.write('event: hello\ndata: ' + JSON.stringify({ version: map.version }) + '\n\n');
    sseClients.add(res);
    const ping = setInterval(function () { try { res.write(': ping\n\n'); } catch (e) {} }, 25000);
    req.on('close', function () { clearInterval(ping); sseClients.delete(res); });
    return;
  }

  /* ---- 管理后台 ---- */
  if (p === '/admin') {
    const u = currentUser(req);
    if (!u) return redirect(res, '/login?next=/admin');
    if (u.role !== 'admin') return html(res, 403, '<p style="font-family:sans-serif;padding:40px">只有管理员可以访问。</p>');
    return html(res, 200, adminPage(u, parsed.searchParams.get('msg')));
  }

  if (p === '/admin/role' && req.method === 'POST') {
    const u = currentUser(req);
    if (!u || u.role !== 'admin') return json(res, 403, { error: 'forbidden' });
    if (!sameOrigin(req)) return json(res, 403, { error: 'bad-origin' });
    return readBody(req, res, function (body) {
      const form = new URLSearchParams(body);
      const id = form.get('id');
      const role = form.get('role');
      if (['viewer', 'editor', 'admin'].indexOf(role) < 0) return redirect(res, '/admin');
      const target = users.find(function (x) { return x.id === id; });
      if (target) {
        target.role = role;
        target.tokenVersion = (target.tokenVersion || 0) + 1; // 让该用户重新登录以刷新权限
        saveUsers();
      }
      return redirect(res, '/admin?msg=' + encodeURIComponent('权限已更新'));
    });
  }

  if (p === '/admin/rollback' && req.method === 'POST') {
    const u = currentUser(req);
    if (!u || u.role !== 'admin') return json(res, 403, { error: 'forbidden' });
    return readBody(req, res, function (body) {
      const form = new URLSearchParams(body);
      const v = Number(form.get('version'));
      const item = history.find(function (h) { return h.version === v; });
      if (item && item.data) {
        map = { version: map.version + 1, updatedAt: Date.now(), by: (u.name || '管理员') + '（回滚）', data: item.data };
        saveMap();
        pushHistory(map.by);
        broadcast();
      }
      return redirect(res, '/admin?msg=' + encodeURIComponent('已回滚到 v' + v));
    });
  }

  /* ---- 静态文件 ---- */
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 404, { error: 'not-found' });

  let file = p === '/' ? '/index.html' : p;
  try { file = decodeURIComponent(file); } catch (e) { return json(res, 404, { error: 'not-found' }); }

  const blocked = /^\/(data|deploy)(\/|$)/.test(file) || /^\/(server|server-auth)\.js$/.test(file) || file === '/.env';
  if (blocked) return json(res, 404, { error: 'not-found' });

  const abs = path.join(ROOT, path.normalize(file).replace(/^([/\\])+/, ''));
  if (!abs.startsWith(ROOT)) return json(res, 404, { error: 'not-found' });

  fs.stat(abs, function (err, st) {
    if (err || !st.isFile()) return json(res, 404, { error: 'not-found' });
    const ext = path.extname(abs).toLowerCase();
    const mime = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon'
    }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime, 'Content-Length': st.size, 'Cache-Control': 'no-cache' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(abs).pipe(res);
  });
});

function broadcast() {
  const msg = 'event: update\ndata: ' + JSON.stringify({ version: map.version }) + '\n\n';
  sseClients.forEach(function (res) {
    try { res.write(msg); } catch (e) { sseClients.delete(res); }
  });
}

server.listen(PORT, function () {
  const lines = ['', '  后湖小区 · 美食地图（部署版）已启动', ''];
  lines.push('  本机：   ' + BASE_URL);
  Object.keys(os.networkInterfaces()).forEach(function (name) {
    (os.networkInterfaces()[name] || []).forEach(function (n) {
      if (n.family === 'IPv4' && !n.internal) lines.push('  局域网： http://' + n.address + ':' + PORT);
    });
  });
  lines.push('');
  lines.push('  权限：' + (REQUIRE_LOGIN ? '需要登录才能编辑' : '完全开放（任何人都可编辑）'));
  lines.push('  认证：本地账号' + (ALLOW_LOCAL ? '已开启' : '已关闭') +
    (casEnabled() ? ' ｜ CAS ' + (casIsMock() ? '（模拟模式）' : CAS_BASE) : ' ｜ CAS 未配置') +
    (REQUIRE_LOGIN ? '' : ' ｜ 当前未启用'));
  lines.push('  数据：' + DATA_DIR);
  lines.push('');
  console.log(lines.join('\n'));
});
