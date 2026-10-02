import { createContext, useContext, type CSSProperties } from 'react';
import type { CardProps, CardSectionProps } from '../../../src/shared/brandKit';
import { colors, fonts, radius, shadow, tone } from '../tokens';

type Variant = NonNullable<CardProps['variant']>;

// Sections read the card's variant and padding: in `muted` the body becomes the white inset panel of the reference card.
const CardContext = createContext<{ variant: Variant; padding: number }>({ variant: 'default', padding: 28 });

const surfaces: Record<Variant, CSSProperties> = {
  default: { background: colors.surface, border: `1px solid ${colors.line}`, boxShadow: shadow.card },
  muted: { background: tone.chip, border: `1px solid ${tone.border}`, boxShadow: shadow.xs },
  outline: { background: 'transparent', border: `1px solid ${tone.border}` },
  elevated: { background: colors.surface, border: '1px solid transparent', boxShadow: shadow.lifted },
};

export function Card({ children, variant = 'default', padding = 28, style, className }: CardProps) {
  return (
    <CardContext value={{ variant, padding }}>
      <div
        className={className}
        style={{
          position: 'relative',
          boxSizing: 'border-box',
          padding,
          borderRadius: radius.xl,
          fontFamily: fonts.body,
          color: colors.ink,
          ...surfaces[variant],
          ...style,
        }}
      >
        {children}
      </div>
    </CardContext>
  );
}

export function CardHeader({ children, style, className }: CardSectionProps) {
  const { padding } = useContext(CardContext);
  return (
    <div
      className={className}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 16,
        marginBottom: Math.round(padding * 0.7),
        fontSize: 22,
        fontWeight: 600,
        lineHeight: 1.35,
        letterSpacing: '-0.01em',
        color: colors.ink,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function CardBody({ children, style, className }: CardSectionProps) {
  const { variant, padding } = useContext(CardContext);
  const inset = 6;
  const panel: CSSProperties =
    variant === 'muted'
      ? {
          margin: `0 ${Math.min(0, inset - padding)}px`,
          padding: Math.max(0, padding - inset),
          background: colors.surface,
          border: `1px solid ${tone.border}`,
          borderRadius: radius.xl - inset,
          boxShadow: shadow.xs,
        }
      : {};
  return (
    <div className={className} style={{ fontSize: 20, lineHeight: 1.5, color: tone.text, ...panel, ...style }}>
      {children}
    </div>
  );
}

export function CardFooter({ children, style, className }: CardSectionProps) {
  const { padding } = useContext(CardContext);
  return (
    <div
      className={className}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: 12,
        marginTop: Math.round(padding * 0.7),
        fontSize: 18,
        color: colors.muted,
        ...style,
      }}
    >
      {children}
    </div>
  );
}
