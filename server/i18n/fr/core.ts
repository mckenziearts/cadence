export default {
  http: {
    host: 'Hôte non autorisé',
    badRequest: 'Requête invalide',
    crossSite: 'Requête inter-sites refusée',
    token: 'Jeton Cadence manquant ou invalide',
    secret: 'Secret de requête manquant ou invalide',
    origin: 'Origine refusée',
    mcpToken: 'Jeton MCP manquant ou invalide',
    mcpError: (error: string) => `Erreur MCP : ${error}`,
    mcpLog: '[cadence] erreur MCP :',
    notFound: 'Introuvable',
    editorUnavailable: (error: string) => `Éditeur indisponible : ${error}`,
  },
  settings: {
    model: (value: unknown) => `Modèle invalide : ${value}`,
    effort: (value: unknown) => `Niveau d'effort invalide : ${value}`,
    language: (value: unknown) => `Langue invalide : ${value}`,
    agent: (value: unknown) => `Assistant invalide : ${value}`,
    defaultVoice: 'Voix par défaut invalide : une voix et un modèle ElevenLabs sont attendus',
  },
  usage: {
    notSaved: '[cadence] Consommation non enregistrée :',
  },
  hostApi: {
    name: (name: string) =>
      `Nom de routes hôte invalide : « ${name} » (lettres minuscules, chiffres et tirets, en commençant par une lettre).`,
    taken: (name: string) => `Le nom de routes hôte « ${name} » est déjà pris par une route de Cadence (/api/${name}).`,
  },
  hostBrandSources: {
    name: (key: string) =>
      `Clé de source de marque hôte invalide : « ${key} » (lettres minuscules, chiffres et tirets, en commençant par une lettre).`,
    taken: (key: string) => `La clé de source de marque hôte « ${key} » est réservée à un hébergeur Git de Cadence.`,
  },
  requestSecret: 'Le secret de requête doit compter au moins 32 caractères.',
  editorRootDev: "editorRoot et dev ne vont pas ensemble : le mode dev sert uniquement l'éditeur de Cadence.",
  windows: 'Cadence tourne sous macOS et Linux. Sous Windows, lancez-le dans WSL 2.',
};
