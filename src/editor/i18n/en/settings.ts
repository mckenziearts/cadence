import type fr from '../fr/settings';

export default {
  title: 'Settings',
  subtitle: 'The language of Cadence, then the model and effort offered by default in each kind of chat.',
  saved: 'Settings saved',
  language: 'Language',
  languageHint: (agent: string | null) => `For the interface, Cadence messages and the answers of ${agent ?? 'our AI'}.`,
  sceneChats: 'Scene chats',
  sceneChatsHint: 'Precise edits to one scene: quick and frequent.',
  projectChat: 'Project chat',
  projectChatHint: 'Structure, new scenes, consistency: more thinking.',
  modelOf: (chat: string) => `Model (${chat})`,
  effortOf: (chat: string) => `Effort (${chat})`,
  agent: 'Agent',
  agentReady: (name: string | null) => `${name ?? 'Our AI'} is ready`,
  agentDown: (name: string | null) => `${name ?? 'Our AI'} is unavailable`,
  agentHint:
    'Chats use the Claude Code session of this computer: the cost shown is an API equivalent, counted on your subscription.',
  modelHint: (model: string, hint: string) => `${model}: ${hint.charAt(0).toLowerCase() + hint.slice(1)}.`,
  noEffort: 'This model has no effort setting.',
} satisfies typeof fr;
