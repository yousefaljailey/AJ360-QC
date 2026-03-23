import express from 'express';
import { hashSync, compareSync } from 'bcryptjs';
import jwtPkg from 'jsonwebtoken';
const { sign, verify } = jwtPkg;
import { randomUUID } from 'crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');
const TMP_DIR      = '/tmp/aj360';
const SEED_DIR     = path.join(PROJECT_ROOT, 'data');
const JWT_SECRET   = 'aj360-internal-jwt-2026-secret';
const ADMIN_EMAIL  = 'algaileyy@aljazeera.net';

// Ensure /tmp/aj360 exists
if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });

// On cold start, copy seed data into /tmp so writes work
function initFile(name) {
  const tmp    = path.join(TMP_DIR, name);
  const seeded = path.join(SEED_DIR, name);
  if (!existsSync(tmp) && existsSync(seeded)) copyFileSync(seeded, tmp);
  return tmp;
}

const USERS_FILE = () => initFile('users.json');
const JOBS_FILE  = () => initFile('jobs.json');

// ── Data helpers ──────────────────────────────────────────────
function loadUsers() {
  const file = USERS_FILE();
  if (!existsSync(file)) {
    const store = { users: [makeAdmin()] };
    writeFileSync(file, JSON.stringify(store, null, 2));
    return store;
  }
  return JSON.parse(readFileSync(file, 'utf8'));
}
function saveUsers(store) { writeFileSync(USERS_FILE(), JSON.stringify(store, null, 2)); }

function makeAdmin() {
  return {
    id: randomUUID(), name: 'Youssef Al Gaiey', email: ADMIN_EMAIL,
    department: 'Administration',
    passwordHash: hashSync('Yy12345678!', 12),
    role: 'admin', status: 'approved', createdAt: new Date().toISOString()
  };
}

// Ensure admin always exists on cold start
(function ensureAdmin() {
  const store = loadUsers();
  if (!store.users.find(u => u.email === ADMIN_EMAIL)) {
    store.users.unshift(makeAdmin());
    saveUsers(store);
  }
})();

function loadJobs() {
  const file = JOBS_FILE();
  if (!existsSync(file)) { writeFileSync(file, JSON.stringify({ jobs: [] }, null, 2)); return { jobs: [] }; }
  return JSON.parse(readFileSync(file, 'utf8'));
}
function saveJobs(store) { writeFileSync(JOBS_FILE(), JSON.stringify(store, null, 2)); }

// ── Express app ───────────────────────────────────────────────
const app = express();
app.use(express.json());

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try { req.user = verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid or expired session. Please sign in again.' }); }
}

function adminOnly(req, res, next) {
  authMiddleware(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    next();
  });
}

function resultPage(title, icon, heading, body) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/><title>${title} — AJ360</title><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Segoe UI',sans-serif;background:#0B0C0E;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}.card{background:#161619;border:1px solid #262931;border-radius:16px;padding:48px 40px;max-width:440px;width:100%;text-align:center}.icon{font-size:40px;margin-bottom:16px}h2{font-size:22px;font-weight:700;margin-bottom:8px}p{color:#878787;font-size:15px;margin-bottom:6px}.back{display:inline-block;margin-top:28px;color:#22CFEE;font-size:14px;text-decoration:none;border:1px solid rgba(34,207,238,0.3);padding:10px 24px;border-radius:8px}</style></head><body><div class="card"><div class="icon">${icon}</div><h2>${heading}</h2>${body}<a href="/" class="back">← Back to AJ360</a></div></body></html>`;
}

// ── Auth routes ───────────────────────────────────────────────

app.post('/api/signup', (req, res) => {
  const { name, email, department, password } = req.body;
  if (!name || !email || !password)
    return res.status(400).json({ error: 'Name, email and password are required.' });
  if (!email.toLowerCase().endsWith('@aljazeera.net'))
    return res.status(400).json({ error: 'Only @aljazeera.net email addresses are allowed.' });
  if (password.length < 8)
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });

  const store = loadUsers();
  if (store.users.find(u => u.email.toLowerCase() === email.toLowerCase()))
    return res.status(409).json({ error: 'This email is already registered.' });

  const user = {
    id: randomUUID(), name: name.trim(), email: email.toLowerCase().trim(),
    department: (department || '').trim(), passwordHash: hashSync(password, 12),
    role: 'user', status: 'pending', createdAt: new Date().toISOString()
  };
  store.users.push(user);
  saveUsers(store);
  res.json({ success: true });
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: 'Email and password are required.' });

  const store = loadUsers();
  const user  = store.users.find(u => u.email.toLowerCase() === email.toLowerCase().trim());

  if (!user || !compareSync(password, user.passwordHash))
    return res.status(401).json({ error: 'Invalid email or password.' });
  if (user.status === 'pending')
    return res.status(403).json({ error: 'Your account is awaiting admin approval.' });
  if (user.status === 'rejected')
    return res.status(403).json({ error: 'Your access request was not approved. Contact algaileyy@aljazeera.net.' });

  const token = sign(
    { id: user.id, email: user.email, name: user.name, role: user.role },
    JWT_SECRET, { expiresIn: '8h' }
  );
  res.json({ success: true, token, user: { name: user.name, email: user.email, role: user.role } });
});

// ── Admin approve/reject via email link ───────────────────────

app.get('/api/admin/approve/:id', (req, res) => {
  const store = loadUsers();
  const user  = store.users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).send(resultPage('Not Found', '❓', 'User Not Found', '<p>This approval link is invalid or expired.</p>'));
  user.status = 'approved'; user.approvedAt = new Date().toISOString();
  saveUsers(store);
  res.send(resultPage('Access Approved', '✅', 'Access Approved',
    `<p><strong style="color:#fff">${user.name}</strong></p><p>${user.email}</p><p style="margin-top:12px;color:#22CFEE">has been granted access to Al Jazeera 360.</p>`));
});

app.get('/api/admin/reject/:id', (req, res) => {
  const store = loadUsers();
  const user  = store.users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).send(resultPage('Not Found', '❓', 'User Not Found', '<p>This link is invalid or expired.</p>'));
  user.status = 'rejected';
  saveUsers(store);
  res.send(resultPage('Access Rejected', '🚫', 'Access Rejected',
    `<p><strong style="color:#fff">${user.name}</strong></p><p>${user.email}</p><p style="margin-top:12px;color:#ff6b6b">has been denied access.</p>`));
});

// ── Admin user management ─────────────────────────────────────

app.get('/api/admin/users', adminOnly, (_req, res) => {
  const store = loadUsers();
  res.json(store.users.map(u => ({
    id: u.id, name: u.name, email: u.email, department: u.department,
    role: u.role, status: u.status, createdAt: u.createdAt, approvedAt: u.approvedAt
  })));
});

app.post('/api/admin/users/:id/approve', adminOnly, (req, res) => {
  const store = loadUsers();
  const user  = store.users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  user.status = 'approved'; user.approvedAt = new Date().toISOString();
  saveUsers(store); res.json({ success: true });
});

app.post('/api/admin/users/:id/reject', adminOnly, (req, res) => {
  const store = loadUsers();
  const user  = store.users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  user.status = 'rejected'; saveUsers(store); res.json({ success: true });
});

app.delete('/api/admin/users/:id', adminOnly, (req, res) => {
  const store = loadUsers();
  const idx   = store.users.findIndex(u => u.id === req.params.id && u.role !== 'admin');
  if (idx === -1) return res.status(404).json({ error: 'User not found or cannot delete admin' });
  store.users.splice(idx, 1); saveUsers(store); res.json({ success: true });
});

// ── Jobs routes ───────────────────────────────────────────────

app.get('/api/jobs', authMiddleware, (_req, res) => {
  const store = loadJobs();
  res.json(store.jobs.map(j => ({
    id: j.id, filename: j.filename, duration: j.duration, size: j.size,
    resolution: j.resolution, status: j.status, score: j.score,
    aj360Pass: j.aj360Pass, format: j.format,
    uploadedAt: j.uploadedAt, uploadedBy: j.uploadedBy
  })));
});

app.get('/api/jobs/:id', authMiddleware, (req, res) => {
  const store = loadJobs();
  const job   = store.jobs.find(j => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

app.delete('/api/jobs/:id', adminOnly, (req, res) => {
  const store = loadJobs();
  const idx   = store.jobs.findIndex(j => j.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  store.jobs.splice(idx, 1); saveJobs(store); res.json({ success: true });
});

// File upload is not supported on Vercel (no persistent disk + no ffmpeg).
// Return a clear error so the UI can handle it gracefully.
app.post('/api/jobs/upload', authMiddleware, (req, res) => {
  res.status(501).json({ error: 'File upload is not available on this deployment. Run the app locally for QC analysis.' });
});

// ── System health ─────────────────────────────────────────────

app.get('/api/system/health', authMiddleware, (_req, res) => {
  const store      = loadJobs();
  const completed  = store.jobs.filter(j => j.status === 'completed').length;
  const processing = store.jobs.filter(j => j.status === 'processing').length;
  const failed     = store.jobs.filter(j => j.status === 'completed' && j.aj360Pass === false).length;
  const avgScore   = completed
    ? Math.round(store.jobs.filter(j => j.score).reduce((a, b) => a + (b.score || 0), 0) / completed * 10) / 10
    : 0;
  res.json({
    status: 'operational', activeWorkers: 0, maxWorkers: 8,
    processing, queueDepth: processing,
    diskUsed: '—', diskTotal: '—', diskPct: 0,
    cpuPct: 0, memPct: 0, uptime: '—', version: 'v2.4.1',
    totalJobs: store.jobs.length, completedToday: completed,
    failedToday: failed, avgScore,
    passRate: completed ? Math.round((completed - failed) / completed * 1000) / 10 : 0
  });
});

export default app;
