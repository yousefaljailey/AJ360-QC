import { spawn } from 'child_process';
import { promisify } from 'util';
import ffprobeStatic from 'ffprobe-static';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';

const FFPROBE = ffprobeStatic.path;
const FFMPEG  = ffmpegInstaller.path;

// ── Timecode helpers ──────────────────────────────────────────
function secsToTC(secs, fps = 25) {
  if (isNaN(secs)) return '00:00:00:00';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  const f = Math.min(fps - 1, Math.floor((secs % 1) * fps));
  return `${pad(h)}:${pad(m)}:${pad(s)}:${pad(f)}`;
}
function pad(n) { return String(n).padStart(2, '0'); }

function formatDuration(secs) {
  if (!secs || isNaN(secs)) return '—';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  return h > 0
    ? `${h}:${pad(m)}:${pad(s)}`
    : `${m}:${pad(s)}`;
}

function formatSize(bytes) {
  if (!bytes) return '—';
  if (bytes > 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  return `${(bytes / 1e6).toFixed(1)} MB`;
}

function gcd(a, b) { return b ? gcd(b, a % b) : a; }
function simplifyRatio(w, h) {
  const g = gcd(w, h);
  return `${w / g}:${h / g}`;
}

// ── Run process and capture stderr ────────────────────────────
function runProcess(bin, args, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args);
    let stderr = '';
    let stdout = '';
    proc.stdout.on('data', d => stdout += d.toString());
    proc.stderr.on('data', d => stderr += d.toString());
    proc.on('close', code => resolve({ stdout, stderr, code }));
    proc.on('error', reject);
    setTimeout(() => { proc.kill(); reject(new Error('Timeout')); }, timeoutMs);
  });
}

// ── 1. Get metadata with ffprobe ──────────────────────────────
async function getMetadata(filePath) {
  const { stdout } = await runProcess(FFPROBE, [
    '-v', 'quiet', '-print_format', 'json',
    '-show_streams', '-show_format', filePath
  ]);
  return JSON.parse(stdout);
}

// ── 2. Black frame detection ──────────────────────────────────
async function detectBlackFrames(filePath) {
  try {
    const { stderr } = await runProcess(FFMPEG, [
      '-i', filePath,
      '-vf', 'blackdetect=d=0.04:pix_th=0.10',
      '-an', '-f', 'null', '-'
    ], 600000);

    const timecodes = [];
    const re = /black_start:([\d.]+)\s+black_end:([\d.]+)\s+black_duration:([\d.]+)/g;
    let m;
    while ((m = re.exec(stderr)) !== null) {
      const startSecs = parseFloat(m[1]);
      const endSecs   = parseFloat(m[2]);
      const dur       = parseFloat(m[3]);
      timecodes.push({
        start:    secsToTC(startSecs),
        end:      secsToTC(endSecs),
        startSecs,
        endSecs,
        duration: `${dur.toFixed(2)}s`
      });
    }
    return {
      pass:      timecodes.length === 0,
      count:     timecodes.length,
      timecodes,
      expected:  'No black frames'
    };
  } catch {
    return { pass: true, count: 0, timecodes: [], error: 'Analysis skipped', expected: 'No black frames' };
  }
}

// ── 3. Loudness measurement (EBU R128) ────────────────────────
async function measureLoudness(filePath) {
  try {
    const { stderr } = await runProcess(FFMPEG, [
      '-i', filePath,
      '-filter_complex', 'ebur128=peak=true',
      '-f', 'null', '-'
    ], 600000);

    // Parse summary block
    const iMatch  = stderr.match(/\s+I:\s+([-\d.]+)\s+LUFS/);
    const lraMatch = stderr.match(/\s+LRA:\s+([-\d.]+)\s+LU/);
    const tpMatch  = stderr.match(/\s+True peak:\s+([-\d.]+)\s+dBFS/);

    const measured = iMatch ? parseFloat(iMatch[1]) : null;
    // Pass if within -24 to -22 LUFS (target: -23 ±1)
    const pass = measured !== null ? (measured >= -24.0 && measured <= -22.0) : false;

    return {
      pass,
      value:     measured !== null ? `${measured.toFixed(1)} LUFS` : '—',
      measured,
      expected:  '-23 LUFS (±1 LU)',
      lra:       lraMatch ? `${lraMatch[1]} LU` : '—',
      truePeak:  tpMatch  ? `${tpMatch[1]} dBFS` : '—'
    };
  } catch {
    return { pass: false, value: '—', expected: '-23 LUFS (±1 LU)', error: 'Analysis skipped' };
  }
}

// ── Main analysis entry point ──────────────────────────────────
export async function analyzeFile(filePath, originalFilename) {
  const ext = originalFilename.split('.').pop().toLowerCase();

  // Get metadata first (fast)
  let meta;
  try {
    meta = await getMetadata(filePath);
  } catch (err) {
    return { error: 'Could not read file: ' + err.message };
  }

  const videoStream  = meta.streams?.find(s => s.codec_type === 'video');
  const audioStreams  = meta.streams?.filter(s => s.codec_type === 'audio') || [];
  const fmt           = meta.format;

  // Detect real FPS
  const fpsStr = videoStream?.r_frame_rate || videoStream?.avg_frame_rate || '0/1';
  const [fn, fd] = fpsStr.split('/').map(Number);
  const fps = fd ? fn / fd : 0;

  // Resolution
  const width  = videoStream?.width  || 0;
  const height = videoStream?.height || 0;
  const res    = `${width}x${height}`;

  // Aspect ratio
  const arFromMeta = videoStream?.display_aspect_ratio || '';
  const arCalc     = width && height ? simplifyRatio(width, height) : '—';
  const aspectRatio = arFromMeta || arCalc;

  // Audio codec names
  const audioCodecNames = audioStreams.map(s => s.codec_name || '—');
  const isPCM24 = (name) => ['pcm_s24le','pcm_s24be','pcm_s24'].includes(name?.toLowerCase());

  // Audio track details
  const expectedTrackLabels = ['Left','Right','Left Mix Minus','Right Mix Minus'];
  const trackDetails = audioStreams.map((s, i) => ({
    index:      i + 1,
    label:      expectedTrackLabels[i] || `Track ${i + 1}`,
    expected:   expectedTrackLabels[i] || '—',
    codec:      s.codec_name || '—',
    sampleRate: s.sample_rate || '—',
    channels:   s.channels || 1,
    layout:     s.channel_layout || 'mono',
    codecOk:    isPCM24(s.codec_name),
    sampleOk:   s.sample_rate === '48000'
  }));

  // ── Build checks ──────────────────────────────────────────
  const checks = {
    format: {
      label:    'File Format',
      pass:     ext === 'mxf',
      value:    ext.toUpperCase(),
      expected: 'MXF',
      icon:     '📄'
    },
    resolution: {
      label:    'Resolution',
      pass:     width === 3840 && height === 2160,
      value:    res,
      expected: '3840×2160 (UHD)',
      icon:     '🖥'
    },
    frameRate: {
      label:    'Frame Rate',
      pass:     Math.abs(fps - 25) < 0.1,
      value:    fps > 0 ? `${fps.toFixed(2)} fps` : '—',
      expected: '25 fps',
      icon:     '🎞'
    },
    aspectRatio: {
      label:    'Aspect Ratio',
      pass:     aspectRatio === '16:9',
      value:    aspectRatio,
      expected: '16:9',
      icon:     '📐'
    },
    audioCodec: {
      label:    'Audio Codec',
      pass:     audioStreams.length > 0 && audioStreams.every(s => isPCM24(s.codec_name)),
      value:    audioCodecNames.length > 0 ? [...new Set(audioCodecNames)].join(', ').toUpperCase() : 'None',
      expected: 'PCM 24-bit (pcm_s24le)',
      icon:     '🔊'
    },
    sampleRate: {
      label:    'Sample Rate',
      pass:     audioStreams.length > 0 && audioStreams.every(s => s.sample_rate === '48000'),
      value:    audioStreams[0]?.sample_rate ? audioStreams[0].sample_rate + ' Hz' : '—',
      expected: '48,000 Hz',
      icon:     '〰'
    },
    audioTracks: {
      label:    'Audio Tracks',
      pass:     audioStreams.length === 4,
      value:    `${audioStreams.length} track${audioStreams.length !== 1 ? 's' : ''}`,
      expected: '4 tracks: Left / Right / Left Mix Minus / Right Mix Minus',
      tracks:   trackDetails,
      icon:     '🎚'
    }
  };

  // ── Run expensive analysis in parallel ────────────────────
  const [blackResult, loudResult] = await Promise.all([
    detectBlackFrames(filePath),
    measureLoudness(filePath)
  ]);

  checks.blackFrames = {
    label:     'Black Frames',
    icon:      '⬛',
    ...blackResult
  };
  checks.loudness = {
    label:  'Loudness (EBU R128)',
    icon:   '📊',
    ...loudResult
  };

  // ── Score calculation ──────────────────────────────────────
  const checkList   = Object.values(checks);
  const failedChecks = checkList.filter(c => !c.pass);
  const passedChecks = checkList.filter(c =>  c.pass);

  // Weighted: black frames and loudness are critical (2x weight)
  const criticalFails = failedChecks.filter(c =>
    ['blackFrames','loudness','audioCodec','audioTracks'].includes(
      Object.keys(checks).find(k => checks[k] === c)
    )
  ).length;
  const normalFails = failedChecks.length - criticalFails;
  const deduction   = criticalFails * 15 + normalFails * 8;
  const score       = Math.max(0, 100 - deduction);

  const duration = parseFloat(fmt?.duration || '0');

  return {
    checks,
    overallPass:  failedChecks.length === 0,
    aj360Pass:    failedChecks.length === 0,
    score,
    passedCount:  passedChecks.length,
    failedCount:  failedChecks.length,
    fileInfo: {
      format:     ext.toUpperCase(),
      fileSize:   formatSize(parseInt(fmt?.size || '0')),
      videoCodec: videoStream?.codec_name?.toUpperCase() || '—',
      bitRate:    fmt?.bit_rate ? `${Math.round(parseInt(fmt.bit_rate) / 1000000)} Mbps` : '—',
      duration:   formatDuration(duration),
      frameRate:  fps > 0 ? `${fps.toFixed(2)} fps` : '—',
      resolution: res
    },
    audioInfo: {
      codec:      audioCodecNames[0]?.toUpperCase() || '—',
      sampleRate: audioStreams[0]?.sample_rate ? `${audioStreams[0].sample_rate} Hz` : '—',
      channels:   audioStreams.length,
      tracks:     trackDetails,
      loudness:   loudResult.value || '—',
      truePeak:   loudResult.truePeak || '—',
      lra:        loudResult.lra || '—'
    }
  };
}
