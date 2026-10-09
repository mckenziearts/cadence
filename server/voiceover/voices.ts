// The Piper voices Cadence offers: single-speaker French and English voices, with the license of their dataset (from
// each voice's MODEL_CARD). Files come from the commit of the v1.0.0 tag of rhasspy/piper-voices, so their md5 never
// changes: pinned by commit rather than by tag name, since a tag can be moved and a commit cannot.
import type { VoiceOverSettings } from '../../src/shared/types';
import { PIPER_DEFAULT_VOICE } from '../../src/shared/voiceOver';

export const VOICES_REVISION = '375a0fe641dea077c2a47b4e9a056d6da521eed3';

export interface VoiceSpec {
  id: string;
  name: string;
  license: string;
  commercial: boolean;
  credit: boolean;
  /** Folder of the voice in rhasspy/piper-voices. */
  path: string;
  /** .onnx + .onnx.json, in bytes. */
  size: number;
  md5: { onnx: string; json: string };
}

export const VOICES: VoiceSpec[] = [
  {
    id: 'fr_FR-siwis-medium',
    name: 'Siwis',
    license: 'CC-BY 4.0',
    commercial: true,
    credit: true,
    path: 'fr/fr_FR/siwis/medium',
    size: 63206169,
    md5: { onnx: '20e876e8c839e9b11a26085858f2300c', json: 'a407e7e6901feb79c2ea2a5466076cce' },
  },
  {
    id: 'fr_FR-gilles-low',
    name: 'Gilles',
    license: 'CC0',
    commercial: true,
    credit: false,
    path: 'fr/fr_FR/gilles/low',
    size: 63108684,
    md5: { onnx: 'f984386d1f0927597f09a3ec10b11b5d', json: '38b1775fef8b9de50f15f63c5d8b8643' },
  },
  {
    id: 'fr_FR-mls_1840-low',
    name: 'MLS 1840',
    license: 'CC-BY 4.0',
    commercial: true,
    credit: true,
    path: 'fr/fr_FR/mls_1840/low',
    size: 63108686,
    md5: { onnx: '1873b5d95cb0aad9909d32d1747ae72b', json: 'eb0a76447f47f9114f832b1a0da9a8b3' },
  },
  {
    id: 'en_US-joe-medium',
    name: 'Joe',
    license: 'CC0',
    commercial: true,
    credit: false,
    path: 'en/en_US/joe/medium',
    size: 63206088,
    md5: { onnx: '74fd6a4dc39e0aa9dce145d7f5acd4f6', json: '811036b9c1451545f9495fdc1baa0754' },
  },
  {
    id: 'en_US-kristin-medium',
    name: 'Kristin',
    license: 'Public domain',
    commercial: true,
    credit: false,
    path: 'en/en_US/kristin/medium',
    size: 63536347,
    md5: { onnx: '5fed42d2296baca042e2bf74785db725', json: '70bc97d350c796c64ea5e4d08241afac' },
  },
  {
    id: 'en_US-ljspeech-high',
    name: 'LJSpeech',
    license: 'Public domain',
    commercial: true,
    credit: false,
    path: 'en/en_US/ljspeech/high',
    size: 114203981,
    md5: { onnx: 'dad093b5d2cff6a5fda99883ceda09d1', json: 'de98fc398ddead60fb82d93bfafb3ad1' },
  },
  {
    id: 'en_US-norman-medium',
    name: 'Norman',
    license: 'Public domain',
    commercial: true,
    credit: false,
    path: 'en/en_US/norman/medium',
    size: 63536347,
    md5: { onnx: '829cea515dc724d694b83b71e8083f9f', json: '975830d6f230f6eccf657d265de99eba' },
  },
  {
    id: 'en_GB-cori-medium',
    name: 'Cori',
    license: 'Public domain',
    commercial: true,
    credit: false,
    path: 'en/en_GB/cori/medium',
    size: 63536345,
    md5: { onnx: 'f143307611eccea9d976235d0895f57c', json: '12b1dc45d8919f3475cf296d5f16a4c6' },
  },
  {
    id: 'en_GB-alba-medium',
    name: 'Alba',
    license: 'CC-BY 4.0',
    commercial: true,
    credit: true,
    path: 'en/en_GB/alba/medium',
    size: 63206182,
    md5: { onnx: 'c07f313752bb3aba8061041666251654', json: 'dbb6f2ede31082710665221417906e13' },
  },
  {
    id: 'en_US-lessac-medium',
    name: 'Lessac',
    license: 'Blizzard 2013 (research)',
    commercial: false,
    credit: false,
    path: 'en/en_US/lessac/medium',
    size: 63206179,
    md5: { onnx: '2fc642b535197b6305c7c8f92dc8b24f', json: 'c1f2b7bddefe113f3255ff9ef234cfd3' },
  },
  {
    id: 'en_US-ryan-medium',
    name: 'Ryan',
    license: 'CC BY-NC-SA 4.0',
    commercial: false,
    credit: false,
    path: 'en/en_US/ryan/medium',
    size: 63206177,
    md5: { onnx: '8f06d3aff8ded5a7f13f907e6bec32ac', json: 'f173a2b5202b3e4128ccc3ed8195306c' },
  },
];

/** The voice-over settings of a project until someone picks a voice, by on-screen language. */
export function defaultVoiceOver(language: 'fr' | 'en'): VoiceOverSettings {
  return { voice: PIPER_DEFAULT_VOICE[language], speed: 1, musicLevel: 0.3 };
}

export function voiceSpec(id: string): VoiceSpec | undefined {
  return VOICES.find((v) => v.id === id);
}

/** `fr_FR-siwis-medium` -> { locale: 'fr_FR', language: 'fr', quality: 'medium' } */
export function voiceParts(id: string): { locale: string; language: 'fr' | 'en'; quality: 'low' | 'medium' | 'high' } {
  const [locale, , quality] = id.split('-');
  return { locale, language: locale.startsWith('fr') ? 'fr' : 'en', quality: quality as 'low' | 'medium' | 'high' };
}

export function voiceUrl(spec: VoiceSpec, ext: '.onnx' | '.onnx.json'): string {
  return `https://huggingface.co/rhasspy/piper-voices/resolve/${VOICES_REVISION}/${spec.path}/${spec.id}${ext}`;
}
