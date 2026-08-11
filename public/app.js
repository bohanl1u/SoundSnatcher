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
  const analyze = el('analyze').checked;
  hideIdleError();

  if (!url) {
    showIdleError('Paste a link first.');
    return;
  }

  showPanel('working');
  setStage('Snatching…', 'Pulling the audio stream', 0);

  let res;
  try {
    res = await fetch('/api/snatch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, analyze }),
    });
  } catch {
    showError('Could not reach the SoundSnatcher server. Is it still running?');
    return;
  }

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    showPanel('idle');
    showIdleError(body.error || 'That link was rejected.');
    return;
  }

  state.jobId = body.id;
  poll();
}

function poll() {
  clearInterval(state.polling);
  state.polling = setInterval(check, 600);
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
    showError(err.message);
    return;
  }

  state.job = job;

  if (job.stage === 'downloading') {
    setStage('Snatching…', 'Pulling the audio stream', job.progress);
  } else if (job.stage === 'analyzing') {
    setStage('Analyzing…', 'Measuring tempo and key', null);
  } else if (job.stage === 'error') {
    clearInterval(state.polling);
    showError(job.error || 'Something went wrong.');
  } else if (job.stage === 'ready') {
    clearInterval(state.polling);
    showReady(job);
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
  const dead = state.jobId;
  state.jobId = null;
  state.job = null;

  el('url').value = '';
  hideIdleError();
  showPanel('idle');
  el('url').focus();

  if (dead) {
    fetch(`/api/job/${dead}`, { method: 'DELETE' }).catch(() => {});
  }
}

// ------------------------------------------------------------------- view

function showPanel(name) {
  for (const [key, node] of Object.entries(panels)) node.hidden = key !== name;
}

function setStage(title, hint, percent) {
  el('stage-text').textContent = title;
  el('stage-hint').textContent = hint;

  const bar = el('progress-bar');
  if (percent == null) {
    // No percentage to report — run the bar as a marquee instead of faking one.
    bar.classList.add('indeterminate');
    bar.style.width = '';
  } else {
    bar.classList.remove('indeterminate');
    bar.style.width = `${Math.max(2, percent)}%`;
  }
}

function showReady(job) {
  el('track-title').textContent = job.title || 'Untitled';

  const bits = [];
  if (job.uploader) bits.push(job.uploader);
  if (job.duration) bits.push(formatDuration(job.duration));
  el('track-sub').textContent = bits.join(' · ');

  const thumb = el('thumb');
  if (job.thumbnail) {
    thumb.src = job.thumbnail;
    thumb.hidden = false;
  } else {
    thumb.hidden = true;
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

  if (analysis.bpm != null) box.append(badge(`${formatBpm(analysis.bpm)} BPM`, 'accent'));
  if (analysis.key) box.append(badge(analysis.key, 'accent'));
  if (analysis.camelot) box.append(badge(analysis.camelot, 'soft'));
}

function badge(text, kind) {
  const span = document.createElement('span');
  span.className = `badge ${kind || ''}`.trim();
  span.textContent = text;
  return span;
}

function buildChips() {
  const chips = el('chips');
  const options = [
    ...MP3_BITRATES.map((b) => ({
      id: `mp3-${b}`, format: 'mp3', bitrate: b, label: 'MP3', sub: `${b} kbps`,
    })),
    { id: 'wav', format: 'wav', bitrate: null, label: 'WAV', sub: '16-bit / 44.1k' },
  ];

  for (const opt of options) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip';
    btn.setAttribute('role', 'radio');
    btn.dataset.id = opt.id;
    btn.innerHTML = `${opt.label}<small>${opt.sub}</small>`;
    btn.setAttribute('aria-checked', String(opt.format === state.format && opt.bitrate === state.bitrate));
    btn.addEventListener('click', () => {
      state.format = opt.format;
      state.bitrate = opt.bitrate ?? state.bitrate;
      for (const other of chips.children) {
        other.setAttribute('aria-checked', String(other === btn));
      }
      updateFilenamePreview();
    });
    chips.append(btn);
  }
}

function updateFilenamePreview() {
  if (!state.job) return;
  el('filename-preview').textContent = buildFilename(
    state.job.title,
    state.format,
    state.job.analysis,
  );
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
