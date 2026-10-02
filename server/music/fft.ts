// Adapted from saeedvaziry/caleb-video-editor (MIT)
// Iterative radix-2 FFT with precomputed tables, plus a helper that computes the
// power spectra of two real frames with a single complex transform.

export class FFT {
  readonly size: number;
  private readonly rev: Uint32Array;
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;
  private readonly re: Float64Array;
  private readonly im: Float64Array;

  constructor(size: number) {
    if (size < 2 || (size & (size - 1)) !== 0) throw new Error(`FFT size must be a power of two, got ${size}`);
    this.size = size;
    const bits = Math.round(Math.log2(size));
    this.rev = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.cos = new Float64Array(size / 2);
    this.sin = new Float64Array(size / 2);
    for (let i = 0; i < size / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / size);
      this.sin[i] = -Math.sin((2 * Math.PI * i) / size);
    }
    this.re = new Float64Array(size);
    this.im = new Float64Array(size);
  }

  /** In-place forward complex FFT. */
  transform(re: Float64Array, im: Float64Array): void {
    const n = this.size;
    const rev = this.rev;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        const tr = re[i];
        re[i] = re[j];
        re[j] = tr;
        const ti = im[i];
        im[i] = im[j];
        im[j] = ti;
      }
    }
    const cos = this.cos;
    const sin = this.sin;
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0, t = 0; k < half; k++, t += step) {
          const wr = cos[t];
          const wi = sin[t];
          const a = start + k;
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

  /**
   * Power spectra (bins 0..size/2 inclusive) of two real, already-windowed
   * frames `x` and `y`, computed with one complex FFT of x + i * y.
   */
  powerPair(x: Float64Array, y: Float64Array, outX: Float64Array, outY: Float64Array): void {
    const n = this.size;
    const re = this.re;
    const im = this.im;
    re.set(x);
    im.set(y);
    this.transform(re, im);
    const half = n >> 1;
    for (let k = 0; k <= half; k++) {
      const nk = (n - k) & (n - 1);
      const zr = re[k];
      const zi = im[k];
      const cr = re[nk];
      const ci = -im[nk];
      // X[k] = (Z[k] + conj Z[n-k]) / 2
      const xr = (zr + cr) * 0.5;
      const xi = (zi + ci) * 0.5;
      // Y[k] = (Z[k] - conj Z[n-k]) / 2i
      const yr = (zi - ci) * 0.5;
      const yi = -(zr - cr) * 0.5;
      outX[k] = xr * xr + xi * xi;
      outY[k] = yr * yr + yi * yi;
    }
  }
}

export function hann(size: number): Float64Array {
  const w = new Float64Array(size);
  for (let i = 0; i < size; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
  return w;
}

/**
 * Short-time power spectrogram with centered (zero-padded) frames: frame `i`
 * is centered on sample `i * hop`. Returns `frames × (size/2 + 1)` powers.
 */
export function powerSpectrogram(signal: Float32Array, size: number, hop: number): Float64Array[] {
  const fft = new FFT(size);
  const window = hann(size);
  const bins = size / 2 + 1;
  const count = 1 + Math.floor(signal.length / hop);
  const out: Float64Array[] = new Array(count);
  const half = size >> 1;
  const a = new Float64Array(size);
  const b = new Float64Array(size);

  const fill = (dest: Float64Array, frame: number) => {
    const start = frame * hop - half;
    for (let j = 0; j < size; j++) {
      const s = start + j;
      dest[j] = s >= 0 && s < signal.length ? signal[s] * window[j] : 0;
    }
  };

  for (let f = 0; f < count; f += 2) {
    fill(a, f);
    const second = f + 1 < count;
    if (second) fill(b, f + 1);
    else b.fill(0);
    const pa = new Float64Array(bins);
    const pb = new Float64Array(bins);
    fft.powerPair(a, b, pa, pb);
    out[f] = pa;
    if (second) out[f + 1] = pb;
  }
  return out;
}
