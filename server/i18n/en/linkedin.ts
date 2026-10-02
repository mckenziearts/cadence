import type fr from '../fr/linkedin';

export default {
  expired:
    'The LinkedIn connection expired or was removed: reconnect your account in your Profile (LinkedIn limits it to 60 days).',
  badKeys: 'LinkedIn does not recognize these keys: check the Client ID and the Client Secret in your Profile.',
  codeRefused: (detail: string) => `LinkedIn refused the connection (${detail}): start it again from your Profile.`,
  noShare:
    'The LinkedIn app is not allowed to post: add the "Share on LinkedIn" product to it (Products tab), then reconnect your account in your Profile.',
  forbidden: (detail: string) =>
    `LinkedIn denied access (${detail}): check that the app has the "Share on LinkedIn" and "Sign In with LinkedIn using OpenID Connect" products (Products tab), then reconnect your account in your Profile.`,
  quota: 'Daily LinkedIn limit reached: try again tomorrow.',
  outdated: 'This version of Cadence calls a LinkedIn API version that is no longer served: update Cadence.',
  uploadFailed: (status: number) => `Sending the video to LinkedIn failed (error ${status}): publish it again.`,
  processingFailed: (reason: string) => `LinkedIn could not process the video: ${reason}`,
  stillProcessing: (minutes: number) =>
    `LinkedIn is still processing the video after ${minutes} minutes: nothing was posted, publish it again later.`,
  videoRefused: (detail: string) => `LinkedIn refused the video: ${detail}`,
  postRefused: (detail: string) => `LinkedIn refused the post: ${detail}`,
  profileUnavailable: (detail: string) => `LinkedIn did not return your profile: ${detail}`,
  httpStatus: (status: number) => `error ${status}`,
  textTooLong: (max: number) =>
    `Text too long for LinkedIn once its special signs are escaped (${max} characters at most): shorten it.`,
} satisfies typeof fr;
