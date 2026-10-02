import type { ReactNode } from 'react';
import { External } from '../links';
import type youtube from './youtube';

/** What the Profile shows for TikTok: the Sandbox app to create once, then the account to connect. */
export default {
  keysSubtitle: 'Une app TikTok pour toute l’équipe : chacun colle les mêmes clés.',
  steps: [
    <>
      Sur <External href="https://developers.tiktok.com/apps">developers.tiktok.com/apps</External>, « Connect an app ». Passez
      l’interrupteur à côté de son nom sur « Sandbox », puis « Create Sandbox ».
    </>,
    'App details : une icône, une catégorie, une description (TikTok la montre à la connexion) et, sous « Platforms », « Desktop » avec l’adresse du site de l’équipe.',
    'Products : ajoutez « Login Kit » et « Content Posting API » (laissez « Direct Post » désactivé). Dans Login Kit, plateforme Desktop, déclarez l’adresse de retour ci-dessous.',
    'Scopes : user.info.basic et video.upload doivent y être (« Add Scopes » sinon). Puis « Apply changes ».',
    'Sandbox settings, Target users : « Add account » pour chaque coéquipier, qui s’y connecte avec son propre compte TikTok (10 comptes au plus).',
    'Collez ici la Client key et le Client secret de la Sandbox (App details, Credentials).',
  ],
  note: 'TikTok reçoit la vidéo en brouillon : chacun la termine et la publie depuis l’app. TikTok ne dit pas si un brouillon venu d’une app en Sandbox peut être publié en public : faites un essai, et si la vidéo reste privée, rendez le compte public, puis passez la vidéo sur « Tout le monde » dans ses réglages de confidentialité.',
  clientId: 'Client key',
  clientSecret: 'Client secret',
  redirectHint:
    'À déclarer telle quelle dans Login Kit, plateforme Desktop. Avec * à la place du port, elle vaut pour tous les ports.',
  connect: 'Connecter le compte',
  notConnected: 'Compte pas connecté',
  publish: {
    connectFirst: 'Connectez d’abord votre compte TikTok dans le Profil : les vidéos partent sur ce compte.',
    onAccount: (name: ReactNode): ReactNode => <>En brouillon sur le compte {name}.</>,
    text: '',
    hint: 'TikTok reçoit la vidéo en brouillon : ouvrez la notification dans l’app TikTok pour écrire la légende, choisir qui peut la voir et la publier. 5 brouillons en attente au plus par 24 heures.',
    formatHint: (format: string, seconds: number): string | null =>
      seconds > 600
        ? 'Plus de 10 min : TikTok refusera la vidéo.'
        : seconds > 180
          ? 'Plus de 3 min : selon le compte, l’app TikTok vous demandera peut-être de la raccourcir.'
          : format === '9:16'
            ? null
            : 'TikTok est fait pour la vidéo verticale : le 9:16 y rend le mieux.',
    forbidden: null,
    sent: (account: string) => `Brouillon envoyé à ${account} : publiez-le depuis l’app TikTok`,
    keptPrivate: '',
  },
} satisfies typeof youtube;
