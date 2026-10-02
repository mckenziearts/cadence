export default {
  expired:
    'La connexion LinkedIn a expiré ou a été retirée : reconnectez votre compte dans le Profil (LinkedIn la limite à 60 jours).',
  badKeys: 'LinkedIn ne reconnaît pas ces clés : vérifiez le Client ID et le Client Secret dans le Profil.',
  codeRefused: (detail: string) => `LinkedIn a refusé la connexion (${detail}) : relancez-la depuis le Profil.`,
  noShare:
    'L’app LinkedIn n’a pas le droit de publier : ajoutez-lui le produit « Share on LinkedIn » (onglet Products), puis reconnectez votre compte dans le Profil.',
  forbidden: (detail: string) =>
    `LinkedIn refuse l’accès (${detail}) : vérifiez que l’app a les produits « Share on LinkedIn » et « Sign In with LinkedIn using OpenID Connect » (onglet Products), puis reconnectez votre compte dans le Profil.`,
  quota: 'Limite quotidienne de LinkedIn atteinte : réessayez demain.',
  outdated: 'Cette version de Cadence appelle une version de l’API LinkedIn qui n’est plus servie : mettez Cadence à jour.',
  uploadFailed: (status: number) => `L’envoi de la vidéo à LinkedIn a échoué (erreur ${status}) : relancez la publication.`,
  processingFailed: (reason: string) => `LinkedIn n’a pas pu traiter la vidéo : ${reason}`,
  stillProcessing: (minutes: number) =>
    `LinkedIn traite encore la vidéo au bout de ${minutes} minutes : rien n’a été publié, relancez la publication plus tard.`,
  videoRefused: (detail: string) => `LinkedIn a refusé la vidéo : ${detail}`,
  postRefused: (detail: string) => `LinkedIn a refusé le post : ${detail}`,
  profileUnavailable: (detail: string) => `LinkedIn ne donne pas votre profil : ${detail}`,
  httpStatus: (status: number) => `erreur ${status}`,
  textTooLong: (max: number) =>
    `Texte trop long pour LinkedIn une fois ses signes spéciaux protégés (${max} caractères au plus) : raccourcissez-le.`,
};
