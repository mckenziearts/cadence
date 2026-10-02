export default {
  expired:
    'La connexion YouTube a expiré ou a été retirée : reconnectez votre chaîne dans le Profil (avec un écran de consentement en mode « Test », Google la coupe au bout de 7 jours).',
  noChannel: 'Ce compte Google n’a pas de chaîne YouTube : créez-la sur youtube.com, puis reconnectez-vous.',
  angleBrackets: 'YouTube refuse les signes < et > dans le titre et la description.',
  stalled: 'YouTube ne reçoit plus la vidéo : relancez la publication.',
  codeRefused: 'Google a refusé le code de connexion : relancez la connexion.',
  badKeys: 'Google ne reconnaît pas ces clés : vérifiez l’ID client et le code secret dans le Profil.',
  googleSaid: (text: string) => `Google a répondu : ${text}`,
  httpStatus: (status: number) => `erreur ${status}`,
  quota: 'Quota d’envoi YouTube du jour atteint : réessayez demain.',
  apiDisabled: 'L’API YouTube Data v3 n’est pas activée dans votre projet Google Cloud : activez-la, puis réessayez.',
  videoRefused: (detail: string) => `YouTube a refusé la vidéo : ${detail}`,
  channelUnavailable: (detail: string) => `YouTube ne donne pas la chaîne : ${detail}`,
};
