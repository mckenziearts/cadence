import type fr from '../fr/instagram';

export default {
  expired: 'The Instagram connection expired or was removed: reconnect the account in your Profile (Meta cuts it after 60 days).',
  badKeys: 'Meta does not recognize these keys: check the App ID and the App secret in your Profile.',
  codeRefused: (detail: string) => `Meta refused the sign-in code (${detail}): start the connection again from your Profile.`,
  declined: (permissions: string) =>
    `Permissions declined in the Facebook window: ${permissions}. Connect the account again and accept all of them.`,
  noAccount:
    'No Instagram professional account is linked to the Facebook Pages you allowed: link the account to a Page you manage, then connect again and select that Page and that account in the Facebook window.',
  permission: (detail: string) =>
    `Meta refuses for lack of a permission (${detail}): connect the account again in your Profile and accept all permissions.`,
  quota: 'This account reached the number of API posts Instagram accepts in 24 hours: try again later.',
  throttled: 'Meta is limiting calls from the app for now: try again in a few minutes.',
  assetAccess:
    'Meta refuses to publish: in the business portfolio that manages this Instagram account, give yourself access to the account, then try again.',
  tooBig: 'Instagram refuses Reels over 300 MB: export the video at a lighter quality.',
  format:
    'Instagram refuses this format: it takes H.264 or HEVC with AAC audio, 3 s to 15 min, at most 1920 pixels wide and 23 to 60 frames per second.',
  slow: 'Instagram is still processing the video after 10 minutes: publish it again.',
  uploadFailed: (detail: string) => `Meta did not receive the video (${detail}): publish it again.`,
  videoRefused: (detail: string) => `Instagram refused the video: ${detail}`,
  accountUnavailable: (detail: string) => `Meta does not give the Instagram account: ${detail}`,
  metaSaid: (text: string) => `Meta answered: ${text}`,
  httpStatus: (status: number) => `error ${status}`,
} satisfies typeof fr;
