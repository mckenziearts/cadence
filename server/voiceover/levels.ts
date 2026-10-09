// How loud a spoken sentence is, 25 times a second, for a mouth that opens with the voice. Pure: no fs, no clock.

export const LEVELS_PER_SECOND = 25;

/** RMS of each 40 ms window (the last one may be shorter), scaled so the sentence's loudest window is 255. */
export function levels(samples: Int16Array, sampleRate: number): number[] {
  const count = Math.ceil((samples.length * LEVELS_PER_SECOND) / sampleRate);
  const rms = Array.from({ length: count }, (_, i) => {
    const from = Math.floor((i * sampleRate) / LEVELS_PER_SECOND);
    const to = Math.min(samples.length, Math.floor(((i + 1) * sampleRate) / LEVELS_PER_SECOND));
    let sum = 0;
    for (let s = from; s < to; s++) sum += samples[s] * samples[s];
    return Math.sqrt(sum / (to - from));
  });
  const peak = Math.max(0, ...rms);
  return rms.map((value) => (peak ? Math.round((value / peak) * 255) : 0));
}
