import { asset, type SceneProps } from 'cadence';

/** Brand kit, brand font and a project asset. */
export default function Brand({ brand }: SceneProps) {
  const { ui, colors, fonts } = brand;
  return (
    <div style={{ position: 'absolute', inset: 0, background: colors.primary }}>
      <img src={asset('square.svg')} alt="" style={{ position: 'absolute', left: 0, top: 0, width: 200, height: 200 }} />
      <ui.Card style={{ position: 'absolute', left: 600, top: 400, width: 700, height: 280 }}>
        <div style={{ fontFamily: fonts.display, fontSize: 64, fontWeight: 700 }}>Cadence</div>
      </ui.Card>
    </div>
  );
}
