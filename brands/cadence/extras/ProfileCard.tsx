import type { CardProps, KitBaseProps } from '../../../src/shared/brandKit';
import { colors, tone } from '../tokens';
import { Button } from '../ui/Button';
import { Card, CardBody, CardFooter, CardHeader } from '../ui/Card';
import { Input } from '../ui/Input';

export interface ProfileCardProps extends KitBaseProps {
  /** Card surface; `muted` is the reference look (grey frame, white inset body). */
  variant?: CardProps['variant'];
  name?: string;
  /** Empty shows the placeholder. */
  bio?: string;
  /** Field with the focus ring (and the caret when `caret`). */
  focus?: 'name' | 'bio' | null;
  caret?: boolean;
  pressed?: 'save' | 'cancel' | null;
  hovered?: 'save' | 'cancel' | null;
  saved?: string;
  width?: number;
}

export function MenuDots({ color = tone.chipInk }: { color?: string }) {
  return (
    <svg width={26} height={26} viewBox="0 0 26 26" aria-hidden="true" style={{ flex: 'none' }}>
      {[6, 13, 20].map((x) => (
        <circle key={x} cx={x} cy={13} r={2.2} fill={color} />
      ))}
    </svg>
  );
}

/** The profile card of the reference video: header, inset body with two fields, footer with Cancel and Save. */
export function ProfileCard({
  variant = 'muted',
  name = 'Olivia Martin',
  bio = '',
  focus = null,
  caret = false,
  pressed = null,
  hovered = null,
  saved = 'Saved 2 minutes ago',
  width = 620,
  style,
  className,
}: ProfileCardProps) {
  return (
    <Card variant={variant} className={className} style={{ width, ...style }}>
      <CardHeader>
        <div>
          <div>Profile</div>
          <div style={{ fontSize: 18, fontWeight: 400, letterSpacing: 0, color: colors.muted }}>This is how others see you</div>
        </div>
        <MenuDots />
      </CardHeader>
      <CardBody style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
        <Input label="Name" value={name} focused={focus === 'name'} caret={caret && focus === 'name'} />
        <Input
          label="Bio"
          value={bio}
          placeholder="A few words about you"
          multiline
          focused={focus === 'bio'}
          caret={caret && focus === 'bio'}
        />
      </CardBody>
      <CardFooter>
        <span style={{ marginRight: 'auto' }}>{saved}</span>
        <Button variant="ghost" pressed={pressed === 'cancel'} hovered={hovered === 'cancel'}>
          Cancel
        </Button>
        <Button pressed={pressed === 'save'} hovered={hovered === 'save'}>
          Save
        </Button>
      </CardFooter>
    </Card>
  );
}
