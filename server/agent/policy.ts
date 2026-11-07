import type { FilePolicy } from '../contracts';

/** Below a project. What a host keeps of a session: a whole conversation, so it neither travels nor reaches a file tool. */
export const SESSION_FOLDER = '.cadence/chats/sessions';

/** The file part of a turn's Claude Code rules. `//` marks an absolute path in them. */
export function claudeRules(files: FilePolicy): { allow: string[]; deny: string[] } {
  const rule = (tool: string, file: string) => `${tool}(//${file.replace(/^\/+/, '')})`;
  return {
    allow: [
      ...files.read.map((file) => rule('Read', file)),
      'Glob',
      'Grep',
      ...files.write.flatMap((file) => [rule('Edit', file), rule('Write', file)]),
    ],
    deny: files.deny.map((file) => rule('Read', file)),
  };
}
