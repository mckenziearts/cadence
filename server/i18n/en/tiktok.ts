import type fr from '../fr/tiktok';

const expired = 'The TikTok connection expired or was removed: reconnect your account in your Profile.';
const outage = 'TikTok has a problem on its side: try again in a moment.';

export default {
  expired,
  codeRefused: 'TikTok refused the sign-in code: start the connection again.',
  badKeys: 'TikTok does not recognize these keys: check the Client key and the Client secret in your Profile.',
  stalled: (status: number) => `TikTok no longer receives the video (error ${status}): publish it again.`,
  stillProcessing:
    'TikTok is still processing the video after 10 minutes: if it does not reach your TikTok inbox, publish it again.',
  tiktokSaid: (text: string) => `TikTok answered: ${text}`,
  httpStatus: (status: number) => `error ${status}`,
  videoRefused: (detail: string) => `TikTok refused the video: ${detail}`,
  accountUnavailable: (detail: string) => `TikTok does not give the account: ${detail}`,
  reasons: {
    access_token_invalid: expired,
    auth_removed: 'Access for Cadence was removed during the upload: reconnect your account in your Profile.',
    scope_not_authorized:
      'Cadence may not send videos to this account: add the video.upload scope to the TikTok app, then reconnect the account in your Profile and leave that permission ticked.',
    spam_risk_too_many_pending_share: 'TikTok takes at most 5 pending drafts per account in 24 hours: try again later.',
    spam_risk_too_many_posts: 'This account posted too many videos through apps in 24 hours: try again tomorrow.',
    spam_risk_user_banned_from_posting: 'TikTok does not let this account post for now.',
    rate_limit_exceeded: 'Too many requests to TikTok in one minute: try again in a minute.',
    file_format_check_failed: 'TikTok refuses the file format: MP4, MOV or WebM, preferably H.264.',
    duration_check_failed: 'TikTok refuses the length of the video: 10 minutes at most.',
    frame_rate_check_failed: 'TikTok refuses the frame rate of the video: 23 to 60 frames per second.',
    picture_size_check_failed: 'TikTok refuses the picture size: 360 to 4096 pixels per side.',
    internal: outage,
    internal_error: outage,
  },
} satisfies typeof fr;
