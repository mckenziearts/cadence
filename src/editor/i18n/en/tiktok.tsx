import type { ReactNode } from 'react';
import type fr from '../fr/tiktok';
import { External } from '../links';

export default {
  keysSubtitle: 'One TikTok app for the whole team: everyone pastes the same keys.',
  steps: [
    <>
      On <External href="https://developers.tiktok.com/apps">developers.tiktok.com/apps</External>, "Connect an app". Switch the
      toggle next to its name to "Sandbox", then "Create Sandbox".
    </>,
    'App details: an icon, a category, a description (TikTok shows it when people connect) and, under "Platforms", "Desktop" with the address of your team\'s website.',
    'Products: add "Login Kit" and "Content Posting API" (leave "Direct Post" off). In Login Kit, Desktop platform, add the redirect URL below.',
    'Scopes: user.info.basic and video.upload must be there ("Add Scopes" if not). Then "Apply changes".',
    'Sandbox settings, Target users: "Add account" for each teammate, who signs in there with their own TikTok account (10 accounts at most).',
    'Paste the Client key and the Client secret of the Sandbox here (App details, Credentials).',
  ],
  note: 'TikTok receives the video as a draft: each person finishes and posts it from the app. TikTok does not say whether a draft from a Sandbox app can be posted publicly: try it once, and if the video stays private, make the account public, then switch the video to "Everyone" in its privacy settings.',
  clientId: 'Client key',
  clientSecret: 'Client secret',
  redirectHint: 'Add it exactly as is in Login Kit, Desktop platform. With * in place of the port, it works for every port.',
  connect: 'Connect the account',
  notConnected: 'Account not connected',
  publish: {
    connectFirst: 'Connect your TikTok account in your Profile first: videos go to that account.',
    onAccount: (name: ReactNode): ReactNode => <>As a draft on the account {name}.</>,
    text: '',
    hint: 'TikTok receives the video as a draft: open the notification in the TikTok app to write the caption, choose who can watch it and post it. 5 pending drafts at most per 24 hours.',
    formatHint: (format: string, seconds: number): string | null =>
      seconds > 600
        ? 'Longer than 10 min: TikTok will refuse the video.'
        : seconds > 180
          ? 'Longer than 3 min: depending on the account, the TikTok app may ask you to trim it.'
          : format === '9:16'
            ? null
            : 'TikTok is made for vertical video: 9:16 shows best there.',
    forbidden: null,
    sent: (account: string) => `Draft sent to ${account}: post it from the TikTok app`,
    keptPrivate: '',
  },
} satisfies typeof fr;
