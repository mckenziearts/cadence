// The agent picker and the Profile card say why an agent whose CLI cannot be confined stays disabled, in both languages.
// node --import tsx --test tests/editor/agents.test.tsx
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AgentStatus } from '../../src/shared/types';
import en from '../../src/editor/i18n/en/profile';
import fr from '../../src/editor/i18n/fr/profile';

// The store reads <html lang> and the api module its token <meta> when they load: a stand-in document is all they need.
(globalThis as { document?: unknown }).document = { documentElement: { lang: 'fr' }, querySelector: () => null };
const { AgentChoices } = await import('../../src/editor/components/AgentPicker');
const { AgentCard } = await import('../../src/editor/components/Profile');
const { AGENTS } = await import('../../src/editor/components/agents');
const { useStore } = await import('../../src/editor/store');

const codex = AGENTS.find((agent) => agent.id === 'codex')!;
const status: AgentStatus = {
  ok: false,
  label: 'Codex',
  version: '0.160.0',
  reason: 'unconfined',
  detail: 'server-side detail',
};
const escaped = (text: string) => text.replaceAll("'", '&#x27;');
/** The markup of the first button whose text holds `label`. */
const button = (html: string, label: string) => html.split('<button').find((part) => part.split('</button>')[0].includes(label));

for (const [language, texts] of [
  ['fr', fr],
  ['en', en],
] as const) {
  test(`an unconfined Codex stays disabled and says why (${language})`, () => {
    // Static rendering reads the store's initial state, not later set() calls.
    useStore.getInitialState().language = language;
    const why = escaped(texts.agents.unconfined('Codex'));

    const picker = renderToStaticMarkup(<AgentChoices status={{ codex: status }} />);
    assert.ok(picker.includes(why), picker);
    assert.match(button(picker, 'Codex') ?? '', /disabled=""/);

    const card = renderToStaticMarkup(<AgentCard agent={codex} status={status} selected={false} />);
    assert.ok(card.includes(why), card);
    assert.ok(card.includes(`title="${why}"`), 'the truncated message stays readable on hover');
    assert.ok(!card.includes('server-side detail'), 'the card speaks the editor language, not the server one');
    assert.match(button(card, texts.agents.use) ?? '', /disabled=""/);
  });
}
