import type { SeamResult } from '../../../src/shared/types';

export default {
  internalError: (error: string) => `Erreur interne : ${error}`,
  chat: {
    invalidKey: (key: string) => `Chat invalide : ${key}`,
    empty: 'Le message est vide.',
    invalidModel: (model: string) => `Modèle invalide : ${model}`,
    invalidEffort: (effort: string) => `Niveau d’effort invalide : ${effort}`,
    stopping: 'Cadence est en train de s’arrêter.',
    busy: 'Claude travaille encore sur le message précédent de ce chat.',
    sceneNotFound: (sceneId: string) => `Scène introuvable : ${sceneId}`,
    stopFirst: 'Arrêtez d’abord la réponse en cours.',
    projectNotFound: (projectId: string) => `Projet introuvable : ${projectId}`,
    interrupted: 'Réponse interrompue : Cadence a été arrêté pendant qu’elle s’écrivait.',
    sceneGone: (sceneId: string) => `La scène « ${sceneId} » n’existe plus.`,
    outsideChanges: 'Modifications hors chat',
    failed: 'Claude Code s’est arrêté sur une erreur.',
    seam: (r: SeamResult) =>
      `${r.from} \u2192 ${r.to} (${r.format}) : ${r.diffPercent.toFixed(2).replace('.', ',')} %${r.error ? ` (erreur : ${r.error})` : ''}`,
    notSaved: '[cadence] Chat non enregistré :',
    turnFailed: '[cadence] Tour de chat en échec :',
    wrapUpFailed: (projectId: string, key: string) => `[cadence] Fin du tour (${projectId}, ${key}) :`,
    activity: {
      file: 'un fichier',
      scene: 'la scène',
      video: 'la vidéo',
      page: 'la page',
      read: (file: string) => `Lecture de ${file}`,
      edit: (file: string) => `Modification de ${file}`,
      glob: (pattern: string) => `Recherche de fichiers (${pattern})`,
      grep: (pattern: string) => `Recherche de « ${pattern} »`,
      render: (count: number, of: string | null, format: string | null) =>
        `Rendu ${count === 1 ? 'd’une image' : `de ${count} images`}${of === null ? '' : ` de ${of}`}${format === null ? '' : ` (${format})`}`,
      seams: 'Vérification des raccords',
      project: 'Lecture de la structure du projet',
      brand: 'Lecture de la marque',
      music: 'Lecture de la grille musicale',
      templates: 'Liste des modèles',
      duration: (duration: string) => `Durée réglée à ${duration}`,
      version: (label: string) => `Version « ${label} »`,
      newScene: (name: string) => `Nouvelle scène « ${name} »`,
      duplicate: (scene: string) => `Duplication de ${scene}`,
      remove: (scene: string) => `Suppression de ${scene}`,
      move: (scene: string, position: string) => `Déplacement de ${scene} en position ${position}`,
      rename: (scene: string, name: string) => `Renommage de ${scene} en « ${name} »`,
      grids: { beat: 'les temps', bar: 'les mesures', phrase: 'les phrases' } as Record<string, string | undefined>,
      grid: 'la grille',
      snap: (grid: string) => `Coupes calées sur ${grid}`,
      capture: (url: string) => `Capture de ${url}`,
    },
  },
  claudeCode: {
    notLoggedIn:
      'Claude Code n’est pas connecté à votre compte Claude : ouvrez un terminal, lancez « claude » puis /login, et réessayez.',
    exitCode: (code: number) => `code de sortie ${code}`,
    notFound: (bin: string, error: string) =>
      `Claude Code est introuvable (« ${bin} ») : installez-le et connectez-vous, ou réglez CLAUDE_PATH. (${error})`,
    loggedIn: (how: string) => `Connecté (${how})`,
    spawnFailed: (bin: string, error: string) =>
      `Impossible de lancer Claude Code (« ${bin} ») : ${error}. Installez Claude Code ou réglez CLAUDE_PATH.`,
    stopped: 'Arrêté.',
    crashed: (code: number | null, tail: string) =>
      `Claude Code s’est arrêté de façon inattendue${code === null ? '' : ` (code ${code})`}${tail ? ` :\n${tail}` : '.'}`,
    returnedError: (kind: string, text: string) =>
      text ? `Claude Code a renvoyé une erreur${kind} : ${text}` : `Claude Code a renvoyé une erreur${kind}.`,
  },
  mcpServer: {
    method: 'Méthode non autorisée : le MCP de Cadence n’accepte que POST.',
    browser: 'Requête refusée : le MCP de Cadence n’accepte pas les appels venant d’un navigateur.',
    token: 'Jeton MCP absent, invalide ou expiré.',
    tooLarge: 'Requête trop volumineuse.',
    badJson: 'Corps JSON invalide.',
    internalError: (error: string) => `Erreur interne du MCP : ${error}`,
  },
  mcpTools: {
    noScene: (sceneId: string, projectId: string, scenes: string[]) =>
      `Aucune scène « ${sceneId} » dans ${projectId}. Scènes : ${scenes.join(', ') || 'aucune'}.`,
    otherProject: (projectId: string) => `Ce chat ne peut agir que sur le projet « ${projectId} ».`,
    projectIdNeeded: (projects: string[]) =>
      `Précise projectId (le nom du dossier dans projects/). Projets : ${projects.join(', ') || 'aucun'}.`,
    otherScene: (sceneId: string, denied: string) => `Ce chat est limité à la scène « ${sceneId} » : ${denied}`,
    sceneIdNeeded: (scenes: string[]) => `Précise sceneId. Scènes : ${scenes.join(', ') || 'aucune'}.`,
    sceneOrVideo: 'Choisis sceneId ou wholeVideo, pas les deux.',
    renderOwnScene: 'rends ta scène, ou toute la vidéo avec wholeVideo: true.',
    checkOwnSeams: 'vérifie les raccords de ta scène.',
    setOwnDuration: 'change la durée de ta scène ; le chat du projet règle les autres.',
    badUrl: (url: string) => `Adresse invalide : ${url} (seules les adresses http(s) peuvent être capturées).`,
  },
  mcpTokens: {
    listenerFailed: '[cadence] Échec d’un abonné à l’activité MCP :',
  },
};
