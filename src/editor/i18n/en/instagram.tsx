import type { ReactNode } from 'react';
import type fr from '../fr/instagram';
import { External } from '../links';

export default {
  keysSubtitle: 'One Meta app for the whole team: everyone pastes the same keys.',
  steps: [
    <>
      On <External href="https://developers.facebook.com/apps/creation/">developers.facebook.com</External>, create an app with
      the "Manage messaging & content on Instagram" use case. At the Business step, choose "I don't want to connect a business
      portfolio yet".
    </>,
    'In that use case, open "API setup with Facebook login" (not Instagram login), then click "Add all required permissions".',
    <>
      App roles, then Roles: add each teammate as a Tester; each one accepts the invitation on{' '}
      <External href="https://developers.facebook.com/requests/">developers.facebook.com/requests</External>. Leave the app in
      development mode.
    </>,
    'App settings, then Basic: paste the App ID and the App secret here.',
  ],
  note: 'Each Instagram account must be a professional account linked to a Facebook Page the person connecting manages; in the Facebook window, select that Page and that account: Cadence publishes to the account it found at connection. Meta cuts the connection after 60 days.',
  clientId: 'App ID',
  clientSecret: 'App secret',
  redirectHint: 'Nothing to add: while the app stays in development mode, Meta accepts localhost addresses without listing them.',
  connect: 'Connect the account',
  notConnected: 'Account not connected',
  publish: {
    connectFirst: 'Connect your Instagram account in your Profile first: videos go to that account.',
    onAccount: (name: ReactNode): ReactNode => <>On the account {name}.</>,
    text: 'Caption',
    hint: 'Published right away as a public Reel: the Instagram API has no draft and no private post.',
    formatHint: (format: string, seconds: number): string | null =>
      seconds < 3 || seconds > 900
        ? 'Instagram refuses Reels shorter than 3 s or longer than 15 min.'
        : format === '9:16'
          ? null
          : 'Outside 9:16, Instagram crops the video or adds bars in the Reels tab.',
    forbidden: null,
    sent: (account: string) => `Published on Instagram, account ${account}`,
    keptPrivate: '',
  },
} satisfies typeof fr;
