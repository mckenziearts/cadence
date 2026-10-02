// What the server tells people (API errors, events, the OAuth return page, terminal output) in the interface language.
// Cadence serves one person: one language per process, from the settings (in the CLI, the terminal's before that).
import { LANGUAGES, type Language } from '../../src/shared/types';
import en from './en';
import fr from './fr';

export type Messages = typeof fr;

const MESSAGES: Record<Language, Messages> = { fr, en };
let current: Language = 'fr';

export function setLanguage(language: Language): void {
  current = language;
}

export function language(): Language {
  return current;
}

/** The messages in the current language. Call it where the text is made, never at import: the language can change. */
export function m(): Messages {
  return MESSAGES[current];
}

export function isLanguage(value: unknown): value is Language {
  return LANGUAGES.includes(value as Language);
}

/** The CLI's language: CADENCE_LANGUAGE, else the setting, else the terminal's locale (LC_ALL, LC_MESSAGES, LANG). */
export function cliLanguage(setting: Language | null, env: NodeJS.ProcessEnv = process.env): Language {
  if (isLanguage(env.CADENCE_LANGUAGE)) return env.CADENCE_LANGUAGE;
  if (setting) return setting;
  return /^fr/i.test(env.LC_ALL || env.LC_MESSAGES || env.LANG || '') ? 'fr' : 'en';
}
