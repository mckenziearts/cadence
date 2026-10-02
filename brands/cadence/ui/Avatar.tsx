import type { AvatarProps } from '../../../src/shared/brandKit';
import { fonts, initials, pick } from '../tokens';

const palette = [
  { background: '#f4f4f5', color: '#3f3f46' },
  { background: '#e4e4e7', color: '#27272a' },
  { background: '#18181b', color: '#fafafa' },
];

export function Avatar({ name, src, size = 56, style, className }: AvatarProps) {
  return (
    <div
      className={className}
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flex: 'none',
        width: size,
        height: size,
        borderRadius: '50%',
        overflow: 'hidden',
        boxShadow: 'inset 0 0 0 1px rgba(0, 0, 0, 0.06)',
        fontFamily: fonts.body,
        fontSize: Math.round(size * 0.38),
        fontWeight: 600,
        letterSpacing: '-0.01em',
        ...palette[pick(name, palette.length)],
        ...style,
      }}
    >
      {src ? <img src={src} alt={name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : initials(name)}
    </div>
  );
}
