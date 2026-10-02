const expired = 'La connexion TikTok a expiré ou a été retirée : reconnectez votre compte dans le Profil.';
const outage = 'TikTok a un problème de son côté : réessayez dans un moment.';

export default {
  expired,
  codeRefused: 'TikTok a refusé le code de connexion : relancez la connexion.',
  badKeys: 'TikTok ne reconnaît pas ces clés : vérifiez la Client key et le Client secret dans le Profil.',
  stalled: (status: number) => `TikTok ne reçoit plus la vidéo (erreur ${status}) : relancez la publication.`,
  stillProcessing:
    'TikTok traite encore la vidéo au bout de 10 minutes : si elle n’arrive pas dans votre boîte de réception TikTok, relancez la publication.',
  tiktokSaid: (text: string) => `TikTok a répondu : ${text}`,
  httpStatus: (status: number) => `erreur ${status}`,
  videoRefused: (detail: string) => `TikTok a refusé la vidéo : ${detail}`,
  accountUnavailable: (detail: string) => `TikTok ne donne pas le compte : ${detail}`,
  /** TikTok's error codes and fail reasons that someone can act on. */
  reasons: {
    access_token_invalid: expired,
    auth_removed: 'L’accès de Cadence a été retiré pendant l’envoi : reconnectez votre compte dans le Profil.',
    scope_not_authorized:
      'Cadence n’a pas le droit d’envoyer de vidéos sur ce compte : ajoutez le scope video.upload à l’app TikTok, puis reconnectez le compte dans le Profil en laissant cette autorisation cochée.',
    spam_risk_too_many_pending_share:
      'TikTok accepte au plus 5 brouillons en attente par compte sur 24 heures : réessayez plus tard.',
    spam_risk_too_many_posts: 'Ce compte a publié trop de vidéos par des apps en 24 heures : réessayez demain.',
    spam_risk_user_banned_from_posting: 'TikTok interdit pour le moment à ce compte de publier.',
    rate_limit_exceeded: 'Trop de demandes à TikTok en une minute : réessayez dans une minute.',
    file_format_check_failed: 'TikTok refuse le format du fichier : MP4, MOV ou WebM, en H.264 de préférence.',
    duration_check_failed: 'TikTok refuse la durée de la vidéo : 10 minutes au plus.',
    frame_rate_check_failed: 'TikTok refuse la cadence de la vidéo : de 23 à 60 images par seconde.',
    picture_size_check_failed: 'TikTok refuse la taille de l’image : de 360 à 4096 pixels de côté.',
    internal: outage,
    internal_error: outage,
  },
};
