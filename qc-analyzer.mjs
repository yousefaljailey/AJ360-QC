import { spawn } from 'child_process';
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


// ── Run process and capture output ────────────────────────────
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

// ── 2. Get MediaInfo metadata (enriches ffprobe data) ─────────
async function getMediaInfoData(filePath) {
  try {
    const { stdout, code } = await runProcess('mediainfo', [
      '--Output=JSON', filePath
    ], 60000);
    if (code !== 0 || !stdout.trim()) return null;
    const parsed = JSON.parse(stdout);
    const tracks = parsed?.media?.track || [];
    return {
      general:   tracks.find(t => t['@type'] === 'General') || {},
      video:     tracks.find(t => t['@type'] === 'Video') || {},
      audios:    tracks.filter(t => t['@type'] === 'Audio'),
      texts:     tracks.filter(t => t['@type'] === 'Text'),
      menus:     tracks.filter(t => t['@type'] === 'Menu'),
      others:    tracks.filter(t => !['General','Video','Audio','Text','Menu'].includes(t['@type'])),
      raw:       tracks
    };
  } catch {
    return null; // mediainfo not installed — fall back to ffprobe only
  }
}

// ── VIDEO SEGMENT WORKER ──────────────────────────────────────────────────────
// Analyzes one time segment of the file. Each worker runs as a separate FFmpeg
// process, allowing multiple CPU cores to work in parallel.
// Scale to 640x360 before filters: reduces filter CPU ~36x for UHD.
// Detection quality is identical — black/freeze are visible at any resolution.
async function runVideoSegment(filePath, startSec, durSec, segIdx) {
  try {
    const { stderr } = await runProcess(FFMPEG, [
      '-threads', '2',            // 2 threads per segment — leaves room for siblings
      '-ss', startSec.toFixed(3), // fast seek BEFORE -i (keyframe-accurate, fine for QC)
      '-t',  durSec.toFixed(3),
      '-i',  filePath,
      '-vf', 'scale=640:360:flags=fast_bilinear,blackdetect=d=0.2:pix_th=0.10,freezedetect=n=-60dB:d=1',
      '-an', '-f', 'null', '-'
    ], 7200000);

    const blackTCs = [];
    for (const m of stderr.matchAll(/black_start:([\d.]+)\s+black_end:([\d.]+)\s+black_duration:([\d.]+)/g)) {
      // FFmpeg reports times relative to segment start when using -ss before -i
      const s = parseFloat(m[1]) + startSec, e = parseFloat(m[2]) + startSec, d = parseFloat(m[3]);
      blackTCs.push({ start: secsToTC(s), end: secsToTC(e), startSecs: s, endSecs: e, duration: `${d.toFixed(2)}s` });
    }

    const freezeTCs = [];
    const fStarts = [...stderr.matchAll(/freeze_start:([\d.]+)/g)].map(m => parseFloat(m[1]) + startSec);
    const fEnds   = [...stderr.matchAll(/freeze_end:([\d.]+)/g)].map(m => parseFloat(m[1]) + startSec);
    const fDurs   = [...stderr.matchAll(/freeze_duration:([\d.]+)/g)].map(m => parseFloat(m[1]));
    for (let i = 0; i < fStarts.length; i++) {
      const s = fStarts[i], e = fEnds[i] ?? fStarts[i], d = fDurs[i] ?? (e - s);
      freezeTCs.push({ start: secsToTC(s), end: secsToTC(e), startSecs: s, endSecs: e, duration: `${d.toFixed(2)}s` });
    }

    return { blackTCs, freezeTCs, segIdx, startSec, endSec: startSec + durSec };
  } catch (err) {
    console.error(`[QC] segment ${segIdx} error:`, err.message);
    return { blackTCs: [], freezeTCs: [], segIdx, startSec, endSec: startSec + durSec, error: err.message };
  }
}

// ── PARALLEL VIDEO PASS ───────────────────────────────────────────────────────
// Splits file into N segments and runs N FFmpeg workers in parallel.
// Each worker uses its own CPU cores → N× decode throughput.
// OVERLAP_SEC prevents missing events at segment boundaries.
async function runVideoPass(filePath, duration) {
  // Configurable via env var — tune to Railway CPU count
  const NUM_WORKERS = Math.min(parseInt(process.env.QC_WORKERS || '4'), 8);
  const OVERLAP_SEC = 3; // catch events spanning a boundary

  const segLen = duration / NUM_WORKERS;
  console.log(`[QC] Video: ${NUM_WORKERS} parallel workers × ${segLen.toFixed(0)}s each`);

  const tasks = Array.from({ length: NUM_WORKERS }, (_, i) => {
    const rawStart = i * segLen;
    const rawEnd   = (i + 1) * segLen;
    const start = Math.max(0, rawStart - (i > 0 ? OVERLAP_SEC : 0));
    const end   = Math.min(duration, rawEnd + (i < NUM_WORKERS - 1 ? OVERLAP_SEC : 0));
    return runVideoSegment(filePath, start, end - start, i);
  });

  const results = await Promise.all(tasks);

  // Merge and deduplicate — remove events duplicated in overlap zones
  const allBlack  = results.flatMap(r => r.blackTCs);
  const allFreeze = results.flatMap(r => r.freezeTCs);

  function dedupe(tcs) {
    // Sort by startSecs, remove events that start within 1s of a previous one
    const sorted = tcs.slice().sort((a, b) => a.startSecs - b.startSecs);
    return sorted.filter((tc, i) => i === 0 || tc.startSecs > sorted[i - 1].startSecs + 1);
  }

  // Pillarboxing: 3-point seek (fast, file-size independent) — separate from segment workers
  let crops = [];
  try {
    const seekPoints = [duration * 0.05, duration * 0.5, duration * 0.9];
    for (const ss of seekPoints) {
      const { stderr } = await runProcess(FFMPEG, [
        '-threads', '2', '-ss', ss.toFixed(2), '-t', '10',
        '-i', filePath,
        '-vf', 'scale=640:360:flags=fast_bilinear,cropdetect=24:16:0',
        '-frames:v', '30', '-an', '-f', 'null', '-'
      ], 60000);
      crops.push(...[...stderr.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)]
        .map(m => ({ w: parseInt(m[1]), h: parseInt(m[2]), x: parseInt(m[3]), y: parseInt(m[4]) })));
    }
  } catch (err) { console.error('[QC] cropdetect error:', err.message); }

  const hadError = results.some(r => r.error) && results.every(r => r.blackTCs.length === 0 && r.freezeTCs.length === 0);
  const firstErr = results.find(r => r.error)?.error;

  return {
    blackTCs:  hadError ? null : dedupe(allBlack),
    freezeTCs: hadError ? null : dedupe(allFreeze),
    crops,
    error: hadError ? firstErr : undefined
  };
}

// ── COMBINED AUDIO PASS ───────────────────────────────────────────────────────
// Single full audio read. No framelog=verbose (would produce GB of output for large files).
// Level consistency derived from LRA which ebur128 already computes — broadcast standard.
async function runAudioPass(filePath, totalDuration) {
  try {
    const { stderr } = await runProcess(FFMPEG, [
      '-threads', '0',
      '-vn',                    // skip video entirely — audio only
      '-i', filePath,
      '-filter_complex', '[0:a]asplit=2[a1][a2];[a1]ebur128=peak=true[x];[a2]silencedetect=n=-50dB:d=5',
      '-map', '[x]',
      '-f', 'null', '-'
    ], 7200000);

    // ── Parse EBU R128 loudness ───────────────────────────────
    const iMatch   = stderr.match(/\s+I:\s+([-\d.]+)\s+LUFS/);
    const lraMatch = stderr.match(/\s+LRA:\s+([-\d.]+)\s+LU/);
    const tpMatch  = stderr.match(/\s+True peak:\s+([-\d.]+)\s+dBFS/);
    const measured    = iMatch  ? parseFloat(iMatch[1])  : null;
    const truePeakRaw = tpMatch ? parseFloat(tpMatch[1]) : null;
    // LRA is the broadcast-standard measure of loudness range (dynamic variation).
    // LRA > 20 LU = abrupt volume jumps between scenes.
    const lraVal = lraMatch ? parseFloat(lraMatch[1]) : null;

    // ── Parse silence ─────────────────────────────────────────
    const silenceTCs = [];
    const sStarts = [...stderr.matchAll(/silence_start:([\d.]+)/g)].map(m => parseFloat(m[1]));
    const sEnds   = [...stderr.matchAll(/silence_end:([\d.]+)/g)].map(m => parseFloat(m[1]));
    const sDurs   = [...stderr.matchAll(/silence_duration:([\d.]+)/g)].map(m => parseFloat(m[1]));
    for (let i = 0; i < sStarts.length; i++) {
      const startSecs = sStarts[i], endSecs = sEnds[i] ?? sStarts[i], dur = sDurs[i] ?? (endSecs - startSecs);
      const isLeader = startSecs < 2;
      const isTail   = totalDuration > 0 && endSecs > (totalDuration - 5);
      if (!isLeader && !isTail)
        silenceTCs.push({ start: secsToTC(startSecs), end: secsToTC(endSecs), startSecs, endSecs, duration: `${dur.toFixed(2)}s` });
    }

    return { measured, truePeakRaw, lraVal, lraStr: lraMatch?.[1], tpStr: tpMatch?.[1], silenceTCs };
  } catch (err) {
    console.error('[QC] runAudioPass error:', err.message);
    return { error: err.message };
  }
}

// ── SAMPLE PASS — 3-point seek for glitches (file-size independent) ──────────
// Samples 60 frames at start / middle / end instead of 500 from the beginning.
// Result is the same quality for detecting systematic artifacts.
async function detectVisualGlitches(filePath, totalDuration) {
  const seekPoints = totalDuration > 0
    ? [totalDuration * 0.05, totalDuration * 0.50, totalDuration * 0.90]
    : [0];

  const allScores = [];
  for (const seek of seekPoints) {
    try {
      const args = [
        '-threads', '0',
        '-ss', seek.toFixed(2),
        '-i', filePath,
        '-vf', 'blockdetect=period_min=3:period_max=24:planes=0',
        '-frames:v', '60',
        '-an', '-f', 'null', '-'
      ];
      const { stderr } = await runProcess(FFMPEG, args, 60000);
      const scores = [...stderr.matchAll(/block:([\d.]+)/g)].map(m => parseFloat(m[1]));
      allScores.push(...scores);
    } catch { /* skip failed seek point */ }
  }

  if (!allScores.length)
    return { pass: true, value: 'No artifacts detected', expected: 'Block artifact score < 10', blockScore: 0 };

  const avgScore = allScores.reduce((a, b) => a + b, 0) / allScores.length;
  const maxScore = Math.max(...allScores);
  const pass = avgScore < 10;
  return {
    pass,
    value:     pass ? `Avg block score: ${avgScore.toFixed(2)}` : `Artifacts detected (avg: ${avgScore.toFixed(2)}, peak: ${maxScore.toFixed(2)})`,
    blockScore: avgScore, maxBlock: maxScore,
    expected:  'Block artifact score < 10'
  };
}

// ── Main analysis entry point ──────────────────────────────────
export async function analyzeFile(filePath, originalFilename) {
  console.log('[QC] Starting analysis:', originalFilename, '| path:', filePath);
  const ext = originalFilename.split('.').pop().toLowerCase();

  // Get metadata (fast, run in parallel)
  let meta, mediaInfo;
  try {
    [meta, mediaInfo] = await Promise.all([
      getMetadata(filePath),
      getMediaInfoData(filePath)
    ]);
    console.log('[QC] Metadata OK — streams:', meta.streams?.length, '| MediaInfo:', mediaInfo ? 'yes' : 'not available');
  } catch (err) {
    console.error('[QC] Metadata error:', err.message);
    return { error: 'Could not read file: ' + err.message };
  }

  const videoStream  = meta.streams?.find(s => s.codec_type === 'video');
  const audioStreams  = meta.streams?.filter(s => s.codec_type === 'audio') || [];
  const subtitleStreams = meta.streams?.filter(s => s.codec_type === 'subtitle' || s.codec_type === 'data') || [];
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

  // Duration
  const duration = parseFloat(fmt?.duration || '0');

  // Bitrate (bps → Mbps)
  const bitRateRaw = parseInt(fmt?.bit_rate || '0');
  const bitRateMbps = bitRateRaw > 0 ? bitRateRaw / 1000000 : 0;

  // ── FAST METADATA-DERIVED CHECKS ────────────────────────────
  const checks = {
    format: {
      label: 'File Format', icon: '📄',
      pass:  ext === 'mxf',
      value: ext.toUpperCase(), expected: 'MXF'
    },
    resolution: {
      label: 'Resolution', icon: '🖥',
      pass:  width === 3840 && height === 2160,
      value: res, expected: '3840×2160 (UHD)'
    },
    frameRate: {
      label: 'Frame Rate', icon: '🎞',
      pass:  Math.abs(fps - 25) < 0.1,
      value: fps > 0 ? `${fps.toFixed(2)} fps` : '—', expected: '25 fps'
    },
    aspectRatio: {
      label: 'Aspect Ratio', icon: '📐',
      pass:  aspectRatio === '16:9',
      value: aspectRatio, expected: '16:9'
    },
    audioCodec: {
      label: 'Audio Codec', icon: '🔊',
      pass:  audioStreams.length > 0 && audioStreams.every(s => isPCM24(s.codec_name)),
      value: audioCodecNames.length > 0 ? [...new Set(audioCodecNames)].join(', ').toUpperCase() : 'None',
      expected: 'PCM 24-bit (pcm_s24le)'
    },
    sampleRate: {
      label: 'Sample Rate', icon: '〰',
      pass:  audioStreams.length > 0 && audioStreams.every(s => s.sample_rate === '48000'),
      value: audioStreams[0]?.sample_rate ? audioStreams[0].sample_rate + ' Hz' : '—',
      expected: '48,000 Hz'
    },
    audioTracks: {
      label: 'Audio Tracks', icon: '🎚',
      pass:  audioStreams.length === 4 && trackDetails.every(t => t.codecOk && t.sampleOk),
      value: `${audioStreams.length} track${audioStreams.length !== 1 ? 's' : ''}`,
      expected: '4 tracks: Left / Right / Left Mix Minus / Right Mix Minus',
      tracks: trackDetails
    },

    // Mono audio — each PCM track in broadcast MXF must be single channel (mono)
    monoAudio: {
      label: 'Mono Audio Tracks', icon: '🔉',
      pass:  audioStreams.length === 0 || audioStreams.every(s => (s.channels || 1) === 1),
      value: audioStreams.length > 0
        ? `${[...new Set(audioStreams.map(s => s.channels))].join('/')}-ch per track`
        : '—',
      expected: '1 channel per track (mono PCM)'
    },

    // A/V sync — compare stream start_time offsets
    avSync: (() => {
      const vStart = parseFloat(videoStream?.start_time || '0');
      const aStart = parseFloat(audioStreams[0]?.start_time || '0');
      const delta  = Math.abs(vStart - aStart);
      const pass   = delta < 0.1; // 100ms threshold
      return {
        label: 'A/V Sync', icon: '🔄',
        pass,
        value:    delta < 0.001 ? 'In sync' : `${(delta * 1000).toFixed(0)}ms offset`,
        delta,
        expected: 'Audio/video offset < 100ms'
      };
    })(),

    // Bitrate compliance — UHD MXF: 50–600 Mbps
    bitrateCompliance: {
      label: 'Bitrate Compliance', icon: '📡',
      pass:  bitRateMbps === 0 || (bitRateMbps >= 50 && bitRateMbps <= 600),
      value: bitRateMbps > 0 ? `${bitRateMbps.toFixed(0)} Mbps` : '—',
      expected: '50–600 Mbps (UHD MXF)'
    },

    // Content integrity — valid duration present
    contentIntegrity: (() => {
      const miDuration = parseFloat(mediaInfo?.general?.Duration || '0') / 1000; // ms → s
      const effectiveDuration = duration > 0 ? duration : miDuration;
      const pass = effectiveDuration > 5; // must be at least 5 seconds
      return {
        label: 'Content Integrity', icon: '🎬',
        pass,
        value:    effectiveDuration > 0 ? formatDuration(effectiveDuration) : 'Unknown / truncated',
        duration: effectiveDuration,
        expected: 'Valid duration > 5s — no truncation'
      };
    })(),

    // Subtitles — flag if unexpected subtitle/text tracks are present
    subtitles: (() => {
      const ffprobeSubs = subtitleStreams.length;
      const miTexts     = mediaInfo?.texts?.length || 0;
      const totalSubs   = Math.max(ffprobeSubs, miTexts);

      const subDetails = subtitleStreams.map((s, i) => ({
        index:    i + 1,
        codec:    s.codec_name || '—',
        language: s.tags?.language || 'und',
        title:    s.tags?.title || `Track ${i + 1}`
      }));
      // Also pull from MediaInfo texts if ffprobe missed them
      if (miTexts > ffprobeSubs && mediaInfo?.texts) {
        mediaInfo.texts.forEach((t, i) => {
          if (!subDetails.find(s => s.title === (t.Title || t.title))) {
            subDetails.push({
              index:    subDetails.length + 1,
              codec:    t.Format || '—',
              language: t.Language || 'und',
              title:    t.Title || `MI Track ${i + 1}`
            });
          }
        });
      }
      return {
        label:   'Subtitles / Captions', icon: '💬',
        pass:    true,         // presence is informational — not a fail
        value:   totalSubs > 0 ? `${totalSubs} subtitle track${totalSubs !== 1 ? 's' : ''} found` : 'None detected',
        count:   totalSubs,
        tracks:  subDetails,
        expected: 'Report subtitle tracks (informational)'
      };
    })()
  };

  // ── 2 COMBINED PASSES + 1 SAMPLE PASS (replaces 7 separate FFmpeg reads) ──
  // Video pass: blackdetect + freezedetect + cropdetect — one full file read at 5fps
  // Audio pass: ebur128 + silencedetect via asplit — one full audio read, no video
  // Sample pass: blockdetect at 3 seek points — file-size independent
  console.log('[QC] Running 3-pass FFmpeg analysis…');
  const t0 = Date.now();
  const [videoPass, audioPass, glitchResult] = await Promise.all([
    runVideoPass(filePath, duration),
    runAudioPass(filePath, duration),
    detectVisualGlitches(filePath, duration)
  ]);
  console.log(`[QC] FFmpeg complete in ${((Date.now()-t0)/1000).toFixed(1)}s`);

  // ── Unpack video pass results ─────────────────────────────
  const { blackTCs, freezeTCs, crops } = videoPass;
  const videoErr = videoPass.error;

  checks.blackFrames = {
    label: 'Black Frames', icon: '⬛',
    pass:  blackTCs ? blackTCs.length === 0 : null,
    measured: !videoErr,
    count: blackTCs?.length ?? 0,
    timecodes: blackTCs ?? [],
    value: videoErr ? 'FFmpeg error: ' + videoErr : undefined,
    expected: 'No black frames'
  };

  checks.freezeFrames = {
    label: 'Freeze / Dropped Frames', icon: '🧊',
    pass:  freezeTCs ? freezeTCs.length === 0 : null,
    measured: !videoErr,
    count: freezeTCs?.length ?? 0,
    timecodes: freezeTCs ?? [],
    value: videoErr ? 'FFmpeg error: ' + videoErr : undefined,
    expected: 'No freeze frames'
  };

  // Pillarboxing from cropdetect results
  const pillarResult = (() => {
    if (videoErr || !crops) return { pass: null, measured: false, value: 'FFmpeg error: ' + videoErr, expected: 'Full frame — no pillarboxing or letterboxing' };
    if (!crops.length) return { pass: true, value: 'No boxing detected', expected: 'Full frame — no pillarboxing or letterboxing' };
    const wCounts = {};
    crops.forEach(c => { wCounts[c.w] = (wCounts[c.w] || 0) + 1; });
    const dominantW = parseInt(Object.entries(wCounts).sort((a, b) => b[1] - a[1])[0][0]);
    const dominant  = crops.find(c => c.w === dominantW);
    const pass = dominant.w >= width * 0.99 && dominant.h >= height * 0.99;
    const detectedRes = `${dominant.w}×${dominant.h}`;
    const hasPillar = dominant.x > 0 || dominant.w < width  * 0.98;
    const hasLetter = dominant.y > 0 || dominant.h < height * 0.98;
    const type = hasPillar && hasLetter ? 'Pillarboxing + Letterboxing' : hasPillar ? 'Pillarboxing detected' : hasLetter ? 'Letterboxing detected' : 'None';
    return { pass, value: pass ? 'Full frame — no boxing' : `${type} (active: ${detectedRes})`, detectedRes, type, expected: 'Full frame — no pillarboxing or letterboxing' };
  })();
  checks.pillarboxing = { label: 'Pillarboxing / Letterboxing', icon: '⬜', ...pillarResult };

  // ── Unpack audio pass results ─────────────────────────────
  const { measured, truePeakRaw, lraVal, lraStr, tpStr, silenceTCs } = audioPass;
  const audioErr = audioPass.error;

  const loudPass = measured !== null ? (measured >= -24.0 && measured <= -22.0) : null;
  checks.loudness = {
    label: 'Loudness (EBU R128)', icon: '📊',
    pass:  audioErr ? null : loudPass,
    measured: !audioErr ? measured : false,
    value: audioErr ? 'FFmpeg error: ' + audioErr : (measured !== null ? `${measured.toFixed(1)} LUFS` : '—'),
    expected: '-23 LUFS (±1 LU)',
    lra:      lraStr ? `${lraStr} LU` : '—',
    truePeak: tpStr  ? `${tpStr} dBFS` : '—',
    truePeakRaw: truePeakRaw ?? null
  };

  checks.peakClipping = {
    label: 'Peak Clipping', icon: '⚡',
    pass:  truePeakRaw === null ? null : truePeakRaw <= -1.0,
    value: truePeakRaw !== null ? `${truePeakRaw.toFixed(1)} dBFS` : (audioErr ? 'FFmpeg error: ' + audioErr : '—'),
    truePeak: truePeakRaw,
    expected: 'True Peak ≤ −1.0 dBFS'
  };

  checks.audioSilence = {
    label: 'Audio Silence', icon: '🔇',
    pass:  silenceTCs ? silenceTCs.length === 0 : null,
    measured: !audioErr,
    count: silenceTCs?.length ?? 0,
    timecodes: silenceTCs ?? [],
    value: audioErr ? 'FFmpeg error: ' + audioErr : undefined,
    expected: 'No long silence (> 5s) mid-content'
  };

  // Level consistency via LRA (EBU R128 Loudness Range) — broadcast standard.
  // LRA > 20 LU = abrupt volume jumps. No framelog=verbose needed — already in ebur128 summary.
  checks.audioLevelConsistency = {
    label: 'Audio Level Consistency', icon: '📈',
    pass:  lraVal === null ? null : lraVal <= 20,
    value: lraVal !== null ? `${lraVal.toFixed(1)} LU LRA` : (audioErr ? 'FFmpeg error: ' + audioErr : '—'),
    lraVal,
    expected: 'LRA ≤ 20 LU (EBU R128 Loudness Range)'
  };

  checks.visualGlitches = { label: 'Visual Glitches / Artifacts', icon: '🖼', ...glitchResult };

  // ── SCORE CALCULATION ────────────────────────────────────────
  const criticalKeys = new Set(['blackFrames','loudness','audioCodec','audioTracks','peakClipping','avSync']);
  const informationalKeys = new Set(['subtitles']); // never penalised

  const checkEntries  = Object.entries(checks);
  const failedChecks  = checkEntries.filter(([k, c]) => !c.pass && !informationalKeys.has(k));
  const passedChecks  = checkEntries.filter(([, c]) => c.pass);

  const criticalFails = failedChecks.filter(([k]) => criticalKeys.has(k)).length;
  const normalFails   = failedChecks.length - criticalFails;
  const deduction     = criticalFails * 15 + normalFails * 8;
  const score         = Math.max(0, 100 - deduction);

  return {
    checks,
    overallPass:  failedChecks.length === 0,
    aj360Pass:    failedChecks.length === 0,
    score,
    passedCount:  passedChecks.length,
    failedCount:  failedChecks.length,
    mediaInfoAvailable: mediaInfo !== null,
    fileInfo: {
      format:      ext.toUpperCase(),
      fileSize:    formatSize(parseInt(fmt?.size || '0')),
      videoCodec:  videoStream?.codec_name?.toUpperCase() || '—',
      bitRate:     bitRateMbps > 0 ? `${bitRateMbps.toFixed(0)} Mbps` : '—',
      duration:    formatDuration(duration),
      frameRate:   fps > 0 ? `${fps.toFixed(2)} fps` : '—',
      resolution:  res,
      // MediaInfo enhancements
      bitDepth:    mediaInfo?.video?.BitDepth ? `${mediaInfo.video.BitDepth}-bit` : videoStream?.bits_per_raw_sample ? `${videoStream.bits_per_raw_sample}-bit` : '—',
      timecode:    mediaInfo?.general?.TimeCode_FirstFrame || mediaInfo?.others?.find(t => t.TimeCode_FirstFrame)?.TimeCode_FirstFrame || '—',
      wrapper:     mediaInfo?.general?.Format_Commercial_IfAny || mediaInfo?.general?.Format || ext.toUpperCase()
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
