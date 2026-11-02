import lottie from 'lottie-web/build/player/lottie_light';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { Lottie, type LottieProps } from '../../../src/runtime/lottie';
import move from './move.json';

export { move };

let root: Root | undefined;
const errors: string[] = [];

/**
 * Renders a 100 x 100 px <Lottie> of `move` with `props` over it (null unmounts it), synchronously as the frame renders a
 * scene, and returns the messages of the errors the render threw. The element is built here: tsx would wrap a function
 * the test passes in a `__name` call the page does not define.
 */
export function show(props: Partial<LottieProps> | null): string[] {
  root ??= createRoot(document.body.appendChild(document.createElement('div')), {
    onUncaughtError: (error) => errors.push((error as Error).message),
  });
  flushSync(() => root!.render(props && <Lottie data={move} time={0} style={{ width: 100, height: 100 }} {...props} />));
  return errors.splice(0);
}

const svg = () => document.querySelector('svg')!;

/** The x of the box layer's centre, in px from the left of the animation: the frame shown, with `move`. */
export function boxX(): number {
  const box = svg().querySelector('#box')!.getBoundingClientRect();
  return box.x + box.width / 2 - svg().getBoundingClientRect().x;
}

/** Whether the flag layer, in from frame 29, is drawn. */
export const flagShown = () => svg().querySelector('#flag')!.getBoundingClientRect().width > 0;

export function players(): { animations: number; svgs: number } {
  const registered = (lottie as unknown as { getRegisteredAnimations(): unknown[] }).getRegisteredAnimations();
  return { animations: registered.length, svgs: document.querySelectorAll('svg').length };
}

export const aspect = () => svg().getAttribute('preserveAspectRatio');
