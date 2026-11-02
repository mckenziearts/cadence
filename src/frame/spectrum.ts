// The spectrum a scene's music.spectrum() reads: the file the analysis wrote beside the track, checked, or why there is none.
import type { MusicSpectrumData } from '../runtime/music';
import type { MusicSpectrum, ProjectMusic } from '../shared/types';
import type { texts } from './texts';

type SpectrumTexts = Pick<typeof texts, 'spectrumFailed' | 'spectrumSize' | 'spectrumPending'>;

/** The file on this frame's origin: each segment is encoded, the slashes stay. */
export const spectrumUrl = (dir: string, file: MusicSpectrum) =>
  `/@fs${dir}/${file.file.split('/').map(encodeURIComponent).join('/')}`;

/** A file the server did not serve, or one of another size, is a load error: bars read from it would be wrong. */
export async function readSpectrum(file: MusicSpectrum, res: Response, t: SpectrumTexts): Promise<MusicSpectrumData> {
  if (!res.ok) throw new Error(t.spectrumFailed(file.file, `HTTP ${res.status}`));
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length !== file.size) throw new Error(t.spectrumFailed(file.file, t.spectrumSize(bytes.length, file.size)));
  return { bands: file.bands, rate: file.rate, bytes };
}

/** A track without its spectrum yet: bars drawn from zeros would look like silence, so the scene fails instead. */
export function spectrumFor(
  music: ProjectMusic | null,
  loaded: MusicSpectrumData | null,
  t: SpectrumTexts,
): MusicSpectrumData | Error | null {
  if (loaded) return loaded;
  return music ? Object.assign(new Error(t.spectrumPending), { name: 'MusicAnalysisPending' }) : null;
}
