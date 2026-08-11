// Sanity-checks the analyser against synthetic audio with known ground truth.
//   node scripts/selftest.js

import { analyze } from '../lib/analyze.js';

const SR = 22050;
const NOTE = { C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11 };

/** Percussive click track: a decaying noise burst on every beat. */
function clickTrack(bpm, seconds) {
  const out = new Float32Array(SR * seconds);
  const period = (60 / bpm) * SR;
  for (let beat = 0; beat * period < out.length; beat++) {
    const start = Math.round(beat * period);
    const len = Math.round(SR * 0.06);
    // Accent the downbeat so the envelope has real structure, not just a pulse.
    const gain = beat % 4 === 0 ? 1 : 0.55;
    for (let i = 0; i < len && start + i < out.length; i++) {
      const decay = Math.exp(-i / (SR * 0.012));
      out[start + i] += (Math.random() * 2 - 1) * decay * gain;
    }
  }
  return out;
}

function midiToFreq(midi) {
  return 440 * 2 ** ((midi - 69) / 12);
}

/** Chord bed: each chord held for `chordSeconds`, three harmonics per note. */
function chordProgression(chords, chordSeconds) {
  const total = Math.round(SR * chordSeconds * chords.length);
  const out = new Float32Array(total);
  const chordLen = Math.round(SR * chordSeconds);

  chords.forEach((notes, ci) => {
    const offset = ci * chordLen;
    for (const midi of notes) {
      const f0 = midiToFreq(midi);
      for (let h = 1; h <= 4; h++) {
        const freq = f0 * h;
        if (freq > SR / 2 - 100) break;
        const amp = 0.22 / h;
        for (let i = 0; i < chordLen && offset + i < total; i++) {
          // Gentle fade at the chord edges to avoid broadband click artefacts.
          const env = Math.min(1, i / (SR * 0.05), (chordLen - i) / (SR * 0.05));
          out[offset + i] += Math.sin((2 * Math.PI * freq * i) / SR) * amp * env;
        }
      }
    }
  });
  return out;
}

function mix(a, b, gainB = 1) {
  const n = Math.max(a.length, b.length);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (a[i] || 0) + (b[i] || 0) * gainB;
  return out;
}

// Triad plus a root note two octaves down, so the low register carries a real
// bass line the way actual music does.
const chord = (rootMidi, mode) => {
  const third = mode === 'minor' ? 3 : 4;
  return [rootMidi - 24, rootMidi, rootMidi + third, rootMidi + 7];
};

const cases = [];

// --- tempo -----------------------------------------------------------------
for (const bpm of [90, 100, 128, 140, 174]) {
  cases.push({
    name: `click track @ ${bpm} BPM`,
    signal: clickTrack(bpm, 30),
    expect: (r) => {
      const off = Math.abs(r.bpm - bpm);
      return { pass: off <= 1.5, got: `${r.bpm} BPM`, want: `${bpm} BPM` };
    },
  });
}

// --- key -------------------------------------------------------------------
// i - iv - V - i in A minor. The E major chord carries G#, the raised leading
// tone, which is the note that actually distinguishes A minor from its
// relative C major — a loop like Am-F-C-G contains only C-major scale tones and
// is genuinely ambiguous to any detector working from pitch statistics alone.
const aMinor = [chord(57, 'minor'), chord(62, 'minor'), chord(64, 'major'), chord(57, 'minor')];
// I - V - vi - IV in C major.
const cMajor = [chord(60, 'major'), chord(67, 'major'), chord(69, 'minor'), chord(65, 'major')];
// I - V - vi - IV in F# major (checks the black keys too).
const fSharpMajor = [chord(66, 'major'), chord(61, 'major'), chord(63, 'minor'), chord(59, 'major')];

const keyCases = [
  { name: 'A minor progression', chords: aMinor, want: 'A Minor' },
  { name: 'C major progression', chords: cMajor, want: 'C Major' },
  { name: 'F# major progression', chords: fSharpMajor, want: 'F# Major' },
];

for (const kc of keyCases) {
  const repeated = [];
  for (let i = 0; i < 4; i++) repeated.push(...kc.chords);
  cases.push({
    name: kc.name,
    signal: chordProgression(repeated, 2),
    expect: (r) => ({ pass: r.key === kc.want, got: r.key, want: kc.want }),
  });
}

// --- both at once ----------------------------------------------------------
{
  const repeated = [];
  for (let i = 0; i < 8; i++) repeated.push(...aMinor);
  const harmony = chordProgression(repeated, 1.875); // 4 beats @ 128 BPM
  const drums = clickTrack(128, 60);
  cases.push({
    name: 'A minor @ 128 BPM (drums + harmony)',
    signal: mix(harmony, drums, 0.8),
    expect: (r) => {
      const bpmOk = Math.abs(r.bpm - 128) <= 1.5;
      const keyOk = r.key === 'A Minor';
      return {
        pass: bpmOk && keyOk,
        got: `${r.bpm} BPM / ${r.key}`,
        want: '128 BPM / A Minor',
      };
    },
  });
}

// --- run -------------------------------------------------------------------
let failures = 0;
for (const c of cases) {
  const started = Date.now();
  const result = analyze(c.signal, SR);
  const verdict = c.expect(result);
  const ms = Date.now() - started;
  if (!verdict.pass) failures++;
  const mark = verdict.pass ? '  ok  ' : ' FAIL ';
  const detail = verdict.pass ? verdict.got : `${verdict.got}  (expected ${verdict.want})`;
  console.log(`${mark} ${c.name.padEnd(38)} ${String(detail).padEnd(30)} ${ms}ms`);
}

console.log(`\n${cases.length - failures}/${cases.length} passed`);
process.exit(failures ? 1 : 0);
