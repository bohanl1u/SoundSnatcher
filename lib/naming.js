// Filename construction and the HTTP header that carries it.

/** Strip anything that upsets a filesystem, and keep the length sane. */
export function sanitize(name) {
  const cleaned = (name || 'audio')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[/\\:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .trim();
  return (cleaned || 'audio').slice(0, 150);
}

/** BPM as a short string: 128 rather than 128.0, but 128.5 kept intact. */
export function formatBpm(bpm) {
  if (bpm == null) return null;
  const rounded = Math.round(bpm * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/**
 * Build the download filename. With analysis on, the BPM and key ride along in
 * the name — "Track Name - 128BPM - F#min.mp3" — which is what a DJ library
 * expects to sort on.
 */
export function buildFilename(title, extension, analysis) {
  let base = sanitize(title);
  if (analysis) {
    const parts = [];
    const bpm = formatBpm(analysis.bpm);
    if (bpm) parts.push(`${bpm}BPM`);
    if (analysis.keyShort) parts.push(analysis.keyShort);
    if (parts.length) base = `${base} - ${parts.join(' - ')}`;
  }
  return `${sanitize(base)}.${extension}`;
}

/**
 * Content-Disposition that survives non-ASCII titles: a stripped-down ASCII
 * fallback for old clients plus the RFC 5987 encoded real name.
 */
export function contentDisposition(filename) {
  // eslint-disable-next-line no-control-regex
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) =>
    `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
