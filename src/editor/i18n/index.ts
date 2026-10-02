// The editor's texts in the interface language: components read them with useT(), code outside React with t().
import type { Language } from '../../shared/types';
import { setFormatLanguage } from '../lib/format';
import { get, useStore } from '../store';
import en from './en';
import fr from './fr';

export type Messages = typeof fr;

const MESSAGES: Record<Language, Messages> = { fr, en };

export function useT(): Messages {
  return MESSAGES[useStore((s) => s.language)];
}

/** Outside components (actions, toasts). Call it where the text is made, never at import: the language can change. */
export function t(): Messages {
  return MESSAGES[get().language];
}

/** The browser's language, for a person who has not chosen one yet. */
export function browserLanguage(): Language {
  return /^fr\b/i.test(navigator.language) ? 'fr' : 'en';
}

setFormatLanguage(get().language);
useStore.subscribe((s, prev) => {
  if (s.language === prev.language) return;
  setFormatLanguage(s.language);
  document.documentElement.lang = s.language;
});
