import type { BadgeProps } from '../../../src/shared/brandKit';
import { colors, fonts, radius, tone } from '../tokens';

const tones = {
  neutral: { background: tone.chip, color: tone.chipInk },
  primary: { background: colors.primary, color: colors.primaryInk },
  success: { background: '#ecfdf5', color: '#007a55' },
  warning: { background: '#fffbeb', color: '#bb4d00' },
  danger: { background: '#fef2f2', color: '#c10007' },
};

export function Badge({ children, tone: name = 'neutral', style, className }: BadgeProps) {
  return (
    <div
      className={className}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        height: 34,
        padding: '0 12px',
        boxSizing: 'border-box',
        borderRadius: radius.sm,
        fontFamily: fonts.body,
        fontSize: 16,
        fontWeight: 500,
        lineHeight: 1,
        whiteSpace: 'nowrap',
        ...tones[name],
        ...style,
      }}
    >
      {children}
    </div>
  );
}
