import { plural } from '../../lib/format';

/** Around the panels: top bar, projects home, stage, presentation; then what the store, the API client and the events say. */
export default {
  app: {
    down: 'Cadence ne répond pas',
    retry: 'Réessayer',
    loadingProject: 'Chargement du projet',
    dropMusic: 'Déposez la musique de la vidéo',
    dropMusicHint: 'Cadence analyse ses temps, ses mesures et ses phrases.',
    dropNotAudio: 'Déposez un fichier audio ici, ou vos images dans l’onglet Médias.',
    closeToast: 'Fermer la notification',
    stale:
      'Cadence a redémarré depuis l’ouverture de cette page : rechargez-la pour continuer (vos messages en cours sont gardés).',
    reload: 'Recharger',
    offline: 'Connexion au serveur perdue, reconnexion\u2026',
    loop: 'Lecture en boucle',
    playOnce: 'Lecture unique',
  },
  /** Shared by the home and the project switcher of the top bar. */
  projects: {
    title: 'Projets',
    new: 'Nouveau projet',
    search: 'Rechercher un projet',
    searchPlaceholder: 'Rechercher un projet\u2026',
    noBrand: 'Sans marque',
    scenes: (n: number) => plural(n, 'scène', 'scènes'),
  },
  topBar: {
    home: 'Accueil des projets',
    homeLink: 'Cadence, accueil des projets',
    view: 'Vue',
    scenes: 'Scènes',
    render: 'Rendu',
    artDirection: 'Direction artistique',
    artDirectionHint: 'Direction artistique : le style que suivent toutes les scènes',
    copyPath: 'Copier le chemin',
    copyPathHint: (dir: string) => `Copier le chemin du projet : ${dir}`,
    pathCopied: 'Chemin du projet copié',
    present: 'Présenter',
    profile: 'Profil',
    settings: 'Réglages',
    cost: {
      title: 'Coût',
      hint: 'Chats de ce projet, en coût équivalent API compté sur votre abonnement Claude. Créations de marque comprises, le total est dans Profil.',
      label: (amount: string | null) =>
        `Coût estimé des chats de ce projet : ${amount ?? 'inconnu'}, équivalent API compté sur votre abonnement Claude`,
      unknown: '\u2013\u00a0$',
    },
    build: {
      steps: {
        queued: 'En attente',
        cloning: 'Copie',
        building: 'Construction',
        checking: 'Vérification',
        done: 'Prête',
        error: 'Échec',
        cancelled: 'Annulée',
      },
      label: (name: string, step: string) => `Marque « ${name} » : ${step}`,
      open: 'Voir la planche du kit et créer un projet',
      failed: 'Voir ce qui a échoué',
    },
    brand: {
      label: (name: string) => `Marque ${name}`,
      hint: 'Marque du projet : couleurs, polices, kit',
    },
  },
  projectSwitcher: {
    loading: 'Chargement\u2026',
    choose: 'Choisir un projet',
    noMatch: 'Aucun projet ne correspond.',
    current: 'Projet ouvert',
  },
  home: {
    projects: (n: number) => plural(n, 'projet', 'projets'),
    brands: (n: number) => plural(n, 'marque', 'marques'),
    brandFilter: 'Marque',
    all: 'Toutes',
    newHint: 'Modèle, marque et formats',
    noMatch: (query: string) => `Aucun projet ne correspond à « ${query} ».`,
    /** `when` comes from relative(): a date ("12 sept., 14:05") takes "le", "hier, 14:05" does not. */
    edited: (when: string) => `Modifié ${/^\d/.test(when) ? `le ${when}` : when}`,
    delete: (name: string) => `Supprimer le projet « ${name} »`,
    deleteConfirm: 'Supprimer le projet ?',
    deleted: (name: string) => `Projet « ${name} » supprimé (le dossier est dans projects/.trash)`,
    pitch: {
      title: (
        <>
          Décrivez une vidéo, <span className="text-now">Claude l’écrit scène par scène.</span>
        </>
      ),
      body: 'Chaque scène est un composant qui dessine une image pour un instant donné, à la milliseconde. Les animations se calent sur la musique, les coupes deviennent invisibles, et chaque marque se décline dans tous les formats.',
      create: 'Créer un projet',
      brands: 'Commencer avec une marque',
    },
  },
  stage: {
    label: 'Aperçu',
    sceneOf: (n: number, count: number) => `Scène ${n} sur ${count}`,
    whole: 'Vidéo entière',
    sceneCount: (n: number) => `${n} scène${n > 1 ? 's' : ''}`,
    scene: (n: number, name: string) => `Scène ${n} : ${name}`,
    format: 'Format de l’aperçu',
    showSafeArea: 'Afficher les zones de sécurité',
    hideSafeArea: 'Masquer les zones de sécurité',
    frame: 'Aperçu de la vidéo',
    appHeader: 'En-tête de l’application',
    caption: 'Légende et boutons',
    collapse: 'Réduire',
    details: 'Détails',
    askFix: 'Demander à Claude de corriger',
    /** Put in the scene's composer: Claude reads it. */
    fixPrompt: (errors: string) =>
      `L’aperçu affiche une erreur. Corrige-la sans changer l’animation :\n\n\`\`\`\n${errors}\n\`\`\``,
  },
  present: {
    label: 'Présentation',
    frame: 'Présentation de la vidéo',
    pause: 'Pause',
    replay: 'Revoir',
    play: 'Lecture',
    exit: 'Quitter la présentation (Échap)',
  },
  events: {
    unreadable: '[cadence] événement illisible',
    renderDone: (format: string) => `Rendu ${format} terminé`,
    renderFailed: (format: string, error?: string) => `Rendu ${format} en échec : ${error ?? 'erreur inconnue'}`,
    published: (network: string) => `Vidéo envoyée sur ${network}`,
    publishFailed: (network: string, error?: string) => `Publication sur ${network} en échec : ${error ?? 'erreur inconnue'}`,
    brandReady: (name: string) => `Marque « ${name} » prête`,
    brandFailed: (name: string) => `La marque « ${name} » n’a pas pu être construite`,
    musicFailed: 'Analyse de la musique impossible',
  },
  api: {
    failed: (status: number, method: string, url: string) => `Erreur ${status} sur ${method} ${url}`,
    down: 'Cadence ne répond pas : le serveur est-il lancé ?',
  },
  project: {
    gone: 'Ce projet n’existe plus.',
    badDuration: 'Durée invalide : indiquez des secondes (2,5) ou des mesures (2 mes.).',
    sceneAdded: (name: string) => `Scène « ${name} » ajoutée`,
    sceneDeleted: (name: string) => `Scène « ${name} » supprimée (le fichier est dans .cadence/trash)`,
    seams: {
      none: 'Aucun raccord à vérifier : le projet n’a qu’une scène.',
      clean: 'Tous les raccords sont invisibles.',
      jumps: (formats: string) => `Certains raccords sautent (${formats}) : voir les pastilles entre les scènes.`,
    },
  },
  clipboard: {
    copied: 'Copié dans le presse-papiers',
    failed: 'Copie impossible : sélectionnez le texte à la main.',
  },
};
