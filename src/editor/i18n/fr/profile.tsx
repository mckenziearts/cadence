import type { ReactNode } from 'react';
import { External } from '../links';

const ELEVENLABS_KEYS = 'https://elevenlabs.io/app/settings/api-keys';

export default {
  title: 'Profil',
  subtitle: 'Les comptes que Cadence utilise sur cet ordinateur.',
  usage: {
    title: (agent: string) => `Consommation · ${agent}`,
    hintCost:
      'Ce que Cadence a demandé à l’assistant sur cet ordinateur. Coût estimé au tarif de l’API, compté sur votre abonnement.',
    hintTokens:
      'Ce que Cadence a demandé à l’assistant sur cet ordinateur. Abonnement : seuls les tokens sont comptés, pas de coût.',
    source: 'Origine',
    chats: 'Chats des projets',
    brands: 'Créations de marque',
    total: 'Total',
    runs: 'Échanges',
    read: 'Tokens lus',
    written: 'Tokens écrits',
    cost: 'Coût estimé',
    since: (day: string) => `Compté depuis le ${day}, hors travail fait dans un terminal.`,
    empty:
      'Rien de compté pour l’instant : le compte commence au prochain échange dans Cadence. Le travail fait dans un terminal n’est pas compté.',
  },
  agents: {
    title: 'Assistant IA',
    hint: 'L’IA qui pilote les chats et les créations de marque, via sa CLI. Une seule à la fois.',
    ready: 'Connecté',
    use: 'Utiliser',
    inUse: 'Utilisé',
    setup: 'Comment connecter',
    soon: 'Bientôt',
    help: {
      title: (name: string) => `Connecter ${name}`,
      installIntro: (name: string) => `${name} passe par sa CLI. Installez-la, puis connectez-vous.`,
      install: 'Installer la CLI',
      login: 'Se connecter',
      loginIntro: (name: string) => `${name} est installé mais pas connecté. Lancez :`,
      docs: 'Voir la documentation',
    },
  },
  git: 'Dépôts Git',
  gitHint: 'Pour construire une marque depuis un dépôt.',
  voice: {
    title: 'Voix off',
    hint: 'Les moteurs qui disent la voix off. Chaque projet choisit le sien dans son onglet Voix.',
    piper: {
      ready: 'Installé, gratuit',
      missing: 'Piper n’est pas installé',
      install: 'Installez-le une fois dans un terminal, puis redémarrez Cadence :',
      voices: 'Voix sur cet ordinateur',
      none: 'Aucune voix téléchargée : un projet télécharge la sienne depuis son onglet Voix.',
    },
    elevenLabs: {
      configured: 'Clé enregistrée',
      noKey: 'Pas de clé',
      key: 'Clé API ElevenLabs',
      keyHint: (
        <>
          Créez-la dans les <External href={ELEVENLABS_KEYS}>réglages de votre compte ElevenLabs</External>.
        </>
      ) as ReactNode,
      billing:
        'Le texte de la voix off part chez ElevenLabs et chaque génération est facturée sur votre compte. Une vidéo qui vend un produit demande un forfait payant.',
      saveKey: 'Enregistrer la clé',
      newProjects: 'Nouveaux projets',
      defaultLabel: 'Voix des nouveaux projets',
      piper: 'Piper, voix de la langue',
      defaultHint: 'Écrite dans un projet à sa création : les projets existants gardent leur voix.',
      removeKey: 'Retirer la clé',
      removeKeyConfirm: 'Retirer la clé ?',
    },
  },
  networks: 'Réseaux',
  networksHint: 'Pour publier une vidéo depuis la page Rendu.',
  checking: 'Vérification',
  via: (account: string, cli: string) => `${account} (via ${cli})`,
  missing: (cli: string) => `${cli} n’est pas installé`,
  loggedOut: (cli: string) => `${cli} n’est pas connecté`,
  failing: (cli: string) => `${cli} ne répond pas`,
  notConfigured: 'Pas configuré',
  setUp: 'Configurer',
  keys: 'Clés',
  disconnect: 'Déconnecter',
  disconnectConfirm: 'Déconnecter ?',
  disconnected: (network: string) => `${network} déconnecté`,
  keysTitle: (network: string) => `Clés de l’app ${network}`,
  keysSaved: (network: string) => `Clés ${network} enregistrées`,
  secretAgain: 'À saisir de nouveau',
  redirect: 'Adresse de retour',
};
