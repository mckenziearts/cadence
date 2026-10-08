export default {
  title: 'Réglages',
  subtitle: 'La langue de Cadence, puis le modèle et l’effort proposés par défaut dans chaque type de conversation.',
  saved: 'Réglages enregistrés',
  language: 'Langue',
  languageHint: (agent: string | null) =>
    `Celle de l’interface, des messages de Cadence et des réponses de ${agent ?? 'notre IA'}.`,
  sceneChats: 'Conversations de scène',
  sceneChatsHint: 'Retouches précises d’une scène : rapides et fréquentes.',
  projectChat: 'Conversation du projet',
  projectChatHint: 'Structure, nouvelles scènes, cohérence : plus de réflexion.',
  modelOf: (chat: string) => `Modèle (${chat})`,
  effortOf: (chat: string) => `Effort (${chat})`,
  agent: 'Agent',
  agentReady: (name: string | null) => (name ? `${name} est prêt` : 'Notre IA est prête'),
  agentDown: (name: string | null) => `${name ?? 'Notre IA'} est indisponible`,
  agentHint:
    'Les conversations utilisent la session Claude Code de cet ordinateur : le coût affiché est un équivalent API, compté sur votre abonnement.',
  modelHint: (model: string, hint: string) => `${model} : ${hint.charAt(0).toLowerCase() + hint.slice(1)}.`,
  noEffort: 'Ce modèle ne règle pas l’effort.',
};
