// The light player has no expression support: the full one evaluates expressions with eval, which the frame CSP refuses.
import lottie, { type AnimationItem } from 'lottie-web/build/player/lottie_light';
import { useLayoutEffect, useMemo, useRef, type CSSProperties } from 'react';
import { lottieProblem, type LottieProblem } from '../shared/lottie';

const TEXTS = {
  fr: {
    header:
      'Lottie : data n’est pas une animation Lottie (v, fr, ip, op, w, h et layers attendus, op au moins une frame après ip).',
    image: (path: string) =>
      `Lottie : l’animation charge une image externe (${path}) : intégrez les images au fichier (data: URI), une scène ne charge rien d’autre.`,
    font: (path: string) =>
      `Lottie : l’animation charge une police externe (${path}) : convertissez le texte en formes, une scène ne charge rien d’autre.`,
    file: (path: string) =>
      `Lottie : l’animation charge un autre fichier (${path}) : exportez-la en un seul fichier, sans données externes ni segments, une scène ne charge rien d’autre.`,
  },
  en: {
    header: 'Lottie: data is not a Lottie animation (v, fr, ip, op, w, h and layers expected, op at least one frame after ip).',
    image: (path: string) =>
      `Lottie: the animation loads an external image (${path}): embed the images in the file (data: URI), a scene loads nothing else.`,
    font: (path: string) =>
      `Lottie: the animation loads an external font (${path}): convert the text to shapes, a scene loads nothing else.`,
    file: (path: string) =>
      `Lottie: the animation loads another file (${path}): export it as one file, without external data or segments, a scene loads nothing else.`,
  },
};

const ASPECT = { contain: 'xMidYMid meet', cover: 'xMidYMid slice', fill: 'none' };

export interface LottieProps {
  data: object;
  time: number;
  loop?: boolean;
  fit?: keyof typeof ASPECT;
  style?: CSSProperties;
}

interface Header {
  fr: number;
  ip: number;
  op: number;
  w: number;
  h: number;
}

function message(problem: LottieProblem): string {
  const texts = TEXTS[document.documentElement.lang === 'en' ? 'en' : 'fr'];
  return problem.kind === 'header' ? texts.header : texts[problem.kind](problem.path);
}

/** The frame to show, counted from ip as lottie-web's goToAndStop expects it. */
function frameAt({ fr, ip, op }: Header, time: number, loop: boolean): number {
  if (!Number.isFinite(time)) throw new RangeError(`<Lottie> time must be a finite number of seconds, got ${time}`);
  // A millionth of a frame: 0.29 * 100 is 28.999999999999996, and 0.29 s must show frame 29, where a layer may start.
  const frame = Math.round(time * fr * 1e6) / 1e6;
  const frames = Math.floor(op - ip);
  // A layer ends before its op: past op - 1 the last frame holds, as lottie-web does when it plays to the end.
  return loop ? ((frame % frames) + frames) % frames : Math.min(Math.max(frame, 0), frames - 1);
}

/**
 * The SVG player is built when the component mounts or gets new data or fit, and then only seeks: loadAnimation parses
 * the file and builds the whole SVG tree.
 */
export function Lottie({ data, time, loop = false, fit = 'contain', style }: LottieProps) {
  const container = useRef<HTMLDivElement>(null);
  const player = useRef<AnimationItem | null>(null);
  // The check reads the copy lottie-web plays: structuredClone keeps own properties only, and a JSON import can set a
  // prototype (a "__proto__" key) whose properties the check would read and lottie-web would never see.
  const problem = useMemo(() => lottieProblem(structuredClone(data)), [data]);
  if (problem) throw new Error(message(problem));
  const header = data as Header;
  const frame = frameAt(header, time, loop);
  useLayoutEffect(() => {
    const animation = lottie.loadAnimation({
      container: container.current!,
      renderer: 'svg',
      loop: false,
      autoplay: false,
      // lottie-web writes into the data it plays (completed layers, emptied assets): the scene's import stays as it is.
      animationData: structuredClone(data),
      rendererSettings: { preserveAspectRatio: ASPECT[fit] },
    });
    player.current = animation;
    return () => {
      animation.destroy();
      player.current = null;
    };
  }, [data, fit]);
  useLayoutEffect(() => {
    player.current!.goToAndStop(frame, true);
  });
  return <div ref={container} style={{ aspectRatio: `${header.w} / ${header.h}`, ...style }} />;
}
