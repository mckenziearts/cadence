// One realistic element per brand kit component, covering its states: the brand tests render them, the kit page
// (kit.html) lays them out for the brand builder and the editor.
import type { ReactElement } from 'react';
import type { BrandKitUi } from './brandKit';

/** A portrait that needs no file: the samples render the same in tests, frames and the kit page. */
const PORTRAIT =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'%3E%3Crect width='40' height='40' fill='%23d6c7b2'/%3E%3Ccircle cx='20' cy='16' r='7' fill='%23a08c74'/%3E%3Cpath d='M6 40c2-9 8-13 14-13s12 4 14 13z' fill='%23a08c74'/%3E%3C/svg%3E";

export function uiSamples(ui: BrandKitUi): [string, ReactElement][] {
  const { Card, CardHeader, CardBody, CardFooter, Button, Input, Badge, Avatar, Stat, Toggle, Tabs, ListItem } = ui;
  const cards = (['default', 'muted', 'outline', 'elevated'] as const).map((variant): [string, ReactElement] => [
    `Card ${variant}`,
    <Card variant={variant} padding={24}>
      <CardHeader>Profil</CardHeader>
      <CardBody>Corps</CardBody>
      <CardFooter>Pied</CardFooter>
    </Card>,
  ]);
  return [
    ...cards,
    ['CardHeader alone', <CardHeader>Titre</CardHeader>],
    ['CardBody alone', <CardBody>Corps</CardBody>],
    ['CardFooter alone', <CardFooter>Pied</CardFooter>],
    ...(['primary', 'secondary', 'ghost', 'danger'] as const).flatMap((variant) =>
      (['sm', 'md', 'lg'] as const).map((size): [string, ReactElement] => [
        `Button ${variant} ${size}`,
        <Button variant={variant} size={size} icon={<svg width={16} height={16} />}>
          Continuer
        </Button>,
      ]),
    ),
    ['Button hovered', <Button hovered>Survol</Button>],
    ['Button pressed', <Button pressed>Pressé</Button>],
    ['Input empty', <Input label="Nom" placeholder="Olivia Martin" />],
    ['Input typing', <Input label="Nom" value="Oli" focused caret />],
    ['Input caret on placeholder', <Input placeholder="Rechercher" caret focused />],
    ['Input invalid', <Input label="Téléphone" value="+237 6" invalid hint="Numéro incomplet" />],
    ['Input multiline', <Input label="Bio" value={'Deux\nlignes'} multiline hint="160 caractères max" />],
    ...(['neutral', 'primary', 'success', 'warning', 'danger'] as const).map((tone): [string, ReactElement] => [
      `Badge ${tone}`,
      <Badge tone={tone}>Statut</Badge>,
    ]),
    ['Avatar initials', <Avatar name="Olivia Martin" />],
    ['Avatar one word', <Avatar name="Camille" size={96} />],
    ['Avatar image', <Avatar name="Olivia Martin" src={PORTRAIT} size={40} />],
    ['Stat up', <Stat label="Volume" value="12,4 M FCFA" delta="+18 %" trend="up" />],
    ['Stat inferred down', <Stat label="Échecs" value="0,8 %" delta="-2 %" />],
    ['Stat bare', <Stat label="Clients" value={1284} />],
    ['Toggle off', <Toggle on={false} />],
    ['Toggle on', <Toggle on label="Activé" />],
    ['Tabs first', <Tabs items={['Jour', 'Semaine', 'Mois']} active={0} />],
    ['Tabs sliding', <Tabs items={['Jour', 'Semaine', 'Mois']} active={1.4} />],
    ['Tabs out of range', <Tabs items={['Un', 'Deux']} active={7} />],
    ['Tabs empty', <Tabs items={[]} active={0} />],
    [
      'ListItem full',
      <ListItem title="Olivia Martin" subtitle="olivia@exemple.cm" leading={<span>OM</span>} trailing="25 000 FCFA" selected />,
    ],
    ['ListItem bare', <ListItem title="Titre" />],
  ];
}
