import type { TabsProps } from '../../../src/shared/brandKit';
import { blend, clamp, colors, fonts, radius, tone } from '../tokens';

// Equal-width segments (as wide as the longest label), so a fractional `active` maps straight to the indicator
// position without measuring text.
export function Tabs({ items, active, style, className }: TabsProps) {
  const count = Math.max(1, items.length);
  const at = clamp(active, 0, count - 1);
  const pad = 5;
  return (
    <div
      className={className}
      style={{
        position: 'relative',
        display: 'inline-grid',
        gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))`,
        padding: pad,
        borderRadius: radius.md + 2,
        background: tone.chip,
        fontFamily: fonts.body,
        ...style,
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: pad,
          bottom: pad,
          left: `calc(${pad}px + (100% - ${pad * 2}px) * ${at / count})`,
          width: `calc((100% - ${pad * 2}px) / ${count})`,
          borderRadius: radius.md - 3,
          background: colors.surface,
          boxShadow: '0 1px 2px rgba(0, 0, 0, 0.08), 0 0 0 1px rgba(0, 0, 0, 0.04)',
        }}
      />
      {items.map((item, i) => (
        <div
          key={i}
          style={{
            position: 'relative',
            display: 'flex',
            justifyContent: 'center',
            padding: '11px 24px',
            whiteSpace: 'nowrap',
            fontSize: 19,
            fontWeight: 500,
            lineHeight: '26px',
            color: blend(colors.muted, colors.ink, 1 - Math.min(1, Math.abs(at - i))),
          }}
        >
          {item}
        </div>
      ))}
    </div>
  );
}
