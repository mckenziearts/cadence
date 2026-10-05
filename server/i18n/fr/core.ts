export default {
  http: {
    host: 'Hôte non autorisé',
    badRequest: 'Requête invalide',
    crossSite: 'Requête inter-sites refusée',
    token: 'Jeton Cadence manquant ou invalide',
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
  },
  usage: {
    notSaved: '[cadence] Consommation non enregistrée :',
  },
  editorRootDev: "editorRoot et dev ne vont pas ensemble : le mode dev sert uniquement l'éditeur de Cadence.",
  windows: 'Cadence tourne sous macOS et Linux. Sous Windows, lancez-le dans WSL 2.',
};
