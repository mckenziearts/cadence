import { CircleCheck, CircleAlert } from 'lucide-react';
import { useState } from 'react';
import { DEFAULT_FEATURES, EFFORTS, type Effort, type Settings } from '../../shared/types';
import { api } from '../api';
import { Button, Modal, Segmented, Select, SectionTitle } from '../components/ui';
import { useT } from '../i18n';
import { set, useStore, NONE } from '../store';
import { resolvePick } from '../store/chat';
import { closeModal, toast } from '../store/ui';

/** Each language under its own name, whatever the interface language. */
const LANGUAGE_NAMES = { fr: 'Français', en: 'English' } as const;

export function SettingsModal() {
  const t = useT();
  const app = useStore((s) => s.app)!;
  const language = useStore((s) => s.language);
  const { modelPicker, costs } = useStore((s) => s.app?.features ?? DEFAULT_FEATURES);
  // Claude Code's hint is about the cost shown: with the costs hidden it goes too.
  const agentHint = app.agent.detail ?? (costs ? t.settings.agentHint : undefined);
  // The scene/project defaults shown are the active agent's; saving routes them back to that agent.
  const seed = (): Settings => {
    const scene = resolvePick(app.settings, app.models, 'scene');
    const project = resolvePick(app.settings, app.models, 'project');
    return {
      ...app.settings,
      language,
      sceneModel: scene.model,
      sceneEffort: scene.effort,
      projectModel: project.model,
      projectEffort: project.effort,
    };
  };
  const [draft, setDraft] = useState<Settings>(seed);
  const [saving, setSaving] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(seed());

  const save = async () => {
    setSaving(true);
    try {
      const settings = await api.saveSettings(draft);
      // Every text on the page, the server's too, comes back in the new language.
      if (settings.language !== language) return location.reload();
      // New defaults apply to the composers too (their session picks are dropped).
      set((s) => ({ app: s.app && { ...s.app, settings }, picks: {} }));
      toast(t.settings.saved, 'success');
      closeModal();
    } catch {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={t.settings.title}
      subtitle={modelPicker ? t.settings.subtitle : undefined}
      onClose={closeModal}
      width="max-w-xl"
      footer={
        <>
          <span className="mr-auto" />
          <Button variant="ghost" onClick={closeModal}>
            {t.common.cancel}
          </Button>
          <Button variant="primary" loading={saving} disabled={!dirty} onClick={() => void save()}>
            {t.common.save}
          </Button>
        </>
      }
    >
      <div className="space-y-6">
        <section className="space-y-2">
          <SectionTitle>{t.settings.language}</SectionTitle>
          <p className="-mt-1 text-xs text-ink-3">{t.settings.languageHint}</p>
          <Segmented
            label={t.settings.language}
            size="sm"
            value={draft.language ?? language}
            onChange={(next) => setDraft({ ...draft, language: next })}
            options={(['fr', 'en'] as const).map((value) => ({ value, label: LANGUAGE_NAMES[value] }))}
          />
        </section>
        {modelPicker && (
          <>
            <ChatDefaults
              title={t.settings.sceneChats}
              hint={t.settings.sceneChatsHint}
              model={draft.sceneModel}
              effort={draft.sceneEffort}
              onChange={(model, effort) => setDraft({ ...draft, sceneModel: model, sceneEffort: effort })}
            />
            <ChatDefaults
              title={t.settings.projectChat}
              hint={t.settings.projectChatHint}
              model={draft.projectModel}
              effort={draft.projectEffort}
              onChange={(model, effort) => setDraft({ ...draft, projectModel: model, projectEffort: effort })}
            />
          </>
        )}
        <section className="space-y-2">
          <SectionTitle>{t.settings.agent}</SectionTitle>
          <div className="flex items-start gap-2.5 rounded-xl bg-wash px-3.5 py-3 ring-1 ring-rule">
            {app.agent.ok ? (
              <CircleCheck className="mt-0.5 size-4 shrink-0 text-ok" />
            ) : (
              <CircleAlert className="mt-0.5 size-4 shrink-0 text-warn" />
            )}
            <div className="min-w-0 text-[13px]">
              <p className="font-medium text-ink">
                {(app.agent.ok ? t.settings.agentReady : t.settings.agentDown)(
                  app.agent.version ? `${app.agent.label} ${app.agent.version}` : app.agent.label,
                )}
              </p>
              {agentHint && <p className="mt-0.5 text-xs leading-relaxed text-ink-3">{agentHint}</p>}
            </div>
          </div>
        </section>
      </div>
    </Modal>
  );
}

function ChatDefaults(props: {
  title: string;
  hint: string;
  model: string;
  effort: Effort;
  onChange: (model: string, effort: Effort) => void;
}) {
  const t = useT();
  const language = useStore((s) => s.language);
  const models = useStore((s) => s.app?.models ?? NONE);
  const spec = models.find((m) => m.id === props.model);
  return (
    <section className="space-y-2">
      <SectionTitle>{props.title}</SectionTitle>
      <p className="-mt-1 text-xs text-ink-3">{props.hint}</p>
      <div className="grid grid-cols-2 gap-2">
        <Select
          aria-label={t.settings.modelOf(props.title)}
          value={props.model}
          onChange={(e) => {
            const next = models.find((m) => m.id === e.target.value);
            props.onChange(e.target.value, next?.defaultEffort ?? next?.efforts?.[0] ?? props.effort);
          }}
          className="w-full"
        >
          {!spec && props.model && <option value={props.model}>{props.model}</option>}
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </Select>
        <Select
          aria-label={t.settings.effortOf(props.title)}
          value={props.effort}
          disabled={spec?.supportsEffort === false}
          onChange={(e) => props.onChange(props.model, e.target.value as Effort)}
          className="w-full"
        >
          {(spec?.efforts ?? EFFORTS).map((e) => (
            <option key={e} value={e}>
              {t.common.efforts[e]}
            </option>
          ))}
        </Select>
      </div>
      {spec && (
        <p className="text-xs text-ink-3">
          {t.settings.modelHint(spec.label, spec.hint[language])}
          {spec.supportsEffort ? '' : ` ${t.settings.noEffort}`}
        </p>
      )}
    </section>
  );
}
