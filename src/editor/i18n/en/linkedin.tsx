import type { ReactNode } from 'react';
import type fr from '../fr/linkedin';
import { External } from '../links';

export default {
  keysSubtitle: 'One LinkedIn app for the whole team: everyone pastes the same keys.',
  steps: [
    <>
      On <External href="https://www.linkedin.com/developers/apps/new">linkedin.com/developers</External>, create an app linked to
      the team's LinkedIn Page. If the Settings tab shows "Verify", have a super admin of the Page approve it.
    </>,
    'Products: click "Request access" on "Share on LinkedIn", then on "Sign In with LinkedIn using OpenID Connect".',
    'Auth: under "Authorized redirect URLs for your app", add the redirect URL below exactly as written.',
    'Auth: copy the Client ID and the Primary Client Secret, then paste them here.',
  ],
  note: 'LinkedIn ends the connection after 60 days: connect again in your Profile then. Videos go to your personal profile, not to the team Page.',
  clientId: 'Client ID',
  clientSecret: 'Client Secret',
  redirectHint: 'One URL per port: if you run Cadence on another port, have yours added in the Auth tab.',
  connect: 'Connect the account',
  notConnected: 'Account not connected',
  publish: {
    connectFirst: 'Connect your LinkedIn account in your Profile first: videos go to that account.',
    onAccount: (name: ReactNode): ReactNode => <>On the profile {name}.</>,
    text: 'Post text',
    hint: 'LinkedIn has no private visibility: your direct connections, or everyone. The post goes live as soon as LinkedIn has processed the video, within a few minutes.',
    formatHint: (_format: string, seconds: number): string | null =>
      seconds < 3 ? 'LinkedIn refuses videos shorter than 3 seconds.' : null,
    forbidden: null,
    sent: (account: string) => `Posted on LinkedIn, profile ${account}`,
    keptPrivate: '',
  },
} satisfies typeof fr;
