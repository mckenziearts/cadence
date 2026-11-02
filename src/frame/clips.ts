// What a scene's <Clip src> shows: the frames the server extracted from the asset, or why there are none.
import type { ClipSource } from '../runtime/clip';
import type { ClipState } from '../shared/types';
import type { texts } from './texts';

type ClipTexts = Pick<typeof texts, 'clipUnknown' | 'clipPreparing' | 'clipFailed'>;

/** Clips are keyed by their path under assets/; frame files are numbered from 1 on this frame's origin. */
export function clipSources(dir: string, clips: Record<string, ClipState>, t: ClipTexts) {
  return (file: string): ClipSource | Error => {
    const clip = Object.hasOwn(clips, file) ? clips[file] : undefined;
    if (!clip) return new Error(t.clipUnknown(file));
    if (clip.status === 'preparing') return new Error(t.clipPreparing(file));
    if (clip.status === 'error') return new Error(t.clipFailed(file, clip.error));
    const folder = `/@fs${dir}/clips/${clip.key}/`;
    return { fps: clip.fps, frames: clip.frames, url: (index) => `${folder}${String(index + 1).padStart(6, '0')}.jpg` };
  };
}

/**
 * Decodes the images whose src changed since their last decode. Returns the errors of the clip frames (marked
 * data-cadence-clip) that did not decode; a failed image is tried again at the next call.
 */
export async function decodeImages(
  images: Iterable<HTMLImageElement>,
  decoded: WeakMap<HTMLImageElement, string>,
  t: Pick<typeof texts, 'clipFrameFailed'>,
): Promise<string[]> {
  const failed: string[] = [];
  await Promise.all(
    Array.from(images)
      .filter((img) => decoded.get(img) !== img.src)
      .map((img) =>
        img.decode().then(
          () => decoded.set(img, img.src),
          () => {
            const file = img.dataset.cadenceClip;
            if (file !== undefined) failed.push(t.clipFrameFailed(file, img.src.slice(img.src.lastIndexOf('/') + 1)));
          },
        ),
      ),
  );
  return failed;
}
