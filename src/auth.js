'use strict';

// Lightweight authentication: scrypt password hashing (Node built-in crypto)
// and in-memory sessions keyed by an httpOnly cookie. No external dependencies.
const crypto = require('node:crypto');
const { db } = require('./db');

const COOKIE = 'docket_sid';
const sessions = new Map(); // sid -> { userId, created }

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return { hash, salt };
}

function verifyPassword(password, hash, salt) {
  if (!hash || !salt) return false;
  const candidate = crypto.scryptSync(String(password), salt, 32).toString('hex');
  const a = Buffer.from(candidate, 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function findUserByEmail(email) {
  return db.prepare('SELECT * FROM users WHERE lower(email) = lower(?) AND active = 1').get(email);
}

function getUser(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function login(email, password) {
  const user = findUserByEmail(email);
  if (!user || !verifyPassword(password, user.password_hash, user.password_salt)) return null;
  const sid = crypto.randomBytes(24).toString('hex');
  sessions.set(sid, { userId: user.id, created: Date.now() });
  return sid;
}

function logout(sid) {
  if (sid) sessions.delete(sid);
}

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Resolve the authenticated user for a request (or null).
function currentUser(req) {
  const sid = parseCookies(req)[COOKIE];
  if (!sid) return null;
  const sess = sessions.get(sid);
  if (!sess) return null;
  const user = getUser(sess.userId);
  return user && user.active ? user : null;
}

function setSessionCookie(res, sid) {
  res.setHeader('Set-Cookie',
    `${COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 12}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function sidFromReq(req) {
  return parseCookies(req)[COOKIE];
}

const ROLE_RANK = { public: 0, member: 1, staff: 2, clerk: 3 };

function hasRole(user, min) {
  return !!user && (ROLE_RANK[user.role] || 0) >= (ROLE_RANK[min] || 0);
}

// Seed default accounts if none exist. Clerk + one login per active person.
function ensureSeedAccounts() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (count > 0) return;
  const insert = db.prepare(`INSERT INTO users (person_id, name, email, role, password_hash, password_salt)
    VALUES (?,?,?,?,?,?)`);

  const clerkPerson = db.prepare("SELECT * FROM people WHERE title = 'City Clerk'").get();
  const clerk = hashPassword('clerk1234');
  insert.run(clerkPerson ? clerkPerson.id : null, clerkPerson ? clerkPerson.full_name : 'City Clerk',
    'clerk@city.gov', 'clerk', clerk.hash, clerk.salt);

  // Board members get member logins (email already on the person record).
  const members = db.prepare(
    "SELECT * FROM people WHERE email LIKE '%@city.gov' AND title != 'City Clerk'").all();
  for (const p of members) {
    if (!p.email) continue;
    const role = p.title === 'Mayor' ? 'staff' : 'member';
    const pw = hashPassword('member1234');
    try { insert.run(p.id, p.full_name, p.email, role, pw.hash, pw.salt); } catch (_) { /* dup */ }
  }
}

module.exports = {
  COOKIE, hashPassword, verifyPassword, login, logout, currentUser,
  setSessionCookie, clearSessionCookie, sidFromReq, hasRole, getUser,
  findUserByEmail, ensureSeedAccounts, ROLE_RANK,
};
