export default {
  expired:
    'La connexion Instagram a expiré ou a été retirée : reconnectez le compte dans le Profil (Meta la coupe au bout de 60 jours).',
  badKeys: 'Meta ne reconnaît pas ces clés : vérifiez l’ID de l’app et la clé secrète dans le Profil.',
  codeRefused: (detail: string) => `Meta a refusé le code de connexion (${detail}) : relancez la connexion depuis le Profil.`,
  declined: (permissions: string) =>
    `Autorisations refusées dans la fenêtre Facebook : ${permissions}. Reconnectez le compte en les acceptant toutes.`,
  noAccount:
    'Aucun compte Instagram professionnel n’est relié aux Pages Facebook autorisées : reliez le compte à une Page que vous gérez, puis reconnectez-vous en cochant cette Page et ce compte dans la fenêtre Facebook.',
  permission: (detail: string) =>
    `Meta refuse faute d’autorisation (${detail}) : reconnectez le compte dans le Profil en acceptant toutes les autorisations.`,
  quota: 'Ce compte a atteint le nombre de publications par API qu’Instagram accepte sur 24 heures : réessayez plus tard.',
  throttled: 'Meta limite pour le moment les appels de l’app : réessayez dans quelques minutes.',
  assetAccess:
    'Meta refuse la publication : dans le portefeuille business qui gère ce compte Instagram, donnez-vous accès au compte, puis réessayez.',
  tooBig: 'Instagram refuse les Reels de plus de 300 Mo : exportez la vidéo dans une qualité plus légère.',
  format:
    'Instagram refuse ce format : il faut du H.264 ou du HEVC avec un son AAC, de 3 s à 15 min, 1920 pixels de large au plus et de 23 à 60 images par seconde.',
  slow: 'Instagram traite encore la vidéo au bout de 10 minutes : relancez la publication.',
  uploadFailed: (detail: string) => `Meta n’a pas reçu la vidéo (${detail}) : relancez la publication.`,
  videoRefused: (detail: string) => `Instagram a refusé la vidéo : ${detail}`,
  accountUnavailable: (detail: string) => `Meta ne donne pas le compte Instagram : ${detail}`,
  metaSaid: (text: string) => `Meta a répondu : ${text}`,
  httpStatus: (status: number) => `erreur ${status}`,
};
