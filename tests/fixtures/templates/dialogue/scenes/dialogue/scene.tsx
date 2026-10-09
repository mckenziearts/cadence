import type { SceneProps } from 'cadence';
import { Mouth } from '../components/Mouth';

export default function Scene({ t, voiceOver }: SceneProps) {
  return (
    <div style={{ position: 'absolute', inset: 0, background: '#ffffff' }}>
      <Mouth voiceOver={voiceOver} t={t} speaker="camille" x={480} />
      <Mouth voiceOver={voiceOver} t={t} speaker="sami" x={1440} />
    </div>
  );
}
