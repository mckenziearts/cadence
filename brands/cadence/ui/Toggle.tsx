import type { ToggleProps } from '../../../src/shared/brandKit';
import { blend, colors, fonts, level, mix, tone } from '../tokens';

/** `on` may also be a 0..1 fraction so the knob can slide between states. */
export function Toggle({ on, label, style, className }: Omit<ToggleProps, 'on'> & { on: boolean | number }) {
  const p = level(on);
  const width = 56;
  const height = 32;
  const knob = 26;
  const gap = (height - knob) / 2;
  return (
    <div
      className={className}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 14, fontFamily: fonts.body, ...style }}
    >
      <div
        style={{
          position: 'relative',
          flex: 'none',
          width,
          height,
          borderRadius: height / 2,
          background: blend(tone.border, colors.primary, p),
          boxShadow: 'inset 0 1px 2px rgba(0, 0, 0, 0.08)',
        }}
      >
        <div
          style={{
            position: 'absolute',
            top: gap,
            left: mix(gap, width - knob - gap, p),
            width: knob,
            height: knob,
            borderRadius: '50%',
            background: '#ffffff',
            boxShadow: '0 1px 3px rgba(0, 0, 0, 0.22), 0 0 0 0.5px rgba(0, 0, 0, 0.04)',
          }}
        />
      </div>
      {label && <span style={{ fontSize: 20, fontWeight: 500, color: colors.ink }}>{label}</span>}
    </div>
  );
}
