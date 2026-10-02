import type { SceneProps } from 'cadence';

/** Red until 0.5 s, then blue; exposes its props for the tests. */
export default function RedBlue({ t, duration, width, height, format, orientation, fps, scene }: SceneProps) {
  return (
    <div style={{ position: 'absolute', inset: 0, background: t < 0.5 ? '#ff0000' : '#0000ff' }}>
      <div id="props" data-props={JSON.stringify({ t, duration, width, height, format, orientation, fps, scene })} />
    </div>
  );
}
