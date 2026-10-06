import type { ReactNode } from 'react';
import type fr from '../fr/profile';
import { External } from '../links';

const ELEVENLABS_KEYS = 'https://elevenlabs.io/app/settings/api-keys';

export default {
  title: 'Profile',
  subtitle: 'The accounts Cadence uses on this computer.',
  usage: {
    title: (agent: string) => `Usage · ${agent}`,
    hintCost: 'What Cadence asked the assistant on this computer. Cost estimated at API prices, counted on your subscription.',
    hintTokens: 'What Cadence asked the assistant on this computer. Subscription: only tokens are counted, no cost.',
    source: 'Source',
    chats: 'Project chats',
    brands: 'Brand builds',
    total: 'Total',
    runs: 'Runs',
    read: 'Tokens read',
    written: 'Tokens written',
    cost: 'Estimated cost',
    since: (day: string) => `Counted since ${day}, not including work done in a terminal.`,
    empty: 'Nothing counted yet: counting starts with the next exchange in Cadence. Work done in a terminal is not counted.',
  },
  agents: {
    title: 'AI assistant',
    hint: 'The AI that drives chats and brand builds, through its CLI. One at a time.',
    ready: 'Connected',
    use: 'Use',
    inUse: 'In use',
    setup: 'How to connect',
    soon: 'Soon',
    help: {
      title: (name: string) => `Connect ${name}`,
      installIntro: (name: string) => `${name} runs through its CLI. Install it, then log in.`,
      install: 'Install the CLI',
      login: 'Log in',
      loginIntro: (name: string) => `${name} is installed but not logged in. Run:`,
      docs: 'Open the documentation',
    },
  },
  git: 'Git repositories',
  gitHint: 'To build a brand from a repository.',
  voice: {
    title: 'Voice-over',
    hint: 'The engines that speak the voice-over. Each project picks its own in its Voice tab.',
    piper: {
      ready: 'Installed, free',
      missing: 'Piper is not installed',
      install: 'Install it once in a terminal, then restart Cadence:',
      voices: 'Voices on this computer',
      none: 'No voice downloaded: a project downloads its own from its Voice tab.',
    },
    elevenLabs: {
      configured: 'Key saved',
      noKey: 'No key',
      key: 'ElevenLabs API key',
      keyHint: (
        <>
          Create it in your <External href={ELEVENLABS_KEYS}>ElevenLabs account settings</External>.
        </>
      ) as ReactNode,
      billing:
        'The voice-over text goes to ElevenLabs and each generation is billed to your account. A video that sells a product needs a paid plan.',
      saveKey: 'Save the key',
      newProjects: 'New projects',
      defaultLabel: 'Voice of new projects',
      piper: "Piper, the language's voice",
      defaultHint: 'Written into a project when it is created: existing projects keep their voice.',
      removeKey: 'Remove the key',
      removeKeyConfirm: 'Remove the key?',
    },
  },
  networks: 'Networks',
  networksHint: 'To publish a video from the Render page.',
  checking: 'Checking',
  via: (account: string, cli: string) => `${account} (via ${cli})`,
  missing: (cli: string) => `${cli} is not installed`,
  loggedOut: (cli: string) => `${cli} is not signed in`,
  failing: (cli: string) => `${cli} is not responding`,
  notConfigured: 'Not set up',
  setUp: 'Set up',
  keys: 'Keys',
  disconnect: 'Disconnect',
  disconnectConfirm: 'Disconnect?',
  disconnected: (network: string) => `${network} disconnected`,
  keysTitle: (network: string) => `${network} app keys`,
  keysSaved: (network: string) => `${network} keys saved`,
  secretAgain: 'Type it again',
  redirect: 'Redirect URL',
} satisfies typeof fr;
