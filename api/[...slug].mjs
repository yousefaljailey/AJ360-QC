/**
 * Vercel catch-all serverless handler for /api/*
 * Uses req.query.slug for routing instead of Express (which breaks in Vercel catch-all)
 */
import { hashSync, compareSync } from 'bcryptjs';
import jwtPkg from 'jsonwebtoken';
const { sign, verify } = jwtPkg;
import { randomUUID } from 'crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname    = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');
const TMP_DIR      = '/tmp/aj360';
const SEED_DIR     = path.join(PROJECT_ROOT, 'data');
const JWT_SECRET   = 'aj360-internal-jwt-2026-secret';
const ADMIN_EMAIL  = 'algaileyy@aljazeera.net';

if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });

// ── Data helpers ──────────────────────────────────────────────
function getFile(name) {
  const tmp  = path.join(TMP_DIR, name);
  const seed = path.join(SEED_DIR, name);
  if (!existsSync(tmp) && existsSync(seed)) copyFileSync(seed, tmp);
  return tmp;
}

function loadUsers() {
  const f = getFile('users.json');
  if (!existsSync(f)) {
    const store = { users: [makeAdmin()] };
    writeFileSync(f, JSON.stringify(store, null, 2));
    return store;
  }
  return JSON.parse(readFileSync(f, 'utf8'));
}
function saveUsers(s) { writeFileSync(getFile('users.json'), JSON.stringify(s, null, 2)); }

function makeAdmin() {
  return {
    id: randomUUID(), name: 'Youssef Al Gaiey', email: ADMIN_EMAIL,
    department: 'Administration', passwordHash: hashSync('Yy12345678!', 12),
    role: 'admin', status: 'approved', createdAt: new Date().toISOString()
  };
}

function loadJobs() {
  const f = getFile('jobs.json');
  if (!existsSync(f)) return { jobs: [] };
  return JSON.parse(readFileSync(f, 'utf8'));
}
function saveJobs(s) { writeFileSync(getFile('jobs.json'), JSON.stringify(s, null, 2)); }

// Ensure admin exists once per warm instance
let _adminEnsured = false;
function ensureAdmin() {
  if (_adminEnsured) return;
  _adminEnsured = true;
  const store = loadUsers();
  if (!store.users.find(u => u.email === ADMIN_EMAIL)) {
    store.users.unshift(makeAdmin());
    saveUsers(store);
  }
}

function verifyToken(req) {
  const auth = req.headers.authorization || req.headers.Authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) return null;
  try { return verify(token, JWT_SECRET); } catch { return null; }
}

function resultPage(icon, heading, body) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"/><title>${heading} — AJ360</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Segoe UI',sans-serif;background:#0B0C0E;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}.card{background:#161619;border:1px solid #262931;border-radius:16px;padding:48px 40px;max-width:440px;width:100%;text-align:center}.icon{font-size:40px;margin-bottom:16px}h2{font-size:22px;font-weight:700;margin-bottom:8px}p{color:#878787;font-size:15px;margin-bottom:6px}.back{display:inline-block;margin-top:28px;color:#22CFEE;font-size:14px;text-decoration:none;border:1px solid rgba(34,207,238,0.3);padding:10px 24px;border-radius:8px}</style>
</head><body><div class="card"><div class="icon">${icon}</div><h2>${heading}</h2>${body}<a href="/" class="back">← Back to AJ360</a></div></body></html>`;
}

// ── Main handler ──────────────────────────────────────────────
export default async function handler(req, res) {
  ensureAdmin();

  // slug is ['login'], ['jobs'], ['jobs','JB_123'], ['admin','users'], etc.
  const method = req.method;
  // Parse route from req.url (works regardless of which Vercel function entry point is used)
  const urlPath = (req.url || '').split('?')[0];
  const apiPath = urlPath.replace(/^\/api\//, '').replace(/^\/api$/, '');
  const slug    = apiPath ? apiPath.split('/') : [];
  // Parse body — Vercel auto-parses JSON but guard against edge cases
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  if (!body || typeof body !== 'object') body = {};

  // ── POST /api/login ────────────────────────────────────────
  if (method === 'POST' && slug[0] === 'login') {
    const { email, password } = body;
    if (!email || !password)
      return res.status(400).json({ error: 'Email and password are required.' });

    const store = loadUsers();
    const user  = store.users.find(u => u.email.toLowerCase() === String(email).toLowerCase().trim());

    if (!user || !compareSync(String(password), user.passwordHash))
      return res.status(401).json({ error: 'Invalid email or password.' });
    if (user.status === 'pending')
      return res.status(403).json({ error: 'Your account is awaiting admin approval.' });
    if (user.status === 'rejected')
      return res.status(403).json({ error: 'Your access request was not approved. Contact algaileyy@aljazeera.net.' });

    const token = sign(
      { id: user.id, email: user.email, name: user.name, role: user.role },
      JWT_SECRET, { expiresIn: '8h' }
    );
    return res.json({ success: true, token, user: { name: user.name, email: user.email, role: user.role } });
  }

  // ── POST /api/signup ───────────────────────────────────────
  if (method === 'POST' && slug[0] === 'signup') {
    const { name, email, department, password } = body;
    if (!name || !email || !password)
      return res.status(400).json({ error: 'Name, email and password are required.' });
    if (!String(email).toLowerCase().endsWith('@aljazeera.net'))
      return res.status(400).json({ error: 'Only @aljazeera.net email addresses are allowed.' });
    if (String(password).length < 8)
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });

    const store = loadUsers();
    if (store.users.find(u => u.email.toLowerCase() === String(email).toLowerCase()))
      return res.status(409).json({ error: 'This email is already registered.' });

    const user = {
      id: randomUUID(), name: String(name).trim(), email: String(email).toLowerCase().trim(),
      department: String(department || '').trim(), passwordHash: hashSync(String(password), 12),
      role: 'user', status: 'pending', createdAt: new Date().toISOString()
    };
    store.users.push(user);
    saveUsers(store);
    return res.json({ success: true });
  }

  // ── GET /api/admin/approve/:id  (email link, no auth) ─────
  if (method === 'GET' && slug[0] === 'admin' && slug[1] === 'approve' && slug[2]) {
    const store = loadUsers();
    const user  = store.users.find(u => u.id === slug[2]);
    if (!user) {
      res.setHeader('Content-Type', 'text/html');
      return res.status(404).send(resultPage('❓', 'User Not Found', '<p>This approval link is invalid or expired.</p>'));
    }
    user.status = 'approved'; user.approvedAt = new Date().toISOString();
    saveUsers(store);
    res.setHeader('Content-Type', 'text/html');
    return res.send(resultPage('✅', 'Access Approved',
      `<p><strong style="color:#fff">${user.name}</strong></p><p>${user.email}</p><p style="margin-top:12px;color:#22CFEE">has been granted access to Al Jazeera 360.</p>`));
  }

  // ── GET /api/admin/reject/:id  (email link, no auth) ──────
  if (method === 'GET' && slug[0] === 'admin' && slug[1] === 'reject' && slug[2]) {
    const store = loadUsers();
    const user  = store.users.find(u => u.id === slug[2]);
    if (!user) {
      res.setHeader('Content-Type', 'text/html');
      return res.status(404).send(resultPage('❓', 'Not Found', '<p>Invalid link.</p>'));
    }
    user.status = 'rejected';
    saveUsers(store);
    res.setHeader('Content-Type', 'text/html');
    return res.send(resultPage('🚫', 'Access Rejected',
      `<p><strong style="color:#fff">${user.name}</strong></p><p>${user.email}</p><p style="margin-top:12px;color:#ff6b6b">has been denied access.</p>`));
  }

  // ── All routes below require auth ──────────────────────────
  const me = verifyToken(req);
  if (!me) return res.status(401).json({ error: 'Unauthorized' });
  const isAdmin = me.role === 'admin';

  // ── GET /api/admin/users ───────────────────────────────────
  if (method === 'GET' && slug[0] === 'admin' && slug[1] === 'users' && !slug[2]) {
    if (!isAdmin) return res.status(403).json({ error: 'Admin access required' });
    const store = loadUsers();
    return res.json(store.users.map(u => ({
      id: u.id, name: u.name, email: u.email, department: u.department,
      role: u.role, status: u.status, createdAt: u.createdAt, approvedAt: u.approvedAt
    })));
  }

  // ── POST /api/admin/users/:id/approve ─────────────────────
  if (method === 'POST' && slug[0] === 'admin' && slug[1] === 'users' && slug[2] && slug[3] === 'approve') {
    if (!isAdmin) return res.status(403).json({ error: 'Admin access required' });
    const store = loadUsers();
    const user  = store.users.find(u => u.id === slug[2]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    user.status = 'approved'; user.approvedAt = new Date().toISOString();
    saveUsers(store);
    return res.json({ success: true });
  }

  // ── POST /api/admin/users/:id/reject ──────────────────────
  if (method === 'POST' && slug[0] === 'admin' && slug[1] === 'users' && slug[2] && slug[3] === 'reject') {
    if (!isAdmin) return res.status(403).json({ error: 'Admin access required' });
    const store = loadUsers();
    const user  = store.users.find(u => u.id === slug[2]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    user.status = 'rejected'; saveUsers(store);
    return res.json({ success: true });
  }

  // ── DELETE /api/admin/users/:id ───────────────────────────
  if (method === 'DELETE' && slug[0] === 'admin' && slug[1] === 'users' && slug[2]) {
    if (!isAdmin) return res.status(403).json({ error: 'Admin access required' });
    const store = loadUsers();
    const idx   = store.users.findIndex(u => u.id === slug[2] && u.role !== 'admin');
    if (idx === -1) return res.status(404).json({ error: 'User not found or cannot delete admin' });
    store.users.splice(idx, 1); saveUsers(store);
    return res.json({ success: true });
  }

  // ── GET /api/jobs ──────────────────────────────────────────
  if (method === 'GET' && slug[0] === 'jobs' && !slug[1]) {
    const store = loadJobs();
    return res.json(store.jobs.map(j => ({
      id: j.id, filename: j.filename, duration: j.duration, size: j.size,
      resolution: j.resolution, status: j.status, score: j.score,
      aj360Pass: j.aj360Pass, format: j.format,
      uploadedAt: j.uploadedAt, uploadedBy: j.uploadedBy
    })));
  }

  // ── POST /api/jobs/upload ──────────────────────────────────
  if (method === 'POST' && slug[0] === 'jobs' && slug[1] === 'upload') {
    return res.status(501).json({ error: 'File upload is not available on this deployment. Run the app locally for QC analysis.' });
  }

  // ── GET /api/jobs/:id ──────────────────────────────────────
  if (method === 'GET' && slug[0] === 'jobs' && slug[1]) {
    const store = loadJobs();
    const job   = store.jobs.find(j => j.id === slug[1]);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    return res.json(job);
  }

  // ── DELETE /api/jobs/:id ───────────────────────────────────
  if (method === 'DELETE' && slug[0] === 'jobs' && slug[1]) {
    if (!isAdmin) return res.status(403).json({ error: 'Admin access required' });
    const store = loadJobs();
    const idx   = store.jobs.findIndex(j => j.id === slug[1]);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    store.jobs.splice(idx, 1); saveJobs(store);
    return res.json({ success: true });
  }

  // ── GET /api/system/health ─────────────────────────────────
  if (method === 'GET' && slug[0] === 'system' && slug[1] === 'health') {
    const store      = loadJobs();
    const completed  = store.jobs.filter(j => j.status === 'completed').length;
    const processing = store.jobs.filter(j => j.status === 'processing').length;
    const failed     = store.jobs.filter(j => j.status === 'completed' && j.aj360Pass === false).length;
    const avgScore   = completed
      ? Math.round(store.jobs.filter(j => j.score).reduce((a, b) => a + (b.score || 0), 0) / completed * 10) / 10
      : 0;
    return res.json({
      status: 'operational', activeWorkers: 0, maxWorkers: 8,
      processing, queueDepth: processing,
      diskUsed: '—', diskTotal: '—', diskPct: 0,
      cpuPct: 0, memPct: 0, uptime: '—', version: 'v2.4.1',
      totalJobs: store.jobs.length, completedToday: completed,
      failedToday: failed, avgScore,
      passRate: completed ? Math.round((completed - failed) / completed * 1000) / 10 : 0
    });
  }

  return res.status(404).json({ error: `Route not found: ${method} /api/${slug.join('/')}` });
}
