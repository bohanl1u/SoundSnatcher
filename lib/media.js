// Wrappers around the external binaries: yt-dlp for fetching, ffmpeg for
// decoding and encoding. Everything spawns with an argv array — never a shell
// string — so URLs and titles can't be interpreted as commands.

import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

export const YTDLP = process.env.YTDLP_PATH || 'yt-dlp';
export const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

/** Analysis sample rate. Mono at 22.05 kHz is plenty for tempo and chroma. */
export const ANALYSIS_RATE = 22050;

class ToolError extends Error {
  constructor(message, { tool, stderr } = {}) {
    super(message);
    this.name = 'ToolError';
    this.tool = tool;
    this.stderr = stderr;
  }
}

function run(cmd, args, { onStderrLine, onStdoutLine, cwd } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        // yt-dlp is Python, and Python block-buffers stdout when it isn't a
        // TTY — without this, progress lines only arrive once the download has
        // already finished, so the bar sits at 0 and then jumps to done.
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
      });
    } catch (err) {
      reject(new ToolError(`Could not start ${cmd}: ${err.message}`, { tool: cmd }));
      return;
    }

    let stdout = '';
    let stderr = '';
    let outPending = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      stdout += d;
      if (!onStdoutLine) return;
      // Emit whole lines as they arrive. Waiting for the process to exit before
      // reading progress would report every update at once, after the fact.
      outPending += d;
      const lines = outPending.split(/\r?\n|\r/);
      outPending = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) onStdoutLine(line.trim());
    });

    let pending = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => {
      stderr += d;
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
      if (!onStderrLine) return;
      pending += d;
      const lines = pending.split(/\r?\n|\r/);
      pending = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) onStderrLine(line.trim());
    });

    child.on('error', (err) => {
      reject(new ToolError(
        err.code === 'ENOENT'
          ? `${cmd} is not installed or not on PATH.`
          : `${cmd} failed to start: ${err.message}`,
        { tool: cmd },
      ));
    });

    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new ToolError(`${cmd} exited with code ${code}`, { tool: cmd, stderr }));
    });
  });
}

/** Last few meaningful lines of stderr, for surfacing a real reason in the UI. */
export function explainToolError(err) {
  if (!(err instanceof ToolError)) return err.message;
  const lines = (err.stderr || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('[download]') && !l.startsWith('WARNING:'));
  const errorLine = lines.reverse().find((l) => /^ERROR:/i.test(l));
  if (errorLine) return errorLine.replace(/^ERROR:\s*/i, '');
  return lines[0] || err.message;
}

/**
 * Download the best available audio-only stream into `dir`.
 * Calls onProgress(percent) as yt-dlp reports it.
 * Resolves with { file, title, uploader, duration, thumbnail, webpageUrl }.
 */
export async function downloadAudio(url, dir, onProgress) {
  const args = [
    '--no-playlist',
    '--no-warnings',
    '--no-part',
    // --print-json implies quiet, which silences the progress bar; --progress
    // forces it back on, and --newline puts each update on its own line so it
    // can be parsed as it streams.
    '--newline',
    '--progress',
    // YouTube hands out transient 403s; yt-dlp recovers by retrying, often
    // against a different player client, so let it.
    '--retries', '5',
    '--extractor-retries', '3',
    '--fragment-retries', '5',
    '-f', 'bestaudio/best',
    '-o', path.join(dir, 'source.%(ext)s'),
    '--print-json',
    url,
  ];

  const { stdout } = await run(YTDLP, args, {
    onStdoutLine: (line) => {
      const m = /\[download\]\s+([\d.]+)%/.exec(line);
      if (m && onProgress) onProgress(Number(m[1]));
    },
  });

  // --print-json emits one JSON object per download on stdout, mixed in with the
  // progress lines already consumed above.
  let info = null;
  for (const line of stdout.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try { info = JSON.parse(t); } catch { /* keep looking */ }
  }

  const file = info?._filename && path.isAbsolute(info._filename)
    ? info._filename
    : await findSource(dir);

  if (!file) throw new ToolError('Download finished but no audio file was produced.', { tool: YTDLP });

  return {
    file,
    title: info?.title || path.parse(file).name,
    uploader: info?.uploader || info?.channel || '',
    duration: Number(info?.duration) || 0,
    thumbnail: info?.thumbnail || '',
    webpageUrl: info?.webpage_url || url,
  };
}

async function findSource(dir) {
  const entries = await readdir(dir);
  const match = entries.find((e) => e.startsWith('source.'));
  return match ? path.join(dir, match) : null;
}

/**
 * Decode any audio file to mono float32 PCM at ANALYSIS_RATE.
 * `startSec`/`durationSec` trim before decoding so we never hold a whole
 * DJ mix in memory just to measure its tempo.
 */
export function decodeToMono(file, { startSec = 0, durationSec = 0 } = {}) {
  const args = ['-hide_banner', '-loglevel', 'error'];
  if (startSec > 0) args.push('-ss', String(startSec));
  args.push('-i', file);
  if (durationSec > 0) args.push('-t', String(durationSec));
  args.push('-vn', '-ac', '1', '-ar', String(ANALYSIS_RATE), '-f', 'f32le', '-');

  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let total = 0;
    let stderr = '';

    child.stdout.on('data', (c) => { chunks.push(c); total += c.length; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => reject(new ToolError(`ffmpeg failed to start: ${err.message}`, { tool: FFMPEG })));
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new ToolError(`ffmpeg exited with code ${code}`, { tool: FFMPEG, stderr }));
        return;
      }
      const buf = Buffer.concat(chunks, total);
      // Trim to a whole number of float32 samples, then copy into an aligned
      // buffer (Buffer.concat gives no alignment guarantee for Float32Array).
      const usable = buf.length - (buf.length % 4);
      const out = new Float32Array(usable / 4);
      for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4);
      resolve(out);
    });
  });
}

/** Re-encode the downloaded source into a delivery format. */
export async function encode(source, dest, format, bitrate) {
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', source, '-vn', '-map_metadata', '-1'];

  if (format === 'wav') {
    args.push('-c:a', 'pcm_s16le', '-ar', '44100');
  } else {
    args.push('-c:a', 'libmp3lame', '-b:a', `${bitrate}k`, '-ar', '44100');
  }

  args.push(dest);
  await run(FFMPEG, args);
  return dest;
}
