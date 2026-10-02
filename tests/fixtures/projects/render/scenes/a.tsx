import type { SceneProps } from 'cadence';

/** Red with a white box sliding right. */
export default function A({ t }: SceneProps) {
  return (
    <div style={{ position: 'absolute', inset: 0, background: '#ff0000' }}>
      <div style={{ position: 'absolute', left: 100 + t * 800, top: 100, width: 200, height: 200, background: '#ffffff' }} />
    </div>
  );
}
