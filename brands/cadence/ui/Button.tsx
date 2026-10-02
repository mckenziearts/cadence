import type { ButtonProps } from '../../../src/shared/brandKit';
import { colors, fonts, radius, shadow, tone } from '../tokens';

const sizes = {
  sm: { height: 42, padding: '0 16px', fontSize: 16, gap: 8, borderRadius: radius.sm + 2 },
  md: { height: 52, padding: '0 22px', fontSize: 19, gap: 10, borderRadius: radius.md },
  lg: { height: 64, padding: '0 30px', fontSize: 22, gap: 12, borderRadius: radius.md + 2 },
};

const variants = {
  primary: { rest: colors.primary, hover: tone.hover, pressed: tone.pressed, ink: colors.primaryInk, border: colors.primary },
  secondary: { rest: colors.surface, hover: tone.inset, pressed: tone.chip, ink: colors.ink, border: tone.border },
  ghost: { rest: 'transparent', hover: tone.chip, pressed: tone.border, ink: tone.text, border: 'transparent' },
  danger: { rest: colors.danger, hover: '#e7000b', pressed: '#c10007', ink: '#ffffff', border: colors.danger },
};

export function Button({ children, variant = 'primary', size = 'md', pressed, hovered, icon, style, className }: ButtonProps) {
  const look = variants[variant];
  const background = pressed ? look.pressed : hovered ? look.hover : look.rest;
  return (
    <div
      className={className}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        boxSizing: 'border-box',
        whiteSpace: 'nowrap',
        ...sizes[size],
        fontFamily: fonts.body,
        fontWeight: 600,
        letterSpacing: '-0.01em',
        color: look.ink,
        background,
        border: `1px solid ${pressed || hovered ? (variant === 'secondary' ? '#d4d4d8' : background) : look.border}`,
        boxShadow: pressed
          ? 'inset 0 1px 2px rgba(0, 0, 0, 0.18)'
          : variant === 'ghost'
            ? 'none'
            : variant === 'secondary'
              ? shadow.xs
              : 'inset 0 1px 0 rgba(255, 255, 255, 0.12), 0 1px 2px rgba(0, 0, 0, 0.12)',
        scale: pressed ? '0.97' : undefined,
        ...style,
      }}
    >
      {icon && <span style={{ display: 'inline-flex', flex: 'none' }}>{icon}</span>}
      {children}
    </div>
  );
}
