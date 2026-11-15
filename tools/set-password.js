/* 管理员改密码：node tools/set-password.js <用户名> <新密码>
   直接改 data/users.json，并把该用户所有已登录会话作废。 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

const username = process.argv[2];
const password = process.argv[3];

if (!username || !password) {
  console.log('用法：node tools/set-password.js <用户名> <新密码>');
  process.exit(1);
}

let users;
try {
  users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
} catch (e) {
  console.error('读不到用户文件：' + USERS_FILE + '\n请先启动过一次服务。');
  process.exit(1);
}

const user = users.find(function (u) { return u.username === username && u.source === 'local'; });
if (!user) {
  console.error('没有找到本地账号：' + username);
  process.exit(1);
}

const salt = crypto.randomBytes(16).toString('hex');
user.salt = salt;
user.hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
user.tokenVersion = (user.tokenVersion || 0) + 1;

const tmp = USERS_FILE + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(users));
fs.renameSync(tmp, USERS_FILE);

console.log('已更新 ' + username + ' 的密码，旧会话已全部失效。');
