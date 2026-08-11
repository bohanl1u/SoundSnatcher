// Minimal iterative radix-2 Cooley-Tukey FFT.
// Operates in place on separate real/imaginary Float64Arrays.

const twiddleCache = new Map();

function twiddles(n) {
  let t = twiddleCache.get(n);
  if (t) return t;
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((-2 * Math.PI * i) / n);
    sin[i] = Math.sin((-2 * Math.PI * i) / n);
  }
  t = { cos, sin };
  twiddleCache.set(n, t);
  return t;
}

/** In-place forward FFT. `n` must be a power of two. */
export function fft(re, im) {
  const n = re.length;
  if ((n & (n - 1)) !== 0) throw new Error(`FFT size ${n} is not a power of two`);

  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let tmp = re[i]; re[i] = re[j]; re[j] = tmp;
      tmp = im[i]; im[i] = im[j]; im[j] = tmp;
    }
  }

  const { cos, sin } = twiddles(n);
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const step = n / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0, t = 0; k < half; k++, t += step) {
        const wr = cos[t];
        const wi = sin[t];
        const a = i + k;
        const b = a + half;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
      }
    }
  }
}

/** Periodic Hann window of length n. */
export function hann(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

/**
 * Magnitude spectrogram of a mono signal.
 * Returns { frames, bins, data } where data is a flat Float32Array of
 * frames * bins magnitudes (bins = fftSize / 2 + 1).
 */
export function spectrogram(samples, fftSize, hopSize) {
  const bins = fftSize / 2 + 1;
  const frames = Math.max(0, Math.floor((samples.length - fftSize) / hopSize) + 1);
  const data = new Float32Array(frames * bins);
  const win = hann(fftSize);
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);

  for (let f = 0; f < frames; f++) {
    const off = f * hopSize;
    for (let i = 0; i < fftSize; i++) {
      re[i] = samples[off + i] * win[i];
      im[i] = 0;
    }
    fft(re, im);
    const base = f * bins;
    for (let k = 0; k < bins; k++) {
      data[base + k] = Math.hypot(re[k], im[k]);
    }
  }

  return { frames, bins, data };
}
