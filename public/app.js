const MP3_BITRATES = [128, 192, 256, 320];

const el = (id) => document.getElementById(id);

const panels = {
  idle: el('panel-idle'),
  working: el('panel-working'),
  ready: el('panel-ready'),
  error: el('panel-error'),
};

const state = {
  jobId: null,
  job: null,
  format: 'mp3',
  bitrate: 320,
  polling: null,
  wantAnalysis: false,
};

// The bar is driven by an animation loop rather than written straight from the
// server value: yt-dlp reports nothing at all while it resolves the video, and
// a bar frozen at 0% reads as broken. `shown` always advances.
const bar = {
  shown: 0,
  serverPct: 0,
  phase: 'downloading',
  raf: null,
  last: 0,
};

// ------------------------------------------------------------------ setup

buildChips();

el('snatch-form').addEventListener('submit', (e) => {
  e.preventDefault();
  startSnatch();
});

el('another').addEventListener('click', reset);
el('another-error').addEventListener('click', reset);
el('download').addEventListener('click', download);

// ------------------------------------------------------------------ flow

async function startSnatch() {
  const url = el('url').value.trim();
  state.wantAnalysis = el('analyze').checked;
  hideIdleError();

  if (!url) {
    showIdleError('Paste a link first.');
    return;
  }

  showPanel('working');
  startBar();

  let res;
  try {
    res = await fetch('/api/snatch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, analyze: state.wantAnalysis }),
    });
  } catch {
    stopBar();
    showError('Could not reach the SoundSnatcher server. Is it still running?');
    return;
  }

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    stopBar();
    showPanel('idle');
    showIdleError(body.error || 'That link was rejected.');
    return;
  }

  state.jobId = body.id;
  poll();
}

function poll() {
  clearInterval(state.polling);
  state.polling = setInterval(check, 500);
  check();
}

async function check() {
  if (!state.jobId) return;

  let job;
  try {
    const res = await fetch(`/api/job/${state.jobId}`);
    job = await res.json();
    if (!res.ok) throw new Error(job.error || 'Lost track of that job.');
  } catch (err) {
    clearInterval(state.polling);
    stopBar();
    showError(err.message);
    return;
  }

  state.job = job;
  bar.serverPct = job.progress;
  bar.phase = job.stage;

  if (job.stage === 'downloading') {
    setStageText('Snatching', job.progress < 1 ? 'Finding the audio stream' : 'Pulling the audio stream');
  } else if (job.stage === 'analyzing') {
    setStageText('Analyzing', 'Measuring tempo and key');
  } else if (job.stage === 'error') {
    clearInterval(state.polling);
    stopBar();
    showError(job.error || 'Something went wrong.');
  } else if (job.stage === 'ready') {
    clearInterval(state.polling);
    finishBar(() => showReady(job));
  }
}

function download() {
  if (!state.jobId) return;
  const params = new URLSearchParams({ format: state.format });
  if (state.format === 'mp3') params.set('bitrate', String(state.bitrate));

  const a = document.createElement('a');
  a.href = `/api/job/${state.jobId}/download?${params}`;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function reset() {
  clearInterval(state.polling);
  stopBar();
  const dead = state.jobId;
  state.jobId = null;
  state.job = null;

  el('url').value = '';
  el('ambient').classList.remove('on');
  hideIdleError();
  showPanel('idle');
  el('url').focus();

  if (dead) fetch(`/api/job/${dead}`, { method: 'DELETE' }).catch(() => {});
}

// -------------------------------------------------------------------- bar

/** Download occupies this much of the bar when an analysis pass follows it. */
const DOWNLOAD_SPAN_WITH_ANALYSIS = 70;

function startBar() {
  bar.shown = 0;
  bar.serverPct = 0;
  bar.phase = 'downloading';
  bar.last = performance.now();
  setStageText('Snatching', 'Finding the audio stream');
  paintBar();
  if (!bar.raf) bar.raf = requestAnimationFrame(tickBar);
}

function stopBar() {
  if (bar.raf) cancelAnimationFrame(bar.raf);
  bar.raf = null;
}

function tickBar(now) {
  const dt = Math.min(0.05, (now - bar.last) / 1000);
  bar.last = now;

  const span = state.wantAnalysis ? DOWNLOAD_SPAN_WITH_ANALYSIS : 100;
  let pull;
  let ceiling;

  if (bar.phase === 'analyzing') {
    // No percentage exists for analysis, so let the creep carry this stretch
    // rather than yanking the bar straight to the top.
    pull = span;
    ceiling = 99;
  } else if (bar.phase === 'ready') {
    pull = 100;
    ceiling = 100;
  } else {
    pull = (bar.serverPct / 100) * span;
    // Never let creep alone complete the phase — only real progress does that.
    ceiling = span - 2;
  }

  // Creep: even with no news, drift toward the ceiling, slowing as it closes in.
  const creeped = bar.shown + Math.max(0, ceiling - bar.shown) * 0.28 * dt;
  const target = Math.min(ceiling, Math.max(pull, creeped));

  bar.shown = Math.max(bar.shown, bar.shown + (target - bar.shown) * (1 - Math.exp(-9 * dt)));
  paintBar();

  bar.raf = requestAnimationFrame(tickBar);
}

function paintBar() {
  el('progress-bar').style.width = `${Math.min(100, bar.shown).toFixed(1)}%`;
  el('percent').textContent = `${Math.round(Math.min(100, bar.shown))}%`;
}

/** Run the bar cleanly out to 100% before revealing the result. */
function finishBar(done) {
  bar.phase = 'ready';
  const started = performance.now();
  const from = bar.shown;
  stopBar();

  let handedOff = false;
  const handOff = () => {
    if (handedOff) return;
    handedOff = true;
    clearTimeout(guard);
    bar.shown = 100;
    paintBar();
    done();
  };

  // rAF is paused in a background tab, so the polish animation alone can't be
  // trusted to hand over — without this the panel would sit at 100% until the
  // tab was looked at again.
  const guard = setTimeout(handOff, 900);

  const step = (now) => {
    if (handedOff) return;
    const t = Math.min(1, (now - started) / 420);
    bar.shown = from + (100 - from) * (1 - (1 - t) ** 3);
    paintBar();
    if (t < 1) requestAnimationFrame(step);
    else setTimeout(handOff, 140);
  };
  requestAnimationFrame(step);
}

// ------------------------------------------------------------------- view

function showPanel(name) {
  for (const [key, node] of Object.entries(panels)) node.hidden = key !== name;
}

function setStageText(title, hint) {
  el('stage-text').textContent = title;
  el('stage-hint').textContent = hint;
}

function showReady(job) {
  el('track-title').textContent = job.title || 'Untitled';

  const bits = [];
  if (job.uploader) bits.push(job.uploader);
  if (job.duration) bits.push(formatDuration(job.duration));
  el('track-sub').textContent = bits.join(' · ');

  const thumb = el('thumb');
  const ambient = el('ambient');
  if (job.thumbnail) {
    thumb.src = job.thumbnail;
    thumb.hidden = false;
    // Pull the artwork into the page background as a soft wash. Quotes and
    // backslashes are stripped so the URL can't break out of the url("…").
    ambient.style.backgroundImage = `url("${job.thumbnail.replace(/["\\]/g, '')}")`;
    requestAnimationFrame(() => ambient.classList.add('on'));
  } else {
    thumb.hidden = true;
    ambient.classList.remove('on');
  }

  renderBadges(job.analysis);
  updateFilenamePreview();
  showPanel('ready');
  el('download').focus();
}

function renderBadges(analysis) {
  const box = el('badges');
  box.replaceChildren();
  if (!analysis) return;

  if (analysis.failed || (analysis.bpm == null && !analysis.key)) {
    box.append(badge("Couldn't read key or BPM", 'soft'));
    return;
  }

  const made = [];
  if (analysis.bpm != null) made.push(badge('— BPM', 'accent', analysis.bpm));
  if (analysis.key) made.push(badge(analysis.key, 'accent'));
  if (analysis.camelot) made.push(badge(analysis.camelot, 'soft'));

  made.forEach((node, i) => {
    node.style.animationDelay = `${i * 70}ms`;
    box.append(node);
  });
}

function badge(text, kind, countTo) {
  const span = document.createElement('span');
  span.className = `badge ${kind || ''}`.trim();
  span.textContent = text;
  if (countTo != null) countUp(span, countTo);
  return span;
}

/** Tick the BPM up to its value rather than snapping it in. */
function countUp(node, value) {
  const started = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - started) / 750);
    const eased = 1 - (1 - t) ** 3;
    const shown = value * eased;
    node.textContent = `${t < 1 ? Math.round(shown) : formatBpm(value)} BPM`;
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function buildChips() {
  const chips = el('chips');
  const options = [
    ...MP3_BITRATES.map((b) => ({ format: 'mp3', bitrate: b, label: 'MP3', sub: `${b} kbps` })),
    { format: 'wav', bitrate: null, label: 'WAV', sub: '16-bit · 44.1k' },
  ];

  for (const opt of options) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip';
    btn.setAttribute('role', 'radio');
    btn.innerHTML = `${opt.label}<small>${opt.sub}</small>`;
    btn.setAttribute('aria-checked', String(opt.format === state.format && opt.bitrate === state.bitrate));
    btn.addEventListener('click', () => {
      state.format = opt.format;
      state.bitrate = opt.bitrate ?? state.bitrate;
      for (const other of chips.children) other.setAttribute('aria-checked', String(other === btn));
      updateFilenamePreview();
    });
    chips.append(btn);
  }
}

function updateFilenamePreview() {
  if (!state.job) return;
  el('filename-preview').textContent = buildFilename(state.job.title, state.format, state.job.analysis);
}

// Mirrors lib/naming.js so the preview matches the file that actually lands.
function buildFilename(title, extension, analysis) {
  let base = sanitize(title);
  if (analysis && !analysis.failed) {
    const parts = [];
    const bpm = formatBpm(analysis.bpm);
    if (bpm) parts.push(`${bpm}BPM`);
    if (analysis.keyShort) parts.push(analysis.keyShort);
    if (parts.length) base = `${base} - ${parts.join(' - ')}`;
  }
  return `${sanitize(base)}.${extension}`;
}

function sanitize(name) {
  const cleaned = (name || 'audio')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[/\\:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .trim();
  return (cleaned || 'audio').slice(0, 150);
}

function formatBpm(bpm) {
  if (bpm == null) return null;
  const rounded = Math.round(bpm * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function formatDuration(seconds) {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

function showIdleError(message) {
  const node = el('idle-error');
  node.textContent = message;
  node.hidden = false;
}

function hideIdleError() {
  el('idle-error').hidden = true;
}

function showError(message) {
  el('error-detail').textContent = message;
  showPanel('error');
}
