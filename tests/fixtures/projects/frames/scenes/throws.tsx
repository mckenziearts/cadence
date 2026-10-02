import type { SceneProps } from 'cadence';

/** Renders until 0.5 s, then throws. */
export default function Throws({ t }: SceneProps) {
  if (t > 0.5) throw new Error(`Boum à ${t.toFixed(2)} s`);
  return <div style={{ position: 'absolute', inset: 0, background: '#ffffff' }} />;
}
