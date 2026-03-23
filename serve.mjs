import express from 'express';
import nodemailerPkg from 'nodemailer';
const { createTransport } = nodemailerPkg;
import { hashSync, compareSync } from 'bcryptjs';
import jwtPkg from 'jsonwebtoken';
const { sign, verify } = jwtPkg;
import { randomUUID } from 'crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import multer from 'multer';
import { analyzeFile } from './qc-analyzer.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3000;
const JWT_SECRET = 'aj360-internal-jwt-2026-secret';
const ADMIN_EMAIL = 'algaileyy@aljazeera.net';
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'users.json');

// Ensure data directory
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR);

function loadUsers() {
  if (!existsSync(DATA_FILE)) {
    const store = {
      users: [{
        id: randomUUID(),
        name: 'Youssef Al Gaiey',
        email: ADMIN_EMAIL,
        department: 'Administration',
        passwordHash: hashSync('Yy12345678!', 12),
        role: 'admin',
        status: 'approved',
        createdAt: new Date().toISOString()
      }]
    };
    writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
    return store;
  }
  return JSON.parse(readFileSync(DATA_FILE, 'utf8'));
}

function saveUsers(store) {
  writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
}

// Ensure admin exists on every start
(function ensureAdmin() {
  const store = loadUsers();
  if (!store.users.find(u => u.email === ADMIN_EMAIL)) {
    store.users.unshift({
      id: randomUUID(),
      name: 'Youssef Al Gaiey',
      email: ADMIN_EMAIL,
      department: 'Administration',
      passwordHash: hashSync('Yy12345678!', 12),
      role: 'admin',
      status: 'approved',
      createdAt: new Date().toISOString()
    });
    saveUsers(store);
  }
})();

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

// ── Nodemailer (Office 365) ──
const mailer = createTransport({
  host: 'smtp.office365.com',
  port: 587,
  secure: false,
  auth: { user: ADMIN_EMAIL, pass: process.env.EMAIL_PASS || '' },
  tls: { rejectUnauthorized: false }
});

async function sendApprovalEmail(user) {
  const approveUrl = `http://localhost:${PORT}/api/admin/approve/${user.id}`;
  const rejectUrl  = `http://localhost:${PORT}/api/admin/reject/${user.id}`;
  await mailer.sendMail({
    from: ADMIN_EMAIL,
    to:   ADMIN_EMAIL,
    subject: `[AJ360] New Access Request: ${user.name}`,
    html: `
<!DOCTYPE html><html><head><meta charset="UTF-8"/></head><body style="margin:0;padding:24px;background:#0B0C0E;font-family:'Segoe UI',sans-serif">
<div style="max-width:560px;margin:0 auto;background:#161619;border:1px solid #262931;border-radius:16px;overflow:hidden">
  <div style="padding:28px 32px;background:#0F0F12;border-bottom:1px solid #262931">
    <h2 style="margin:0;font-size:18px;color:#22CFEE">New Access Request — Al Jazeera 360</h2>
  </div>
  <div style="padding:28px 32px">
    <p style="color:#878787;margin:0 0 20px 0">An employee has requested access to the internal platform:</p>
    <table style="width:100%;border-collapse:collapse">
      <tr><td style="padding:8px 0;color:#878787;width:130px">Name</td><td style="padding:8px 0;color:#fff;font-weight:600">${user.name}</td></tr>
      <tr><td style="padding:8px 0;color:#878787">Email</td><td style="padding:8px 0;color:#fff">${user.email}</td></tr>
      <tr><td style="padding:8px 0;color:#878787">Department</td><td style="padding:8px 0;color:#fff">${user.department || '—'}</td></tr>
      <tr><td style="padding:8px 0;color:#878787">Requested</td><td style="padding:8px 0;color:#fff">${new Date().toLocaleString('en-GB')}</td></tr>
    </table>
    <div style="margin-top:28px">
      <a href="${approveUrl}" style="display:inline-block;background:#22CFEE;color:#000;padding:12px 28px;border-radius:8px;font-weight:700;text-decoration:none;margin-right:12px">✓ Approve Access</a>
      <a href="${rejectUrl}"  style="display:inline-block;background:transparent;color:#ff6b6b;padding:12px 28px;border-radius:8px;font-weight:700;text-decoration:none;border:1px solid #ff4444">✗ Reject</a>
    </div>
    <p style="margin-top:24px;color:#555;font-size:12px">Or manage all users from the Admin Panel after signing in at <a href="http://localhost:${PORT}" style="color:#22CFEE">localhost:${PORT}</a></p>
  </div>
  <div style="padding:16px 32px;background:#0B0C0E;border-top:1px solid #262931">
    <p style="color:#444;font-size:12px;margin:0">Al Jazeera 360 · Internal Tool · Confidential</p>
  </div>
</div>
</body></html>`
  });
}

// ── Auth Middleware ──
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

// ── Response page helper ──
function resultPage(title, iconClass, heading, body) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${title} — AJ360</title><link rel="preconnect" href="https://fonts.googleapis.com"/><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet"/><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Inter',sans-serif;background:#0B0C0E;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}.card{background:#161619;border:1px solid #262931;border-radius:16px;padding:48px 40px;max-width:440px;width:100%;text-align:center}.icon{font-size:40px;margin-bottom:16px}h2{font-size:22px;font-weight:700;margin-bottom:8px}p{color:#878787;font-size:15px;margin-bottom:6px}.back{display:inline-block;margin-top:28px;color:#22CFEE;font-size:14px;text-decoration:none;border:1px solid rgba(34,207,238,0.3);padding:10px 24px;border-radius:8px;transition:background 0.2s}.back:hover{background:rgba(34,207,238,0.08)}</style></head><body><div class="card"><div class="icon">${iconClass}</div><h2>${heading}</h2>${body}<a href="/" class="back">← Back to AJ360</a></div></body></html>`;
}

// ═══════════════════════════════════════════
//  API ROUTES
// ═══════════════════════════════════════════

// POST /api/signup
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
    id: randomUUID(),
    name: name.trim(),
    email: email.toLowerCase().trim(),
    department: (department || '').trim(),
    passwordHash: hashSync(password, 12),
    role: 'user',
    status: 'pending',
    createdAt: new Date().toISOString()
  };
  store.users.push(user);
  saveUsers(store);

  sendApprovalEmail(user).catch(err => {
    console.log(`\n[AJ360] New signup: ${user.name} <${user.email}>`);
    console.log(`[AJ360] Email delivery failed (${err.message})`);
    console.log(`[AJ360] Approve: GET http://localhost:${PORT}/api/admin/approve/${user.id}`);
    console.log(`[AJ360] Reject:  GET http://localhost:${PORT}/api/admin/reject/${user.id}\n`);
  });

  res.json({ success: true });
});

// POST /api/login
app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: 'Email and password are required.' });

  const store = loadUsers();
  const user = store.users.find(u => u.email.toLowerCase() === email.toLowerCase().trim());

  if (!user || !compareSync(password, user.passwordHash))
    return res.status(401).json({ error: 'Invalid email or password.' });
  if (user.status === 'pending')
    return res.status(403).json({ error: 'Your account is awaiting admin approval.' });
  if (user.status === 'rejected')
    return res.status(403).json({ error: 'Your access request was not approved. Contact algaileyy@aljazeera.net.' });

  const token = sign(
    { id: user.id, email: user.email, name: user.name, role: user.role },
    JWT_SECRET,
    { expiresIn: '8h' }
  );
  res.json({ success: true, token, user: { name: user.name, email: user.email, role: user.role } });
});

// GET /api/admin/approve/:id  (email link — no auth, admin only knows URL)
app.get('/api/admin/approve/:id', (req, res) => {
  const store = loadUsers();
  const user = store.users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).send(resultPage('Not Found', '❓', 'User Not Found', '<p>This approval link is invalid or expired.</p>'));
  user.status = 'approved';
  user.approvedAt = new Date().toISOString();
  saveUsers(store);
  res.send(resultPage('Access Approved', '✅', 'Access Approved', `<p><strong style="color:#fff">${user.name}</strong></p><p>${user.email}</p><p style="margin-top:12px;color:#22CFEE">has been granted access to Al Jazeera 360.</p>`));
});

// GET /api/admin/reject/:id
app.get('/api/admin/reject/:id', (req, res) => {
  const store = loadUsers();
  const user = store.users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).send(resultPage('Not Found', '❓', 'User Not Found', '<p>This link is invalid or expired.</p>'));
  user.status = 'rejected';
  saveUsers(store);
  res.send(resultPage('Access Rejected', '🚫', 'Access Rejected', `<p><strong style="color:#fff">${user.name}</strong></p><p>${user.email}</p><p style="margin-top:12px;color:#ff6b6b">has been denied access.</p>`));
});

// GET /api/admin/users  (protected)
app.get('/api/admin/users', adminOnly, (_req, res) => {
  const store = loadUsers();
  res.json(store.users.map(u => ({
    id: u.id, name: u.name, email: u.email,
    department: u.department, role: u.role,
    status: u.status, createdAt: u.createdAt, approvedAt: u.approvedAt
  })));
});

// POST /api/admin/users/:id/approve
app.post('/api/admin/users/:id/approve', adminOnly, (req, res) => {
  const store = loadUsers();
  const user = store.users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  user.status = 'approved';
  user.approvedAt = new Date().toISOString();
  saveUsers(store);
  res.json({ success: true });
});

// POST /api/admin/users/:id/reject
app.post('/api/admin/users/:id/reject', adminOnly, (req, res) => {
  const store = loadUsers();
  const user = store.users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  user.status = 'rejected';
  saveUsers(store);
  res.json({ success: true });
});

// DELETE /api/admin/users/:id
app.delete('/api/admin/users/:id', adminOnly, (req, res) => {
  const store = loadUsers();
  const idx = store.users.findIndex(u => u.id === req.params.id && u.role !== 'admin');
  if (idx === -1) return res.status(404).json({ error: 'User not found or cannot delete admin' });
  store.users.splice(idx, 1);
  saveUsers(store);
  res.json({ success: true });
});

// ═══════════════════════════════════════════
//  JOBS / QC ROUTES
// ═══════════════════════════════════════════

const JOBS_FILE    = path.join(DATA_DIR, 'jobs.json');
const UPLOADS_DIR  = path.join(__dirname, 'uploads');
if (!existsSync(UPLOADS_DIR)) mkdirSync(UPLOADS_DIR);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename:    (_req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 * 1024 } });

function loadJobs() {
  if (!existsSync(JOBS_FILE)) {
    const seed = { jobs: seedJobs() };
    writeFileSync(JOBS_FILE, JSON.stringify(seed, null, 2));
    return seed;
  }
  return JSON.parse(readFileSync(JOBS_FILE, 'utf8'));
}
function saveJobs(store) { writeFileSync(JOBS_FILE, JSON.stringify(store, null, 2)); }

function seedJobs() {
  const now = Date.now();
  return [
    makeSeedJob('AJA_DOHA_PKG_001.mxf',     '18:32', '42.1 GB', '3840x2160', 'completed', 100, true,  now - 3600000*2),
    makeSeedJob('SPORT_FINAL_MASTER.mov',    '45:10', '118.3 GB','3840x2160', 'completed',  32, false, now - 3600000*3),
    makeSeedJob('NEWS_REPORT_EP44.mxf',      '08:47', '21.6 GB', '3840x2160', 'processing',null,null, now - 3600000),
    makeSeedJob('DOCUMENTARY_ROUGH_CUT.mp4', '1:12:05','247.8 GB','3840x2160','processing',null,null, now - 1800000),
    makeSeedJob('BREAKING_NEWS_0316.mxf',    '03:22', '8.4 GB',  '3840x2160', 'completed',  84, true,  now - 900000),
  ];
}

function makeSeedJob(filename, duration, size, resolution, status, score, aj360Pass, ts) {
  const id  = 'JB_' + Math.floor(ts/1000).toString(16).toUpperCase().slice(-8);
  const ext = filename.split('.').pop().toLowerCase();
  const report = status === 'completed' ? buildSeedReport(filename, score, aj360Pass, resolution, size) : null;
  return { id, filename, duration, size, resolution, status, score, aj360Pass,
           format: ext.toUpperCase(), uploadedAt: new Date(ts).toISOString(),
           uploadedBy: ADMIN_EMAIL, report };
}

function buildSeedReport(filename, score, aj360Pass, resolution, size) {
  const ext   = filename.split('.').pop().toLowerCase();
  const isMxf = ext === 'mxf';

  // Per-check pass/fail based on file type
  const fmtOk    = isMxf;
  const resOk    = resolution === '3840x2160';
  const fpsOk    = isMxf;                   // MOV assumed wrong fps
  const arOk     = true;
  const codecOk  = isMxf;
  const srOk     = isMxf;
  const tracksOk = isMxf;
  const loudVal  = isMxf ? -23.1 : -18.5;
  const loudOk   = loudVal >= -24 && loudVal <= -22;

  // Black frames: SPORT_FINAL_MASTER has some, passing MXF has none
  const blackFrames = (!isMxf) ? [
    { start:'00:04:11:12', end:'00:04:11:22', duration:'0.40s' },
    { start:'00:22:07:03', end:'00:22:07:18', duration:'0.60s' },
    { start:'01:01:44:00', end:'01:01:45:10', duration:'1.40s' },
  ] : [];

  const checks = {
    format:      { label:'File Format',          icon:'📄', pass:fmtOk,   value:ext.toUpperCase(),       expected:'MXF' },
    resolution:  { label:'Resolution',           icon:'🖥',  pass:resOk,   value:resolution,              expected:'3840×2160 (UHD)' },
    frameRate:   { label:'Frame Rate',           icon:'🎞',  pass:fpsOk,   value:isMxf?'25.00 fps':'29.97 fps', expected:'25 fps' },
    aspectRatio: { label:'Aspect Ratio',         icon:'📐', pass:arOk,    value:'16:9',                  expected:'16:9' },
    audioCodec:  { label:'Audio Codec',          icon:'🔊', pass:codecOk, value:isMxf?'PCM_S24LE':'AAC', expected:'PCM 24-bit (pcm_s24le)' },
    sampleRate:  { label:'Sample Rate',          icon:'〰', pass:srOk,    value:isMxf?'48000 Hz':'44100 Hz', expected:'48,000 Hz' },
    audioTracks: {
      label:'Audio Tracks', icon:'🎚', pass:tracksOk,
      value: isMxf ? '4 tracks' : '2 tracks',
      expected:'4 tracks: Left / Right / Left Mix Minus / Right Mix Minus',
      tracks: isMxf
        ? [{index:1,label:'Left',expected:'Left',codec:'pcm_s24le',sampleRate:'48000',channels:1,layout:'mono',codecOk:true,sampleOk:true},
           {index:2,label:'Right',expected:'Right',codec:'pcm_s24le',sampleRate:'48000',channels:1,layout:'mono',codecOk:true,sampleOk:true},
           {index:3,label:'Left Mix Minus',expected:'Left Mix Minus',codec:'pcm_s24le',sampleRate:'48000',channels:1,layout:'mono',codecOk:true,sampleOk:true},
           {index:4,label:'Right Mix Minus',expected:'Right Mix Minus',codec:'pcm_s24le',sampleRate:'48000',channels:1,layout:'mono',codecOk:true,sampleOk:true}]
        : [{index:1,label:'Left',expected:'Left',codec:'aac',sampleRate:'44100',channels:2,layout:'stereo',codecOk:false,sampleOk:false},
           {index:2,label:'Right',expected:'Right',codec:'aac',sampleRate:'44100',channels:2,layout:'stereo',codecOk:false,sampleOk:false}]
    },
    loudness:    { label:'Loudness (EBU R128)', icon:'📊', pass:loudOk,  value:`${loudVal} LUFS`, expected:'-23 LUFS (±1 LU)', measured:loudVal, lra:'6.4 LU', truePeak:isMxf?'-1.2 dBFS':'-0.3 dBFS' },
    blackFrames: { label:'Black Frames',        icon:'⬛', pass:blackFrames.length===0, count:blackFrames.length, timecodes:blackFrames, expected:'No black frames' },
  };

  return {
    checks, overallPass: aj360Pass,
    aj360Pass, score,
    passedCount: Object.values(checks).filter(c=>c.pass).length,
    failedCount:  Object.values(checks).filter(c=>!c.pass).length,
    fileInfo: {
      format: ext.toUpperCase(), fileSize: size, resolution,
      videoCodec: isMxf ? 'DNXHD' : 'H.264',
      bitRate: isMxf ? '185 Mbps' : '51.3 Mbps',
      frameRate: isMxf ? '25.00 fps' : '29.97 fps',
    },
    audioInfo: {
      codec: isMxf ? 'PCM_S24LE' : 'AAC',
      sampleRate: isMxf ? '48000 Hz' : '44100 Hz',
      channels: isMxf ? 4 : 2,
      tracks: checks.audioTracks.tracks,
      loudness: `${loudVal} LUFS`,
      truePeak: isMxf ? '-1.2 dBFS' : '-0.3 dBFS',
      lra: '6.4 LU'
    }
  };
}

// GET /api/jobs
app.get('/api/jobs', authMiddleware, (_req, res) => {
  const store = loadJobs();
  res.json(store.jobs.map(j => ({
    id: j.id, filename: j.filename, duration: j.duration,
    size: j.size, resolution: j.resolution, status: j.status,
    score: j.score, aj360Pass: j.aj360Pass, format: j.format,
    uploadedAt: j.uploadedAt, uploadedBy: j.uploadedBy
  })));
});

// GET /api/jobs/:id  (full report)
app.get('/api/jobs/:id', authMiddleware, (req, res) => {
  const store = loadJobs();
  const job = store.jobs.find(j => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// POST /api/jobs/upload
app.post('/api/jobs/upload', authMiddleware, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided' });
  const store = loadJobs();
  const { originalname, size } = req.file;
  const ext = originalname.split('.').pop().toLowerCase();
  const sizeStr = size > 1e9 ? `${(size/1e9).toFixed(1)} GB` : `${(size/1e6).toFixed(1)} MB`;
  const job = {
    id: 'JB_' + randomUUID().split('-')[0].toUpperCase(),
    filename: originalname,
    duration: '—',
    size: sizeStr,
    resolution: '—',
    format: ext.toUpperCase(),
    status: 'processing',
    score: null, aj360Pass: null, report: null,
    uploadedAt: new Date().toISOString(),
    uploadedBy: req.user.email
  };
  store.jobs.unshift(job);
  saveJobs(store);

  // Run real QC analysis asynchronously
  analyzeFile(req.file.path, originalname).then(result => {
    const s2 = loadJobs();
    const j  = s2.jobs.find(x => x.id === job.id);
    if (!j) return;
    j.status    = 'completed';
    j.score     = result.score;
    j.aj360Pass = result.overallPass;
    j.resolution = result.fileInfo?.resolution || '—';
    j.duration   = result.fileInfo?.duration   || '—';
    j.report     = result;
    saveJobs(s2);
    console.log(`[QC] ${originalname} → Score: ${result.score} | Pass: ${result.overallPass} | Fails: ${result.failedCount}`);
  }).catch(err => {
    console.error(`[QC] Analysis failed for ${originalname}:`, err.message);
    const s2 = loadJobs();
    const j  = s2.jobs.find(x => x.id === job.id);
    if (j) { j.status = 'error'; saveJobs(s2); }
  });

  res.json({ success: true, job });
});

// DELETE /api/jobs/:id
app.delete('/api/jobs/:id', adminOnly, (req, res) => {
  const store = loadJobs();
  const idx = store.jobs.findIndex(j => j.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  store.jobs.splice(idx, 1);
  saveJobs(store);
  res.json({ success: true });
});

// GET /api/system/health
app.get('/api/system/health', authMiddleware, (_req, res) => {
  const store = loadJobs();
  const processing = store.jobs.filter(j => j.status === 'processing').length;
  const completed  = store.jobs.filter(j => j.status === 'completed').length;
  const failed     = store.jobs.filter(j => j.status === 'completed' && j.aj360Pass === false).length;
  const avgScore   = completed
    ? Math.round(store.jobs.filter(j=>j.score).reduce((a,b)=>a+(b.score||0),0) / completed * 10) / 10
    : 0;
  res.json({
    status: 'operational',
    activeWorkers: Math.min(processing + 1, 8),
    maxWorkers: 8,
    processing,
    queueDepth: processing,
    diskUsed: '1.8 TB',
    diskTotal: '10 TB',
    diskPct: 18,
    cpuPct: processing > 0 ? Math.round(30 + processing * 15 + Math.random()*10) : Math.round(5 + Math.random()*10),
    memPct: Math.round(45 + Math.random()*20),
    uptime: '14d 6h 32m',
    version: 'v2.4.1',
    totalJobs: store.jobs.length,
    completedToday: completed,
    failedToday: failed,
    avgScore,
    passRate: completed ? Math.round((completed - failed) / completed * 1000) / 10 : 0
  });
});

// Serve app.html at /app
app.get('/app', (_req, res) => res.sendFile(path.join(__dirname, 'app.html')));

app.listen(PORT, () => console.log(`Serving at http://localhost:${PORT}`));
