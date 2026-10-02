import type { ReactNode } from 'react';
import { External } from '../links';

const AUDIT_FORM = 'https://support.google.com/youtube/contact/yt_api_form';

/** What the Profile shows for YouTube: the Google app to create once, then the channel to connect. */
export default {
  keysSubtitle: 'Une app Google pour toute l’équipe : chacun colle les mêmes clés.',
  steps: [
    <>
      Sur <External href="https://console.cloud.google.com/">console.cloud.google.com</External>, créez un projet et activez «
      YouTube Data API v3 ».
    </>,
    'Écran de consentement : type « Externe », puis « Publier l’application ».',
    'Identifiants : créez un « ID client OAuth » de type « Application de bureau ».',
    'Collez son ID client et son code secret ici.',
  ],
  note: (
    <>
      En mode « Test », Google coupe la connexion au bout de 7 jours. Sans l’<External href={AUDIT_FORM}>audit YouTube</External>{' '}
      (gratuit), les vidéos envoyées restent privées.
    </>
  ) as ReactNode,
  clientId: 'ID client',
  clientSecret: 'Code secret',
  redirectHint: 'À déclarer seulement pour un ID client de type « Application Web ».',
  connect: 'Connecter la chaîne',
  notConnected: 'Chaîne pas connectée',
  /** « Publier » for this network. */
  publish: {
    connectFirst: 'Connectez d’abord votre chaîne YouTube dans le Profil : les vidéos partent sur ce compte.',
    onAccount: (name: ReactNode): ReactNode => <>Sur la chaîne {name}.</>,
    text: 'Description',
    hint: 'Tant que le projet Google n’a pas passé l’audit YouTube, la vidéo reste privée quoi que vous choisissiez.' as ReactNode,
    formatHint: (format: string, seconds: number): string | null =>
      format !== '9:16'
        ? null
        : seconds <= 180
          ? 'Verticale et de 3 min ou moins : YouTube en fait un Short.'
          : 'Plus de 3 min : YouTube la publie comme une vidéo, pas comme un Short.',
    forbidden: 'YouTube refuse les signes < et > dans le titre et la description.' as string | null,
    sent: (account: string) => `Envoyée sur YouTube, chaîne ${account}`,
    keptPrivate: 'YouTube l’a gardée privée : le projet Google n’a pas encore passé l’audit.',
  },
};
