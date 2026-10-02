import type fr from '../fr/youtube';
import type { ReactNode } from 'react';
import { External } from '../links';

const AUDIT_FORM = 'https://support.google.com/youtube/contact/yt_api_form';

export default {
  keysSubtitle: 'One Google app for the whole team: everyone pastes the same keys.',
  steps: [
    <>
      On <External href="https://console.cloud.google.com/">console.cloud.google.com</External>, create a project and enable
      "YouTube Data API v3".
    </>,
    'OAuth consent screen: "External" user type, then "Publish app".',
    'Credentials: create an "OAuth client ID" of type "Desktop app".',
    'Paste its client ID and client secret here.',
  ],
  note: (
    <>
      In "Testing" mode, Google cuts the connection after 7 days. Without the <External href={AUDIT_FORM}>YouTube audit</External>{' '}
      (free), uploaded videos stay private.
    </>
  ),
  clientId: 'Client ID',
  clientSecret: 'Client secret',
  redirectHint: 'Only needed for a client ID of type "Web application".',
  connect: 'Connect the channel',
  notConnected: 'Channel not connected',
  publish: {
    connectFirst: 'Connect your YouTube channel in your Profile first: videos go to that account.',
    onAccount: (name: ReactNode): ReactNode => <>On the channel {name}.</>,
    text: 'Description',
    hint: 'Until the Google project passes the YouTube audit, the video stays private whatever you choose.',
    formatHint: (format: string, seconds: number): string | null =>
      format !== '9:16'
        ? null
        : seconds <= 180
          ? 'Vertical and 3 min or less: YouTube makes it a Short.'
          : 'Longer than 3 min: YouTube publishes it as a video, not as a Short.',
    forbidden: 'YouTube refuses the < and > signs in the title and the description.',
    sent: (account: string) => `Sent to YouTube, channel ${account}`,
    keptPrivate: 'YouTube kept it private: the Google project has not passed the audit yet.',
  },
} satisfies typeof fr;
