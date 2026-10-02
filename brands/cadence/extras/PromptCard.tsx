// Adapted from saeedvaziry/caleb-video-editor (MIT)
import type { CSSProperties } from 'react';
import type { KitBaseProps } from '../../../src/shared/brandKit';
import { colors, fonts, shadow, tone } from '../tokens';
import { Caret } from '../ui/Input';
import { MenuDots } from './ProfileCard';

export interface PromptCardProps extends KitBaseProps {
  title?: string;
  subtitle?: string;
  prompt?: string;
  /** Characters of `prompt` shown (typing); default all. */
  chars?: number;
  caret?: boolean;
  /** Duration chip, e.g. "3.32 s". */
  duration?: string;
  pressed?: boolean;
  hovered?: boolean;
  /** 0..1: pulls the layers apart in Z (wrap the card in a perspective container and tilt it). */
  explode?: number;
}

export const PROMPT_CARD = { width: 680, height: 340 };

/** The prompt card of a scene chat, built from absolutely positioned layers so a scene can explode it in 3D. */
export function PromptCard({
  title = 'Anatomy',
  subtitle = 'Scene 2 of 5',
  prompt = 'Hold the title one second longer, then slide the card in from the right.',
  chars,
  caret = false,
  duration = '3.32 s',
  pressed = false,
  hovered = false,
  explode = 0,
  style,
  className,
}: PromptCardProps) {
  const { width, height } = PROMPT_CARD;
  const letters = Array.from(prompt);
  const shown = chars === undefined ? prompt : letters.slice(0, Math.max(0, Math.floor(chars))).join('');
  const layer = (depth: number, css: CSSProperties): CSSProperties => ({
    position: 'absolute',
    transform: explode ? `translateZ(${explode * depth}px)` : undefined,
    ...css,
  });
  return (
    <div
      className={className}
      style={{ position: 'relative', width, height, fontFamily: fonts.body, transformStyle: 'preserve-3d', ...style }}
    >
      <div
        style={layer(0, {
          inset: 0,
          borderRadius: 22,
          background: colors.surface,
          border: `1px solid ${colors.line}`,
          boxShadow: shadow.card,
        })}
      />
      <div
        style={layer(40, {
          left: 28,
          top: 104,
          width: width - 56,
          height: 136,
          boxSizing: 'border-box',
          borderRadius: 14,
          background: tone.inset,
          border: `1px solid ${tone.insetLine}`,
        })}
      />
      <div style={layer(80, { left: 28, top: 24, width: width - 56, height: 56 })}>
        <div style={{ fontSize: 23, fontWeight: 650, lineHeight: '30px', letterSpacing: '-0.012em', color: colors.ink }}>
          {title}
        </div>
        <div style={{ fontSize: 15, lineHeight: '22px', color: colors.muted }}>{subtitle}</div>
        <div
          style={{
            position: 'absolute',
            right: 40,
            top: 3,
            height: 28,
            padding: '0 10px',
            borderRadius: 8,
            background: tone.chip,
            color: tone.chipInk,
            fontFamily: fonts.mono,
            fontSize: 14,
            lineHeight: '28px',
          }}
        >
          {duration}
        </div>
        <div style={{ position: 'absolute', right: -4, top: 4 }}>
          <MenuDots color={colors.muted} />
        </div>
      </div>
      <div
        style={layer(120, {
          left: 48,
          top: 122,
          width: width - 96,
          fontSize: 19.5,
          lineHeight: 1.55,
          letterSpacing: '-0.005em',
          color: tone.text,
        })}
      >
        {shown}
        {caret && <Caret />}
      </div>
      <div style={layer(80, { left: 28, top: 268, width: width - 56 - 116, height: 44, lineHeight: '44px' })}>
        <span style={{ position: 'absolute', left: 0, fontSize: 15, color: tone.hint }}>⌘↵ pour envoyer</span>
        <span style={{ position: 'absolute', right: 18, fontSize: 15.5, fontWeight: 500, color: tone.chipInk }}>Annuler</span>
      </div>
      <div
        style={layer(160, {
          right: 28,
          top: 268,
          width: 104,
          height: 44,
          borderRadius: 12,
          background: pressed ? tone.pressed : hovered ? tone.hover : colors.primary,
          color: colors.primaryInk,
          fontSize: 15.5,
          fontWeight: 600,
          lineHeight: '44px',
          textAlign: 'center',
          scale: pressed ? '0.96' : undefined,
        })}
      >
        Envoyer
      </div>
    </div>
  );
}
