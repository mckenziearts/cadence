import type { ListItemProps } from '../../../src/shared/brandKit';
import { colors, fonts, radius, tone } from '../tokens';

const ellipsis = { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } as const;

export function ListItem({ title, subtitle, leading, trailing, selected, style, className }: ListItemProps) {
  return (
    <div
      className={className}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        padding: '14px 18px',
        borderRadius: radius.lg,
        background: selected ? tone.chip : 'transparent',
        boxShadow: selected ? `inset 0 0 0 1px ${tone.border}` : 'none',
        fontFamily: fonts.body,
        ...style,
      }}
    >
      {leading && <div style={{ display: 'flex', flex: 'none' }}>{leading}</div>}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 20, fontWeight: 600, lineHeight: 1.35, color: colors.ink, ...ellipsis }}>{title}</div>
        {subtitle && (
          <div style={{ marginTop: 2, fontSize: 17, lineHeight: 1.35, color: colors.muted, ...ellipsis }}>{subtitle}</div>
        )}
      </div>
      {trailing && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 'none', fontSize: 18, color: tone.text }}>
          {trailing}
        </div>
      )}
    </div>
  );
}
