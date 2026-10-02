import type { BrandKit } from '../../src/shared/brandKit';
import { MediaCard } from './extras/MediaCard';
import { ProfileCard } from './extras/ProfileCard';
import { PromptCard } from './extras/PromptCard';
import { brand } from './tokens';
import { Avatar } from './ui/Avatar';
import { Badge } from './ui/Badge';
import { Button } from './ui/Button';
import { Card, CardBody, CardFooter, CardHeader } from './ui/Card';
import { Input } from './ui/Input';
import { ListItem } from './ui/ListItem';
import { Logo } from './ui/Logo';
import { Stat } from './ui/Stat';
import { Tabs } from './ui/Tabs';
import { Toggle } from './ui/Toggle';

export { Landscape } from './extras/MediaCard';
export { MenuDots } from './extras/ProfileCard';
export { PROMPT_CARD } from './extras/PromptCard';
export { Logo, MediaCard, ProfileCard, PromptCard };

const { id, name, tagline, url, language, colors, fonts, radius, voice } = brand;

const kit: BrandKit = {
  id,
  name,
  tagline,
  url,
  language,
  colors,
  fonts,
  radius,
  voice,
  Logo,
  ui: { Card, CardHeader, CardBody, CardFooter, Button, Input, Badge, Avatar, Stat, Toggle, Tabs, ListItem },
  extras: {
    ProfileCard: {
      component: ProfileCard,
      description:
        'The reference profile card (Profile, Name, Bio, Cancel, Save). Props: variant, name, bio, focus ("name"|"bio"), caret, pressed/hovered ("save"|"cancel"), saved, width (620).',
    },
    PromptCard: {
      component: PromptCard,
      description:
        'Scene prompt card, 680×340, layered. Props: title, subtitle, prompt, chars (typing), caret, duration, pressed, hovered, explode (0..1 pulls layers apart in Z).',
    },
    MediaCard: {
      component: MediaCard,
      description:
        'Photo card with an SVG sunset over dunes. Props: title, caption, bleed (0 inset → 1 edge to edge), sun (0..1 height), width (560).',
    },
  },
  copy: {
    taglines: ['Every scene is code.', 'Written to the millisecond.', 'Timed to the music.', 'One brand, every format.'],
    features: [
      { title: 'Scenes in code', body: 'Each scene is a React component that draws one frame for a time t.' },
      { title: 'On the beat', body: 'Cuts and animations lock to the beats, bars and phrases of the music.' },
      { title: 'Invisible cuts', body: "A scene's first frame picks up the last frame of the one before, to the pixel." },
      { title: 'Every format', body: '16:9, 9:16, 1:1 and 4:5 from the same scenes.' },
    ],
  },
};

export default kit;
