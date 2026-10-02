import type fr from '../fr/youtube';

export default {
  expired:
    'The YouTube connection expired or was removed: reconnect your channel in your Profile (with a consent screen left in "Testing", Google cuts it after 7 days).',
  noChannel: 'This Google account has no YouTube channel: create one on youtube.com, then connect again.',
  angleBrackets: 'YouTube refuses the < and > signs in the title and the description.',
  stalled: 'YouTube stopped receiving the video: publish it again.',
  codeRefused: 'Google refused the sign-in code: start the connection again.',
  badKeys: 'Google does not recognize these keys: check the client ID and the client secret in your Profile.',
  googleSaid: (text: string) => `Google answered: ${text}`,
  httpStatus: (status: number) => `error ${status}`,
  quota: 'Daily YouTube upload quota reached: try again tomorrow.',
  apiDisabled: 'The YouTube Data API v3 is not enabled in your Google Cloud project: enable it, then try again.',
  videoRefused: (detail: string) => `YouTube refused the video: ${detail}`,
  channelUnavailable: (detail: string) => `YouTube did not return the channel: ${detail}`,
} satisfies typeof fr;
