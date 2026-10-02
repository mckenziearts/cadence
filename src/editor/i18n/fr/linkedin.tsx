import type { ReactNode } from 'react';
import { External } from '../links';
import type youtube from './youtube';

/** What the Profile shows for LinkedIn: the app to create once, then the account to connect. */
export default {
  keysSubtitle: 'Une app LinkedIn pour toute l’équipe : chacun colle les mêmes clés.',
  steps: [
    <>
      Sur <External href="https://www.linkedin.com/developers/apps/new">linkedin.com/developers</External>, créez une app reliée à
      la Page LinkedIn de l’équipe. Si l’onglet Settings affiche « Verify », faites-la approuver par un super admin de la Page.
    </>,
    'Products : cliquez « Request access » sur « Share on LinkedIn » puis sur « Sign In with LinkedIn using OpenID Connect ».',
    'Auth : sous « Authorized redirect URLs for your app », ajoutez l’adresse de retour ci-dessous, telle quelle.',
    'Auth : copiez le Client ID et le Primary Client Secret, puis collez-les ici.',
  ],
  note: 'LinkedIn coupe la connexion au bout de 60 jours : reconnectez-vous alors dans le Profil. Les vidéos partent sur votre profil personnel, pas sur la Page de l’équipe.',
  clientId: 'Client ID',
  clientSecret: 'Client Secret',
  redirectHint: 'Une adresse par port : si vous lancez Cadence sur un autre port, faites ajouter la vôtre dans l’onglet Auth.',
  connect: 'Connecter le compte',
  notConnected: 'Compte pas connecté',
  publish: {
    connectFirst: 'Connectez d’abord votre compte LinkedIn dans le Profil : les vidéos partent sur ce compte.',
    onAccount: (name: ReactNode): ReactNode => <>Sur le profil {name}.</>,
    text: 'Texte du post',
    hint: 'Pas de visibilité privée sur LinkedIn : vos relations directes, ou tout le monde. Le post paraît dès que LinkedIn a traité la vidéo, en quelques minutes.',
    formatHint: (_format: string, seconds: number): string | null =>
      seconds < 3 ? 'LinkedIn refuse les vidéos de moins de 3 secondes.' : null,
    forbidden: null,
    sent: (account: string) => `Publiée sur LinkedIn, profil ${account}`,
    keptPrivate: '',
  },
} satisfies typeof youtube;
