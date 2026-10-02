// Fixture brand kit: the smallest BrandKit that renders, for the frame e2e tests.
import type { CSSProperties, ReactNode } from 'react';
import type { BrandKit, CardSectionProps } from '../../../../src/shared/brandKit';
import type { BrandFile } from '../../../../src/shared/types';
import file from './brand.json';

const brand = file as BrandFile;
const { colors, radius } = brand;

function Section({ children, style, className }: CardSectionProps) {
  return (
    <div className={className} style={style}>
      {children}
    </div>
  );
}

function Pill({ children, style, className }: { children?: ReactNode; style?: CSSProperties; className?: string }) {
  return (
    <span className={className} style={{ borderRadius: 999, padding: '4px 12px', background: colors.line, ...style }}>
      {children}
    </span>
  );
}

const kit: BrandKit = {
  id: brand.id,
  name: brand.name,
  tagline: brand.tagline,
  url: brand.url,
  language: brand.language,
  colors,
  fonts: brand.fonts,
  radius,
  voice: brand.voice,
  Logo: ({ height = 48, color, style, className }) => (
    <svg className={className} style={style} height={height} viewBox="0 0 48 48">
      <rect width="48" height="48" rx="12" fill={color ?? colors.primary} />
    </svg>
  ),
  ui: {
    Card: ({ children, padding = 32, style, className }) => (
      <div className={className} style={{ background: colors.surface, borderRadius: radius.lg, padding, ...style }}>
        {children}
      </div>
    ),
    CardHeader: Section,
    CardBody: Section,
    CardFooter: Section,
    Button: ({ children, icon, style, className }) => (
      <div className={className} style={{ background: colors.primary, color: colors.primaryInk, padding: '12px 20px', ...style }}>
        {icon}
        {children}
      </div>
    ),
    Input: ({ label, value, placeholder, style, className }) => (
      <div className={className} style={style}>
        {label}
        <div style={{ border: `1px solid ${colors.line}`, padding: 12 }}>{value || placeholder}</div>
      </div>
    ),
    Badge: ({ children, style, className }) => (
      <Pill style={style} className={className}>
        {children}
      </Pill>
    ),
    Avatar: ({ name, size = 40, style, className }) => (
      <div
        className={className}
        style={{ width: size, height: size, borderRadius: size / 2, background: colors.accent, ...style }}
      >
        {name.slice(0, 1)}
      </div>
    ),
    Stat: ({ label, value, delta, style, className }) => (
      <div className={className} style={style}>
        {label} {value} {delta}
      </div>
    ),
    Toggle: ({ on, label, style, className }) => (
      <Pill style={{ background: on ? colors.primary : colors.line, ...style }} className={className}>
        {label}
      </Pill>
    ),
    Tabs: ({ items, active, style, className }) => (
      <div className={className} style={{ display: 'flex', gap: 8, ...style }}>
        {items.map((item, i) => (
          <Pill key={item} style={{ opacity: Math.round(active) === i ? 1 : 0.5 }}>
            {item}
          </Pill>
        ))}
      </div>
    ),
    ListItem: ({ title, subtitle, leading, trailing, style, className }) => (
      <div className={className} style={{ display: 'flex', gap: 12, ...style }}>
        {leading}
        {title} {subtitle}
        {trailing}
      </div>
    ),
  },
  extras: {},
  copy: { taglines: [brand.tagline], features: [] },
};

export default kit;
