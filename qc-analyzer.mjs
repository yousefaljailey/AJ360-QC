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

// ── Standard deviation helper ─────────────────────────────────
function stdDev(values) {
  if (!values.length) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
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

// ── COMBINED VIDEO PASS — blackdetect + freezedetect + cropdetect ────────────
// One single FFmpeg read of the entire file replaces 3 separate passes.
async function runVideoPass(filePath) {
  try {
    const { stderr } = await runProcess(FFMPEG, [
      '-threads', '0',
      '-i', filePath,
      '-vf', 'blackdetect=d=0.04:pix_th=0.10,freezedetect=n=-60dB:d=1,cropdetect=24:16:0',
      '-an', '-f', 'null', '-'
    ], 1800000); // 30 min for large files

    // ── Parse black frames ────────────────────────────────────
    const blackTCs = [];
    for (const m of stderr.matchAll(/black_start:([\d.]+)\s+black_end:([\d.]+)\s+black_duration:([\d.]+)/g)) {
      const startSecs = parseFloat(m[1]), endSecs = parseFloat(m[2]), dur = parseFloat(m[3]);
      blackTCs.push({ start: secsToTC(startSecs), end: secsToTC(endSecs), startSecs, endSecs, duration: `${dur.toFixed(2)}s` });
    }

    // ── Parse freeze frames ───────────────────────────────────
    const freezeTCs = [];
    const fStarts = [...stderr.matchAll(/freeze_start:([\d.]+)/g)].map(m => parseFloat(m[1]));
    const fEnds   = [...stderr.matchAll(/freeze_end:([\d.]+)/g)].map(m => parseFloat(m[1]));
    const fDurs   = [...stderr.matchAll(/freeze_duration:([\d.]+)/g)].map(m => parseFloat(m[1]));
    for (let i = 0; i < fStarts.length; i++) {
      const startSecs = fStarts[i], endSecs = fEnds[i] ?? fStarts[i], dur = fDurs[i] ?? (endSecs - startSecs);
      freezeTCs.push({ start: secsToTC(startSecs), end: secsToTC(endSecs), startSecs, endSecs, duration: `${dur.toFixed(2)}s` });
    }

    // ── Parse cropdetect (pillarboxing) ───────────────────────
    const crops = [...stderr.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)]
      .map(m => ({ w: parseInt(m[1]), h: parseInt(m[2]), x: parseInt(m[3]), y: parseInt(m[4]) }));

    return { blackTCs, freezeTCs, crops };
  } catch (err) {
    console.error('[QC] runVideoPass error:', err.message);
    return { error: err.message, blackTCs: null, freezeTCs: null, crops: null };
  }
}

// ── COMBINED AUDIO PASS — ebur128 (loudness + level consistency) + silencedetect ──
// One single FFmpeg read of the entire audio replaces 3 separate passes.
async function runAudioPass(filePath, totalDuration) {
  try {
    const { stderr } = await runProcess(FFMPEG, [
      '-threads', '0',
      '-i', filePath,
      '-filter_complex', '[0:a]asplit=2[a1][a2];[a1]ebur128=peak=true:framelog=verbose[x];[a2]silencedetect=n=-50dB:d=5',
      '-map', '[x]', '-f', 'null', '-'
    ], 1800000);

    // ── Parse EBU R128 loudness ───────────────────────────────
    const iMatch   = stderr.match(/\s+I:\s+([-\d.]+)\s+LUFS/);
    const lraMatch = stderr.match(/\s+LRA:\s+([-\d.]+)\s+LU/);
    const tpMatch  = stderr.match(/\s+True peak:\s+([-\d.]+)\s+dBFS/);
    const measured    = iMatch  ? parseFloat(iMatch[1])  : null;
    const truePeakRaw = tpMatch ? parseFloat(tpMatch[1]) : null;

    // ── Parse momentary loudness for level consistency ────────
    const mValues = [...stderr.matchAll(/\s+M:\s+([-\d.]+)/g)]
      .map(m => parseFloat(m[1])).filter(v => v > -70);
    const sd = mValues.length >= 10 ? stdDev(mValues) : null;

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

    return { measured, truePeakRaw, lraStr: lraMatch?.[1], tpStr: tpMatch?.[1], sd, silenceTCs };
  } catch (err) {
    console.error('[QC] runAudioPass error:', err.message);
    return { error: err.message };
  }
}

// ── SAMPLE PASS — blockdetect on first 500 frames only ───────────────────────
async function detectVisualGlitches(filePath) {
  try {
    const { stderr } = await runProcess(FFMPEG, [
      '-threads', '0',
      '-i', filePath,
      '-vf', 'blockdetect=period_min=3:period_max=24:planes=0',
      '-frames:v', '500',
      '-an', '-f', 'null', '-'
    ], 120000);

    const scores = [...stderr.matchAll(/block:([\d.]+)/g)].map(m => parseFloat(m[1]));
    if (!scores.length)
      return { pass: true, value: 'No artifacts detected', expected: 'Block artifact score < 10', blockScore: 0 };

    const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
    const maxScore = Math.max(...scores);
    const pass = avgScore < 10;
    return {
      pass,
      value:     pass ? `Avg block score: ${avgScore.toFixed(2)}` : `Artifacts detected (avg: ${avgScore.toFixed(2)}, peak: ${maxScore.toFixed(2)})`,
      blockScore: avgScore, maxBlock: maxScore,
      expected:  'Block artifact score < 10'
    };
  } catch (err) {
    console.error('[QC] detectVisualGlitches error:', err.message);
    return { pass: null, measured: false, value: 'FFmpeg error: ' + err.message, expected: 'Block artifact score < 10' };
  }
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
  // Video pass: blackdetect + freezedetect + cropdetect — one full file read
  // Audio pass: ebur128 + silencedetect — one full file read
  // Sample pass: blockdetect on first 500 frames — fast, separate
  console.log('[QC] Running 3-pass FFmpeg analysis (was 7)…');
  const t0 = Date.now();
  const [videoPass, audioPass, glitchResult] = await Promise.all([
    runVideoPass(filePath),
    runAudioPass(filePath, duration),
    detectVisualGlitches(filePath)
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
  const { measured, truePeakRaw, lraStr, tpStr, sd, silenceTCs } = audioPass;
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

  checks.audioLevelConsistency = {
    label: 'Audio Level Consistency', icon: '📈',
    pass:  sd === null ? null : sd < 15,
    value: sd !== null ? `${sd.toFixed(1)} LU StdDev` : (audioErr ? 'FFmpeg error: ' + audioErr : 'Insufficient data'),
    stdDev: sd,
    expected: 'StdDev < 15 LU between scenes'
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
