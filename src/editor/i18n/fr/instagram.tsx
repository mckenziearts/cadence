import type { ReactNode } from 'react';
import { External } from '../links';
import type youtube from './youtube';

/** What the Profile shows for Instagram: the Meta app (Facebook Login) to create once, then the account to connect. */
export default {
  keysSubtitle: 'Une app Meta pour toute l’équipe : chacun colle les mêmes clés.',
  steps: [
    <>
      Sur <External href="https://developers.facebook.com/apps/creation/">developers.facebook.com</External>, créez une app avec
      le cas d’usage « Manage messaging & content on Instagram ». À l’étape Business, choisissez « I don't want to connect a
      business portfolio yet ».
    </>,
    'Dans ce cas d’usage, ouvrez « API setup with Facebook login » (pas Instagram login), puis cliquez sur « Add all required permissions ».',
    <>
      App roles, puis Roles : ajoutez chaque coéquipier comme Tester ; chacun accepte l’invitation sur{' '}
      <External href="https://developers.facebook.com/requests/">developers.facebook.com/requests</External>. Laissez l’app en
      mode développement.
    </>,
    'App settings, puis Basic : collez ici l’App ID et l’App secret.',
  ],
  note: 'Chaque compte Instagram doit être professionnel et relié à une Page Facebook que la personne gère ; dans la fenêtre Facebook, cochez cette Page et ce compte : Cadence publie sur le compte trouvé à la connexion. Meta coupe la connexion au bout de 60 jours.',
  clientId: 'ID de l’app',
  clientSecret: 'Clé secrète',
  redirectHint:
    'Rien à déclarer : tant que l’app reste en mode développement, Meta accepte les adresses localhost sans les lister.',
  connect: 'Connecter le compte',
  notConnected: 'Compte pas connecté',
  publish: {
    connectFirst: 'Connectez d’abord votre compte Instagram dans le Profil : les vidéos partent sur ce compte.',
    onAccount: (name: ReactNode): ReactNode => <>Sur le compte {name}.</>,
    text: 'Légende',
    hint: 'Publiée tout de suite en Reel public : l’API d’Instagram n’a ni brouillon ni publication privée.',
    formatHint: (format: string, seconds: number): string | null =>
      seconds < 3 || seconds > 900
        ? 'Instagram refuse les Reels de moins de 3 s ou de plus de 15 min.'
        : format === '9:16'
          ? null
          : 'Hors 9:16, Instagram recadre la vidéo ou ajoute des bandes dans l’onglet Reels.',
    forbidden: null,
    sent: (account: string) => `Publiée sur Instagram, compte ${account}`,
    keptPrivate: '',
  },
} satisfies typeof youtube;
