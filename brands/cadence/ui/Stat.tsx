import type { StatProps } from '../../../src/shared/brandKit';
import { colors, fonts } from '../tokens';

/** Trend from the prop, else from the delta's sign ("+12 %" up, "-3 %" / "−3 %" down). */
export function trendOf(trend: StatProps['trend'], delta?: string): NonNullable<StatProps['trend']> {
  if (trend) return trend;
  const sign = delta?.trim()[0];
  return sign === '+' ? 'up' : sign === '-' || sign === '−' ? 'down' : 'neutral';
}

export function TrendArrow({ trend, size = 18 }: { trend: NonNullable<StatProps['trend']>; size?: number }) {
  const d = trend === 'up' ? 'M4 12 12 4M6 4h6v6' : trend === 'down' ? 'M4 4l8 8M12 6v6H6' : 'M3 8h10';
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d={d} stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Stat({ label, value, delta, trend, style, className }: StatProps) {
  const direction = trendOf(trend, delta);
  const deltaColor = direction === 'up' ? colors.success : direction === 'down' ? colors.danger : colors.muted;
  return (
    <div className={className} style={{ display: 'flex', flexDirection: 'column', gap: 10, fontFamily: fonts.body, ...style }}>
      <div style={{ fontSize: 18, fontWeight: 500, lineHeight: 1.3, color: colors.muted }}>{label}</div>
      <div
        style={{
          fontFamily: fonts.display,
          fontSize: 60,
          fontWeight: 700,
          lineHeight: 1,
          letterSpacing: '-0.04em',
          fontVariantNumeric: 'tabular-nums',
          color: colors.ink,
        }}
      >
        {value}
      </div>
      {delta && (
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 18, fontWeight: 600, color: deltaColor }}>
          <TrendArrow trend={direction} />
          {delta}
        </div>
      )}
    </div>
  );
}
