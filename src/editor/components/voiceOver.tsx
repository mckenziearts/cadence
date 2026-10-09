// Voice-over pieces shared by the Voice tab and the Profile: Piper's install command, and the ElevenLabs voice and model
// selects with the voice's preview (a project's voice in the Voice tab, the default of new projects in the Profile).
import clsx from 'clsx';
import { AlertTriangle, Play } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ElevenLabsModel, ElevenLabsVoice as Voice } from '../../shared/types';
import { ApiError, api, ignore } from '../api';
import { useT } from '../i18n';
import { IconButton, inputClass, Spinner } from './ui';

export const PIPER_INSTALL = 'pipx install piper-tts';
const DEFAULT_MODEL = 'eleven_multilingual_v2';

export interface ElevenLabsChoice {
  voice: string;
  model: string;
}

/** The ElevenLabs voices and models of the person's account or of the host app, loaded once mounted and `load` set. */
export function useElevenLabsCatalog(load = true) {
  const [catalog, setCatalog] = useState<{ voices: Voice[]; models: ElevenLabsModel[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!load) return;
    let live = true;
    api.elevenLabs().then(
      (next) => {
        if (!live) return;
        setCatalog(next);
        setError(null);
      },
      (failure: ApiError) => live && setError(failure.message),
    );
    return () => {
      live = false;
    };
  }, [load]);
  return { catalog, error };
}

export type ElevenLabsCatalog = ReturnType<typeof useElevenLabsCatalog>;

/**
 * The person's ElevenLabs voices and models (`catalog`, else loaded once mounted). `none` is the option shown while no
 * voice is set: a prompt, or with `noneSelectable` a choice of its own that sets null.
 */
export function ElevenLabsVoiceSelect(props: {
  value: ElevenLabsChoice | null;
  onChange: (value: ElevenLabsChoice | null) => void;
  label: string;
  none: string;
  noneSelectable?: boolean;
  catalog?: ElevenLabsCatalog;
}) {
  const { value, onChange, label, none, noneSelectable = false } = props;
  const texts = useT().production.voiceOver.elevenLabs;
  const own = useElevenLabsCatalog(!props.catalog);
  const { catalog, error } = props.catalog ?? own;
  // The model picked before a voice is set; once set, the value's.
  const [pickedModel, setPickedModel] = useState<string | null>(null);
  const preview = useRef<HTMLAudioElement | null>(null);
  useEffect(() => () => preview.current?.pause(), []);

  if (error) {
    return (
      <p role="alert" className="flex items-start gap-1.5 text-xs text-alert">
        <AlertTriangle className="mt-px size-3 shrink-0" aria-hidden /> {error}
      </p>
    );
  }
  if (!catalog) {
    return (
      <p className="flex items-center gap-2 text-[13px] text-ink-2">
        <Spinner className="size-3.5" />
        {texts.loading}
      </p>
    );
  }

  const fallback = catalog.models.some((m) => m.id === DEFAULT_MODEL) ? DEFAULT_MODEL : (catalog.models[0]?.id ?? DEFAULT_MODEL);
  const model = value?.model ?? pickedModel ?? fallback;
  const current = value ? catalog.voices.find((v) => v.id === value.voice) : undefined;
  const listen = (url: string) => {
    preview.current?.pause();
    preview.current = new Audio(url);
    void preview.current.play().catch(ignore);
  };

  return (
    <>
      <div className="flex items-center gap-2">
        <select
          aria-label={label}
          value={value?.voice ?? ''}
          onChange={(e) => onChange(e.target.value ? { voice: e.target.value, model } : null)}
          className={clsx(inputClass, 'min-w-0 flex-1 appearance-none')}
        >
          {(!value || noneSelectable) && (
            <option value="" disabled={!noneSelectable}>
              {none}
            </option>
          )}
          {value && !current && <option value={value.voice}>{value.voice}</option>}
          {catalog.voices.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </select>
        {current?.previewUrl && (
          <IconButton
            size="sm"
            label={texts.preview(current.name)}
            icon={<Play className="size-3.5" />}
            onClick={() => listen(current.previewUrl!)}
          />
        )}
      </div>
      <Row label={texts.model}>
        <select
          aria-label={texts.modelLabel}
          value={model}
          onChange={(e) => (value ? onChange({ voice: value.voice, model: e.target.value }) : setPickedModel(e.target.value))}
          className={clsx(inputClass, 'min-w-0 flex-1 appearance-none')}
        >
          {!catalog.models.some((m) => m.id === model) && <option value={model}>{model}</option>}
          {catalog.models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </Row>
    </>
  );
}

export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-7 items-center gap-2">
      <span className="label-caps w-[108px] shrink-0 text-[11px] text-ink-2">{label}</span>
      {children}
    </div>
  );
}
