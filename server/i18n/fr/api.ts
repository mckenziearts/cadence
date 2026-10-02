// The REST API, the stores, the frame server and the server's start (terminal output included).
export default {
  projectNotFound: (id: string) => `Projet introuvable : ${id}`,
  sceneNotFound: (id: string) => `Scène introuvable : ${id}`,
  fileNotFound: (file: string) => `Fichier introuvable : ${file}`,
  unknownFormat: (format: unknown) => `Format inconnu : ${format}`,
  unreadableFile: (file: string, error: string) => `${file} illisible : ${error}`,
  invalidFile: (file: string, issues: string) => `${file} invalide : ${issues}`,
  internalError: (error: string) => `Erreur interne : ${error}`,
  /** What assertId() names in its error. */
  ids: {
    id: 'identifiant',
    project: 'Identifiant de projet',
    scene: 'Identifiant de scène',
    brand: 'Identifiant de marque',
    template: 'Identifiant de modèle',
  },
  util: {
    invalidPath: (rel: string) => `Chemin invalide : ${rel}`,
    invalidId: (what: string, id: string) => `${what} invalide : ${id}`,
  },
  routes: {
    fileNotFound: 'Fichier introuvable',
    errorLog: '[cadence] erreur API :',
    unknownRoute: (method: string, path: string) => `Route inconnue : ${method} ${path}`,
    tooLarge: 'Requête trop volumineuse',
    eventsUnavailable: "Flux d'événements indisponible",
    rendering: "Un rendu de ce projet est en cours : annulez-le d'abord.",
    publishing: "Une vidéo de ce projet part sur un réseau : attendez la fin de l'envoi.",
    videoSending: "Cette vidéo part sur un réseau : attendez la fin de l'envoi pour la supprimer.",
    noMusic: "Ce projet n'a pas de musique",
    imageName: (name: string) => `Nom d'image invalide : ${name}`,
    gitHost: (host: string) => `Hébergeur Git inconnu : ${host}`,
    logoVariant: (variant: string) => `Variante de logo inconnue : ${variant}`,
    defaultBrand: "La marque neutre Cadence ne se supprime pas : les nouvelles marques partent d'elle.",
    brandInUse: (projects: string[]) => {
      const names = projects.map((name) => `« ${name} »`);
      return names.length === 1
        ? `Le projet ${names[0]} utilise cette marque : supprimez-le ou changez sa marque d'abord.`
        : `Les projets ${names.join(', ')} utilisent cette marque : supprimez-les ou changez leur marque d'abord.`;
    },
    agentBusy: "Claude travaille sur ce projet : arrêtez d'abord la réponse en cours.",
    invalidJson: 'Corps de requête JSON invalide',
    issue: (path: string, message: string) => `${path} : ${message}`,
    invalidBody: (issues: string[]) => `Requête invalide \u2014 ${issues.join(' ; ')}`,
    rangeOrder: 'la fin doit suivre le début',
    fileTooLarge: (mb: number) => `Fichier trop volumineux (${mb} Mo max)`,
    invalidUpload: 'Envoi de fichier invalide (multipart/form-data attendu)',
    noFile: 'Aucun fichier reçu (champ « file »)',
    unknownChat: (key: string) => `Conversation inconnue : ${key}`,
    unknownNetwork: (id: string) => `Réseau inconnu : ${id}`,
    missingParam: (name: string) => `Paramètre « ${name} » manquant`,
    invalidParam: (name: string, value: string) => `Paramètre « ${name} » invalide : ${value}`,
  },
  /** Version labels are written to the history in the language of the moment. */
  versions: {
    initial: 'État initial',
    templateInserted: (scene: string) => `Modèle inséré : ${scene}`,
    beforeSnap: 'Avant le calage des coupes',
    manual: 'Sauvegarde manuelle',
    unsaved: 'Modifications non enregistrées',
    untitled: 'Version sans titre',
    restoredScene: (scene: string, version: string) => `Restauration de « ${scene} » (${version})`,
    restored: (version: string) => `Restauration de ${version}`,
    notSaved: (error: string) => `[cadence] version non enregistrée : ${error}`,
    sceneMissing: (scene: string, version: string) => `La scène « ${scene} » n'existe pas dans la version ${version}`,
    sceneGone: (scene: string) => `La scène « ${scene} » n'existe plus dans le projet : restaurez la version entière`,
    notFound: (version: string) => `Version introuvable : ${version}`,
    unreadableIndex: (file: string) => `Historique des versions illisible : ${file}`,
    unreadableManifest: (version: string) => `Version ${version} illisible (manifeste manquant ou corrompu)`,
    invalidHash: (hash: string) => `Empreinte invalide dans l'historique : ${hash}`,
    missingObject: (hash: string) => `Contenu manquant dans l'historique : ${hash}`,
  },
  projects: {
    skipped: (error: string) => `[cadence] projet ignoré : ${error}`,
    names: { project: 'Le nom du projet', scene: 'Le nom de la scène' },
    nameRequired: (what: string) => `${what} est obligatoire`,
    nameTooLong: (what: string) => `${what} est trop long (120 caractères max)`,
    unknownBrand: (brand: string) => `Marque inconnue : ${brand}`,
    exists: (id: string) => `Le projet « ${id} » existe déjà`,
    /** Name of the one scene of a project created without a campaign template. */
    starterScene: 'Titre',
    codeTooLarge: 'Code de scène trop volumineux (1 Mo max)',
    sceneFileNotFound: (file: string) => `Fichier de la scène introuvable : ${file}`,
    copy: (name: string) => `${name} (copie)`,
    lastScene: 'Un projet doit garder au moins une scène',
    order: 'Le nouvel ordre doit contenir chaque scène exactement une fois',
    music: (issues: string) => `Réglages de musique invalides : ${issues}`,
    relativePath: 'chemin relatif au projet attendu',
    duplicateScene: (id: string) => `scène en double « ${id} »`,
    musicGrid: (id: string, error: string) => `[cadence] grille musicale indisponible (${id}) : ${error}`,
    reload: (id: string, error: string) => `[cadence] rechargement du code impossible (${id}) : ${error}`,
    pickFormat: 'Choisissez au moins un format',
    fps: (value: unknown) => `Images par seconde invalides : ${value} (24, 30 ou 60)`,
    language: (value: unknown) => `Langue invalide : ${String(value)} (fr, en ou null)`,
    tempo: (value: unknown) => `Tempo invalide : ${value} (entre 30 et 300 BPM)`,
    duration: (value: unknown) => `Durée invalide : ${value}`,
    /** Path of a validation issue on the whole file. */
    root: 'racine',
    /** art-direction.md of a new project whose brand has none. */
    artDirection: `# Direction artistique

Claude relit ce document avant chaque modification. Décrivez ici le style commun à toutes les scènes.

## Palette
- Fond : la couleur \`background\` de la marque ; cartes et panneaux en \`surface\`.
- Texte principal en \`ink\`, texte secondaire en \`muted\`, filets en \`line\`.
- \`primary\` pour l'action principale et les moments forts ; \`accent\` avec parcimonie, pour les annotations.

## Typographie
- Titres en police \`display\` : 96 à 160 px en 16:9, graisse 600 à 700, interlettrage serré (\u22120,03 à \u22120,045 em), interligne 1,0 à 1,1.
- Textes et interfaces en police \`body\` (20 à 32 px) ; chiffres et code en \`mono\`.
- Une idée par scène, huit mots au plus par titre.

## Mouvement
- Calme et précis. Entrées de 0,5 à 0,9 s qui décélèrent (ease.outExpo, ressorts pour les objets d'interface).
- Sorties plus courtes (0,25 à 0,4 s) qui accélèrent.
- Décaler les éléments liés de 40 à 70 ms ; lancer le mouvement suivant avant que le précédent ne soit posé.
- Caler les moments forts sur la musique (temps, mesures, phrases) plutôt que sur des secondes fixes.

## Mise en page
- Marges généreuses (au moins 8 % du cadre), compositions centrées sauf indication contraire.
- Chaque scène s'adapte à tous les formats du projet avec \`useFormat()\` : aucun texte coupé en 9:16.

## Coupes
- Coupes invisibles : quand un objet continue d'une scène à l'autre, la dernière image de la scène est identique à la première de la suivante.
`,
  },
  assets: {
    unsupported: (name: string) =>
      `Type de fichier non pris en charge : ${name} (images PNG, JPEG, WebP, GIF, SVG ou polices WOFF, WOFF2, TTF, OTF)`,
    empty: (name: string) => `Fichier vide : ${name}`,
    tooLarge: (name: string) => `Fichier trop volumineux : ${name} (50 Mo max)`,
    invalidUrl: (url: string) => `Adresse invalide : ${url}`,
    httpOnly: (url: string) => `Seules les adresses http:// et https:// peuvent être capturées : ${url}`,
    unknownDevice: (device: string) => `Appareil inconnu : ${device}`,
    captureFailed: (url: string, error: string) => `Capture de ${url} impossible : ${error}`,
  },
  brands: {
    hex: 'couleur #rrggbb attendue',
    notFound: (id: string) => `Marque introuvable : ${id}`,
    skipped: (error: string) => `[cadence] marque ignorée : ${error}`,
    building: "Cette marque est en construction : annulez d'abord la construction.",
  },
  templates: {
    sceneSkipped: (error: string) => `[cadence] modèle de scène ignoré : ${error}`,
    projectSkipped: (error: string) => `[cadence] modèle de projet ignoré : ${error}`,
    sceneNotFound: (id: string) => `Modèle de scène introuvable : ${id}`,
    projectNotFound: (id: string) => `Modèle de projet introuvable : ${id}`,
    missingCode: (file: string) => `${file} manquant`,
    sceneNames: 'un nom par scène',
  },
  frames: {
    method: 'Méthode non autorisée',
  },
  server: {
    starting: 'Cadence démarre\u2026',
    portInUse: (port: number) => `Le port ${port} est déjà utilisé : arrêtez l'autre programme ou choisissez un autre port.`,
    stopChats: (error: string) => `[cadence] arrêt des conversations : ${error}`,
    stopBrandBuilds: (error: string) => `[cadence] arrêt des marques en construction : ${error}`,
    closeChromium: (error: string) => `[cadence] fermeture de Chromium : ${error}`,
    closeVite: (error: string) => `[cadence] fermeture de Vite : ${error}`,
    projects: 'Projets',
    agentUnavailable: (detail: string) => `indisponible \u2014 ${detail}`,
    mcpHint: "(npm run cadence -- mcp pour l'ajouter à Claude Code)",
  },
};
