// The contract every brand preset implements (brands/<id>/index.tsx default export).
// Scene templates only use this interface, so one template works for every brand.
//
// Rules for kit components:
// - Presentational and deterministic: no state, no effects, no timers, no CSS transitions/animations.
// - Every visual state is a prop (pressed, focused, caret, on, active...) so scenes can animate it from `t`.
// - Accept `style` and `className` and merge them last, so scenes can position/transform them.
// - Style with the brand's Tailwind theme (brands/<id>/theme.css) and/or inline styles from the brand tokens.
import type { ComponentType, CSSProperties, ReactNode } from 'react';
import type { BrandColors, BrandFonts } from './types';

export interface KitBaseProps {
  style?: CSSProperties;
  className?: string;
}

export interface LogoProps extends KitBaseProps {
  /** 'mark' = symbol only, 'full' = symbol + wordmark. */
  variant?: 'mark' | 'full';
  /** Rendered height in px (width follows the aspect ratio). */
  height?: number;
  /** One-color version for dark backgrounds, as the brand defines it (some full logos keep their symbol colors). */
  color?: string;
}

export interface CardProps extends KitBaseProps {
  children?: ReactNode;
  variant?: 'default' | 'muted' | 'outline' | 'elevated';
  /** Inner padding in px; default from the brand. */
  padding?: number;
}

export interface CardSectionProps extends KitBaseProps {
  children?: ReactNode;
}

export interface ButtonProps extends KitBaseProps {
  children?: ReactNode;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  /** Pressed look (scale/darken): drive it from the cursor timeline. */
  pressed?: boolean;
  /** Hover look. */
  hovered?: boolean;
  icon?: ReactNode;
}

export interface InputProps extends KitBaseProps {
  label?: ReactNode;
  value?: string;
  placeholder?: string;
  focused?: boolean;
  /** Show a text caret after the value (use with typed text). */
  caret?: boolean;
  /** Helper or error text under the field. */
  hint?: string;
  invalid?: boolean;
  multiline?: boolean;
}

export interface BadgeProps extends KitBaseProps {
  children?: ReactNode;
  tone?: 'neutral' | 'primary' | 'success' | 'warning' | 'danger';
}

export interface AvatarProps extends KitBaseProps {
  name: string;
  /** Image URL (use asset() for project files). Initials are shown when absent. */
  src?: string;
  size?: number;
}

export interface StatProps extends KitBaseProps {
  label: string;
  value: ReactNode;
  /** e.g. "+12,4 %" */
  delta?: string;
  trend?: 'up' | 'down' | 'neutral';
}

export interface ToggleProps extends KitBaseProps {
  /** A 0..1 fraction slides the knob and blends the track color, so the switch can animate. */
  on: boolean | number;
  label?: string;
}

export interface TabsProps extends KitBaseProps {
  items: string[];
  /** Index of the active tab. Fractional values are allowed so the indicator can slide between tabs. */
  active: number;
}

export interface ListItemProps extends KitBaseProps {
  title: string;
  subtitle?: string;
  leading?: ReactNode;
  trailing?: ReactNode;
  selected?: boolean;
}

export interface BrandKitUi {
  Card: ComponentType<CardProps>;
  CardHeader: ComponentType<CardSectionProps>;
  CardBody: ComponentType<CardSectionProps>;
  CardFooter: ComponentType<CardSectionProps>;
  Button: ComponentType<ButtonProps>;
  Input: ComponentType<InputProps>;
  Badge: ComponentType<BadgeProps>;
  Avatar: ComponentType<AvatarProps>;
  Stat: ComponentType<StatProps>;
  Toggle: ComponentType<ToggleProps>;
  Tabs: ComponentType<TabsProps>;
  ListItem: ComponentType<ListItemProps>;
}

export interface BrandExtra {
  component: ComponentType<any>;
  /** One line for the agent: what it shows and its main props. */
  description: string;
}

export interface BrandKit {
  id: string;
  name: string;
  tagline: string;
  url: string;
  language: 'fr' | 'en';
  colors: BrandColors;
  fonts: BrandFonts;
  radius: { sm: number; md: number; lg: number; xl: number };
  voice: string;
  Logo: ComponentType<LogoProps>;
  ui: BrandKitUi;
  /** Brand-specific showcase components (PaymentCard, ProductCard, TransactionRow...). */
  extras: Record<string, BrandExtra>;
  /** Real product copy the agent can reuse (taglines, feature names). */
  copy: {
    taglines: string[];
    features: { title: string; body: string }[];
  };
}
