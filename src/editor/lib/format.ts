// Display helpers in the interface language. French uses a decimal comma and a no-break space before units
// (« 12,5 % », « 0,48 $ »); English a decimal point ("12.5%", "$0.48").
import type { Language, SeamResult } from '../../shared/types';

export const NBSP = '\u00a0';

let language: Language = 'fr';

/** Set by the editor from the interface language (kept out of the store: Node tests import this file). */
export function setFormatLanguage(next: Language): void {
  language = next;
}

const fr = () => language === 'fr';
const decimal = (value: number, digits: number) => {
  const text = value.toFixed(digits).replace(/^-/, '−');
  return fr() ? text.replace('.', ',') : text;
};
/** "1,50" gives "1,5" and "2,00" gives "2" (the same with a point). */
const trim = (text: string) => (/[.,]/.test(text) ? text.replace(/0+$/, '').replace(/[.,]$/, '') : text);
const unit = (value: string, symbol: string) => (fr() ? `${value}${NBSP}${symbol}` : `${value}${symbol}`);

/** Seconds without unit: 2.2222 gives "2,22". */
export function secs(t: number, digits = 2): string {
  return decimal(Math.max(0, t), digits);
}

/** Seconds with unit: "3,32 s". */
export function secsLabel(t: number, digits = 2): string {
  return `${secs(t, digits)}${NBSP}s`;
}

/** Cost in dollars: "0,48 $" ("< 0,01 $" for a non-zero amount that would round to zero); "$0.48" in English. */
export function usd(value: number): string {
  const amount = value > 0 && value < 0.005 ? decimal(0.01, 2) : decimal(value, 2);
  const money = fr() ? `${amount}${NBSP}$` : `$${amount}`;
  return value > 0 && value < 0.005 ? `<${NBSP}${money}` : money;
}

/** Share of pixels that differ at a cut: "0 %", "0,12 %", "12,5 %". */
export function percent(value: number): string {
  if (value < 0.005) return unit('0', '%');
  return unit(trim(decimal(value, value < 10 ? 2 : 1)), '%');
}

/** Compact share, for tight spots: "0 %", "0,12 %", "2,8 %", "34 %". */
export function percentShort(value: number): string {
  if (value < 0.005) return unit('0', '%');
  return unit(trim(decimal(value, value < 1 ? 2 : value < 10 ? 1 : 0)), '%');
}

/** Share inside a seam badge, which draws its own % sign: "0", "0,1", "2,8", "34". The tooltip keeps the exact value. */
export function seamShare(value: number): string {
  return trim(decimal(value, value < 10 ? 1 : 0));
}

/** Bars: "2 mes.", "1,5 mes."; "1 bar", "1.5 bars". */
export function bars(n: number): string {
  const rounded = Math.round(n * 10) / 10;
  const value = trim(decimal(rounded, 1));
  return fr() ? `${value}${NBSP}mes.` : `${value}${NBSP}${rounded === 1 ? 'bar' : 'bars'}`;
}

/** File sizes: "820 o", "350 ko", "1,2 Mo"; "820 B", "350 KB", "1.2 MB". */
export function bytes(n: number): string {
  const [b, kb, mb, gb] = fr() ? ['o', 'ko', 'Mo', 'Go'] : ['B', 'KB', 'MB', 'GB'];
  if (n < 1024) return `${n}${NBSP}${b}`;
  if (n < 1024 ** 2) return `${Math.round(n / 1024)}${NBSP}${kb}`;
  if (n < 1024 ** 3) return `${trim(decimal(n / 1024 ** 2, 1))}${NBSP}${mb}`;
  return `${trim(decimal(n / 1024 ** 3, 2))}${NBSP}${gb}`;
}

/** Token counts: "820", "87 k", "4,6 M"; "820", "87K", "4.6M". */
export function tokenCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 999_500) return unit(String(Math.round(n / 1000)), fr() ? 'k' : 'K');
  return unit(trim(decimal(n / 1e6, 1)), 'M');
}

/** Length of an agent turn: "14 s", "1 min 05 s". */
export function elapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}${NBSP}s`;
  return `${Math.floor(total / 60)}${NBSP}min ${String(total % 60).padStart(2, '0')}${NBSP}s`;
}

const DATES = {
  fr: {
    day: new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' }),
    time: new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' }),
    now: 'à l’instant',
    minutes: (n: number) => `il y a ${n}${NBSP}min`,
    hours: (n: number) => `il y a ${n}${NBSP}h`,
    today: 'aujourd’hui',
    yesterday: 'hier',
  },
  en: {
    day: new Intl.DateTimeFormat('en-US', { day: 'numeric', month: 'short' }),
    time: new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }),
    now: 'just now',
    minutes: (n: number) => `${n}${NBSP}min ago`,
    hours: (n: number) => `${n}${NBSP}h ago`,
    today: 'today',
    yesterday: 'yesterday',
  },
};

/** "1 oct."; "Oct 1". */
export function day(iso: string): string {
  return DATES[language].day.format(new Date(iso));
}

/** "à l’instant", "il y a 5 min", "il y a 3 h", "hier, 14:05", "12 sept., 14:05"; "just now", "5 min ago", "yesterday, 2:05 PM". */
export function relative(iso: string, now = Date.now()): string {
  const words = DATES[language];
  const date = new Date(iso);
  const diff = (now - date.getTime()) / 1000;
  if (!Number.isFinite(diff)) return '';
  if (diff < 45) return words.now;
  if (diff < 3600) return words.minutes(Math.max(1, Math.round(diff / 60)));
  if (diff < 6 * 3600) return words.hours(Math.round(diff / 3600));
  const today = new Date(now);
  const yesterday = new Date(now - 86_400_000);
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (sameDay(date, today)) return `${words.today}, ${words.time.format(date)}`;
  if (sameDay(date, yesterday)) return `${words.yesterday}, ${words.time.format(date)}`;
  return `${words.day.format(date)}, ${words.time.format(date)}`;
}

/** Parse a French or English decimal typed by the user ("2,5", "2.5 s"); NaN when it is not a number. */
export function parseDecimal(text: string): number {
  const cleaned = text.trim().replace(/\s|s$/gi, '').replace(',', '.').replace('−', '-');
  return cleaned === '' ? Number.NaN : Number(cleaned);
}

/** A scene length typed in seconds ("2,5", "2.5 s") or in bars of `barLength` seconds ("2 mes.", "1,5 mesure", "2 bars"). */
export function parseDuration(text: string, barLength: number): number {
  const inBars = /^\s*([\d.,]+)\s*(?:mes(?:\.|ures?)?|bars?)\s*$/i.exec(text);
  return inBars ? parseDecimal(inBars[1]) * barLength : parseDecimal(text);
}

/** Badge tone of a checked cut: invisible below 0,05 % of pixels, a visible jump up to 5 %, a hard cut beyond. */
export function seamTone(result: SeamResult | undefined): 'unknown' | 'error' | 'clean' | 'jump' | 'cut' {
  if (!result) return 'unknown';
  if (result.error) return 'error';
  return result.diffPercent < 0.05 ? 'clean' : result.diffPercent < 5 ? 'jump' : 'cut';
}

/** "1 scène", "3 scènes". */
export function plural(n: number, one: string, many: string): string {
  return `${n}${NBSP}${n === 1 ? one : many}`;
}
