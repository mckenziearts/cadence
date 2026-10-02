// One realistic element per brand kit component, covering its states: the brand tests render them, the kit page
// (kit.html) lays them out for the brand builder and the editor, in the interface language.
import type { ReactElement } from 'react';
import type { BrandKitUi } from './brandKit';
import type { Language } from './types';

/** A portrait that needs no file: the samples render the same in tests, frames and the kit page. */
const PORTRAIT =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'%3E%3Crect width='40' height='40' fill='%23d6c7b2'/%3E%3Ccircle cx='20' cy='16' r='7' fill='%23a08c74'/%3E%3Cpath d='M6 40c2-9 8-13 14-13s12 4 14 13z' fill='%23a08c74'/%3E%3C/svg%3E";

const TEXTS = {
  fr: {
    card: { header: 'Profil', body: 'Corps', footer: 'Pied' },
    title: 'Titre',
    button: 'Continuer',
    hovered: 'Survol',
    pressed: 'Pressé',
    name: 'Nom',
    search: 'Rechercher',
    phone: { label: 'Téléphone', value: '+237 6', hint: 'Numéro incomplet' },
    bio: { label: 'Bio', value: 'Deux\nlignes', hint: '160 caractères max' },
    status: 'Statut',
    volume: { label: 'Volume', value: '12,4 M FCFA', delta: '+18 %' },
    failures: { label: 'Échecs', value: '0,8 %', delta: '-2 %' },
    customers: 'Clients',
    on: 'Activé',
    days: ['Jour', 'Semaine', 'Mois'],
    two: ['Un', 'Deux'],
    email: 'olivia@exemple.cm',
    amount: '25 000 FCFA',
  },
  en: {
    card: { header: 'Profile', body: 'Body', footer: 'Footer' },
    title: 'Title',
    button: 'Continue',
    hovered: 'Hover',
    pressed: 'Pressed',
    name: 'Name',
    search: 'Search',
    phone: { label: 'Phone', value: '+1 415', hint: 'Incomplete number' },
    bio: { label: 'Bio', value: 'Two\nlines', hint: '160 characters max' },
    status: 'Status',
    volume: { label: 'Volume', value: '$12.4M', delta: '+18%' },
    failures: { label: 'Failures', value: '0.8%', delta: '-2%' },
    customers: 'Customers',
    on: 'Enabled',
    days: ['Day', 'Week', 'Month'],
    two: ['One', 'Two'],
    email: 'olivia@example.com',
    amount: '$25,000',
  },
};

export function uiSamples(ui: BrandKitUi, language: Language): [string, ReactElement][] {
  const { Card, CardHeader, CardBody, CardFooter, Button, Input, Badge, Avatar, Stat, Toggle, Tabs, ListItem } = ui;
  const t = TEXTS[language];
  const cards = (['default', 'muted', 'outline', 'elevated'] as const).map((variant): [string, ReactElement] => [
    `Card ${variant}`,
    <Card variant={variant} padding={24}>
      <CardHeader>{t.card.header}</CardHeader>
      <CardBody>{t.card.body}</CardBody>
      <CardFooter>{t.card.footer}</CardFooter>
    </Card>,
  ]);
  return [
    ...cards,
    ['CardHeader alone', <CardHeader>{t.title}</CardHeader>],
    ['CardBody alone', <CardBody>{t.card.body}</CardBody>],
    ['CardFooter alone', <CardFooter>{t.card.footer}</CardFooter>],
    ...(['primary', 'secondary', 'ghost', 'danger'] as const).flatMap((variant) =>
      (['sm', 'md', 'lg'] as const).map((size): [string, ReactElement] => [
        `Button ${variant} ${size}`,
        <Button variant={variant} size={size} icon={<svg width={16} height={16} />}>
          {t.button}
        </Button>,
      ]),
    ),
    ['Button hovered', <Button hovered>{t.hovered}</Button>],
    ['Button pressed', <Button pressed>{t.pressed}</Button>],
    ['Input empty', <Input label={t.name} placeholder="Olivia Martin" />],
    ['Input typing', <Input label={t.name} value="Oli" focused caret />],
    ['Input caret on placeholder', <Input placeholder={t.search} caret focused />],
    ['Input invalid', <Input {...t.phone} invalid />],
    ['Input multiline', <Input {...t.bio} multiline />],
    ...(['neutral', 'primary', 'success', 'warning', 'danger'] as const).map((tone): [string, ReactElement] => [
      `Badge ${tone}`,
      <Badge tone={tone}>{t.status}</Badge>,
    ]),
    ['Avatar initials', <Avatar name="Olivia Martin" />],
    ['Avatar one word', <Avatar name="Camille" size={96} />],
    ['Avatar image', <Avatar name="Olivia Martin" src={PORTRAIT} size={40} />],
    ['Stat up', <Stat {...t.volume} trend="up" />],
    ['Stat inferred down', <Stat {...t.failures} />],
    ['Stat bare', <Stat label={t.customers} value={1284} />],
    ['Toggle off', <Toggle on={false} />],
    ['Toggle on', <Toggle on label={t.on} />],
    ['Tabs first', <Tabs items={t.days} active={0} />],
    ['Tabs sliding', <Tabs items={t.days} active={1.4} />],
    ['Tabs out of range', <Tabs items={t.two} active={7} />],
    ['Tabs empty', <Tabs items={[]} active={0} />],
    [
      'ListItem full',
      <ListItem title="Olivia Martin" subtitle={t.email} leading={<span>OM</span>} trailing={t.amount} selected />,
    ],
    ['ListItem bare', <ListItem title={t.title} />],
  ];
}
