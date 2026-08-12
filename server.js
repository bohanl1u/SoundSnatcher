import express from 'express';
import { access, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyze } from './lib/analyze.js';
import { clearWorkspace, createJob, destroyJob, getJob, publicView, startSweeper } from './lib/jobs.js';
import {
  ANALYSIS_RATE, decodeToMono, downloadAudio, encode, explainToolError, FFMPEG, YTDLP,
} from './lib/media.js';
import {
  config, cors, createConcurrencyGuard, healthCors, PUBLIC_MODE, rateLimit,
} from './lib/limits.js';
import { buildFilename, contentDisposition } from './lib/naming.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4747;
const HOST = process.env.HOST || '0.0.0.0';

export const MP3_BITRATES = [128, 192, 256, 320];

/** Analysis is capped so a two-hour mix doesn't take two minutes to measure. */
const ANALYSIS_MAX_SECONDS = 300;

const jobGuard = createConcurrencyGuard();

const app = express();
app.disable('x-powered-by');
app.use(cors());
app.use(express.json({ limit: '16kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ------------------------------------------------------------------ routes

// Cheap and unmetered: the landing page probes this to decide whether the live
// demo is reachable, so it must answer even when the box is busy.
app.get('/api/health', (req, res) => {
  healthCors(req, res);
  res.json({
    ok: true,
    publicMode: PUBLIC_MODE,
    busy: jobGuard.full,
    maxDurationSeconds: PUBLIC_MODE ? config.maxDurationSeconds : 0,
  });
});

app.post('/api/snatch', rateLimit({
  max: config.snatchPerMin,
  message: 'That is a lot of snatching. Give it a minute, or run it locally with no limits.',
}), async (req, res) => {
  const { url, analyze: wantAnalysis } = req.body ?? {};

  const problem = validateUrl(url);
  if (problem) {
    res.status(400).json({ error: problem });
    return;
  }

  if (jobGuard.full) {
    res.status(503).json({
      error: 'Something else is downloading right now. Try again in a moment.',
    });
    return;
  }

  const job = await createJob(__dirname, url.trim());
  res.status(202).json({ id: job.id });

  // Run the pipeline detached from the request; the browser polls for state.
  jobGuard.enter();
  processJob(job, Boolean(wantAnalysis))
    .catch((err) => {
      job.stage = 'error';
      job.error = explainToolError(err);
    })
    .finally(() => jobGuard.leave());
});

app.get('/api/job/:id', rateLimit({ max: config.pollPerMin }), (req, res) => {
  const job = getJob(req.params.id);
  if (!job) {
    res.status(404).json({ error: 'That snatch has expired. Paste the link again.' });
    return;
  }
  res.json(publicView(job));
});

app.get('/api/job/:id/download', rateLimit({ max: config.downloadPerMin }), async (req, res) => {
  const job = getJob(req.params.id);
  if (!job) {
    res.status(404).json({ error: 'That snatch has expired. Paste the link again.' });
    return;
  }
  if (job.stage !== 'ready' || !job.sourceFile) {
    res.status(409).json({ error: 'This one is still being snatched.' });
    return;
  }

  const format = String(req.query.format || 'mp3').toLowerCase();
  const bitrate = Number(req.query.bitrate) || 320;

  if (format !== 'mp3' && format !== 'wav') {
    res.status(400).json({ error: 'Format must be mp3 or wav.' });
    return;
  }
  if (format === 'mp3' && !MP3_BITRATES.includes(bitrate)) {
    res.status(400).json({ error: `Bitrate must be one of ${MP3_BITRATES.join(', ')}.` });
    return;
  }

  const variant = format === 'wav' ? 'wav' : `mp3-${bitrate}`;

  try {
    let file = job.encoded.get(variant);
    if (!file || !(await exists(file))) {
      file = path.join(job.dir, `${variant}.${format}`);
      await encode(job.sourceFile, file, format, bitrate);
      job.encoded.set(variant, file);
    }

    const filename = buildFilename(job.title, format, job.analysis);
    const { size } = await stat(file);

    res.setHeader('Content-Type', format === 'wav' ? 'audio/wav' : 'audio/mpeg');
    res.setHeader('Content-Disposition', contentDisposition(filename));
    res.setHeader('Content-Length', size);
    res.sendFile(file);
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: `Could not encode that: ${explainToolError(err)}` });
    }
  }
});

app.delete('/api/job/:id', async (req, res) => {
  await destroyJob(req.params.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- pipeline

async function processJob(job, wantAnalysis) {
  job.stage = 'downloading';

  const info = await downloadAudio(job.url, job.dir, (percent) => {
    job.progress = percent;
    job.touchedAt = Date.now();
  }, PUBLIC_MODE ? {
    maxDurationSeconds: config.maxDurationSeconds,
    maxFilesize: config.maxFilesize,
  } : {});

  job.sourceFile = info.file;
  job.title = info.title;
  job.uploader = info.uploader;
  job.duration = info.duration;
  job.thumbnail = info.thumbnail;
  job.progress = 100;

  if (wantAnalysis) {
    job.stage = 'analyzing';
    try {
      job.analysis = await analyzeSource(info.file, info.duration);
    } catch (err) {
      // A failed analysis shouldn't cost the user their download — fall back to
      // a plain filename and say so in the UI.
      job.analysis = { bpm: null, key: null, keyShort: null, camelot: null, failed: true };
      job.analysisError = explainToolError(err);
    }
  }

  job.stage = 'ready';
  job.touchedAt = Date.now();
}

async function analyzeSource(file, duration) {
  let startSec = 0;
  let durationSec = 0;

  // For anything long, measure the middle: intros and outros are the least
  // representative parts of a track.
  if (duration > ANALYSIS_MAX_SECONDS + 60) {
    startSec = Math.max(0, (duration - ANALYSIS_MAX_SECONDS) / 2);
    durationSec = ANALYSIS_MAX_SECONDS;
  }

  const samples = await decodeToMono(file, { startSec, durationSec });
  if (samples.length < ANALYSIS_RATE * 5) {
    throw new Error('Track is too short to analyse reliably.');
  }
  return analyze(samples, ANALYSIS_RATE);
}

// ----------------------------------------------------------------- helpers

function validateUrl(url) {
  if (typeof url !== 'string' || !url.trim()) return 'Paste a link first.';
  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch {
    return "That doesn't look like a link.";
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'Only http and https links are supported.';
  }
  return null;
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

// -------------------------------------------------------------------- boot

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await clearWorkspace(__dirname);
  startSweeper();

  // Express only reads X-Forwarded-For when told there is a proxy in front.
  if (config.trustProxy) app.set('trust proxy', true);

  app.listen(PORT, HOST, () => {
    console.log(`\n  SoundSnatcher listening on http://localhost:${PORT}`);
    if (PUBLIC_MODE) {
      console.log('  public mode: ' +
        `${config.snatchPerMin} snatches/min per IP, ` +
        `${config.maxConcurrentJobs} concurrent, ` +
        `max ${Math.floor(config.maxDurationSeconds / 60)}min per video`);
      if (config.allowedOrigins.length) {
        console.log(`  CORS allowed: ${config.allowedOrigins.join(', ')}`);
      }
    }
    console.log();
  });
}

export { app };
