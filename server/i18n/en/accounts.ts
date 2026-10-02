import type fr from '../fr/accounts';

export default {
  saveKeysFirst: (network: string) => `Save the keys of your ${network} app in your Profile first.`,
  connectFirst: (network: string) => `Connect ${network} in your Profile first.`,
  callback: {
    expired: 'Sign-in link expired',
    expiredDetail: 'Start the connection again from your Cadence Profile.',
    refused: (network: string) => `${network} is not connected`,
    accessDenied: 'Access was denied.',
    answered: (network: string, error: string) => `${network} answered: ${error}`,
    noCode: 'The answer holds no sign-in code: start the connection again.',
    connected: (network: string) => `${network} connected`,
    linked: (name: string) => `${name} is linked to Cadence. You can close this tab.`,
    failed: (network: string) => `Could not connect to ${network}`,
    unavailable: (error: string) => `Could not connect: ${error}`,
    back: 'Back to your Cadence Profile',
  },
  publish: {
    missingVideo: (file: string) => `Video not found: ${file}`,
    alreadySending: (network: string) => `This video is already on its way to ${network}.`,
    titleRequired: (network: string) => `${network} needs a title.`,
    textRequired: (network: string) => `${network} needs a text.`,
    tooLong: (what: 'title' | 'text', max: number) =>
      `${what === 'title' ? 'Title' : 'Text'} too long: ${max} characters at most.`,
    visibilityRefused: (network: string, visibility: string) => `${network} does not offer the "${visibility}" visibility.`,
    interrupted: (reason: string) => `Upload interrupted: ${reason}`,
  },
} satisfies typeof fr;
