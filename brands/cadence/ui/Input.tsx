import type { InputProps } from '../../../src/shared/brandKit';
import { alpha, colors, fonts, radius, shadow, tone } from '../tokens';

/** Text caret with no layout width, so toggling it never shifts the text. */
export function Caret({ color = colors.accent }: { color?: string }) {
  return (
    <span
      style={{
        display: 'inline-block',
        width: 2,
        height: '1.2em',
        margin: '0 -1px',
        verticalAlign: '-0.22em',
        borderRadius: 1,
        background: color,
      }}
    />
  );
}

export function Input({ label, value, placeholder, focused, caret, hint, invalid, multiline, style, className }: InputProps) {
  const border = invalid ? colors.danger : focused ? colors.ink : tone.border;
  const ring = invalid ? alpha(colors.danger, 0.14) : focused ? alpha(colors.ink, 0.08) : 'transparent';
  const cursor = caret ? <Caret /> : null;
  return (
    <div className={className} style={{ display: 'flex', flexDirection: 'column', gap: 10, fontFamily: fonts.body, ...style }}>
      {label && <div style={{ fontSize: 18, fontWeight: 600, lineHeight: 1.3, color: colors.ink }}>{label}</div>}
      <div
        style={{
          boxSizing: 'border-box',
          display: 'flex',
          alignItems: multiline ? 'flex-start' : 'center',
          minHeight: multiline ? 136 : 56,
          padding: multiline ? '15px 18px' : '0 18px',
          background: colors.surface,
          border: `1px solid ${border}`,
          borderRadius: radius.md,
          boxShadow: `0 0 0 4px ${ring}, ${shadow.xs}`,
          fontSize: 20,
          lineHeight: 1.5,
          color: colors.ink,
          whiteSpace: multiline ? 'pre-wrap' : 'pre',
          overflow: 'hidden',
        }}
      >
        {value ? (
          <span>
            {value}
            {cursor}
          </span>
        ) : (
          <span>
            {cursor}
            <span style={{ color: tone.hint }}>{placeholder}</span>
          </span>
        )}
      </div>
      {hint && <div style={{ fontSize: 16, lineHeight: 1.4, color: invalid ? colors.danger : colors.muted }}>{hint}</div>}
    </div>
  );
}
