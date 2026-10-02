export default {
  saveKeysFirst: (network: string) => `Enregistrez d’abord les clés de votre app ${network} dans le Profil.`,
  connectFirst: (network: string) => `Connectez d’abord ${network} dans le Profil.`,
  callback: {
    expired: 'Lien de connexion expiré',
    expiredDetail: 'Relancez la connexion depuis le Profil de Cadence.',
    refused: (network: string) => `${network} n’est pas connecté`,
    accessDenied: 'L’accès a été refusé.',
    answered: (network: string, error: string) => `${network} a répondu : ${error}`,
    noCode: 'La réponse ne contient pas de code de connexion : relancez la connexion.',
    connected: (network: string) => `${network} connecté`,
    linked: (name: string) => `${name} est relié à Cadence. Vous pouvez fermer cet onglet.`,
    failed: (network: string) => `Connexion à ${network} impossible`,
    unavailable: (error: string) => `Connexion impossible : ${error}`,
    back: 'Revenir au Profil de Cadence',
  },
  publish: {
    missingVideo: (file: string) => `Vidéo introuvable : ${file}`,
    alreadySending: (network: string) => `Cette vidéo part déjà sur ${network}.`,
    titleRequired: (network: string) => `${network} demande un titre.`,
    textRequired: (network: string) => `${network} demande un texte.`,
    tooLong: (what: 'title' | 'text', max: number) =>
      `${what === 'title' ? 'Titre' : 'Texte'} trop long : ${max} caractères au plus.`,
    visibilityRefused: (network: string, visibility: string) => `${network} ne propose pas la visibilité « ${visibility} ».`,
    interrupted: (reason: string) => `Envoi interrompu : ${reason}`,
  },
};
