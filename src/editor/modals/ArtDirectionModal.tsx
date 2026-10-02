import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { Button, Kbd, Modal, Spinner } from '../components/ui';
import { useT } from '../i18n';
import { set, useStore } from '../store';
import { closeModal, toast } from '../store/ui';

export function ArtDirectionModal() {
  const t = useT();
  const language = useStore((s) => s.language);
  const project = useStore((s) => s.project)!;
  const draft = useStore((s) => s.artDrafts[project.id]);
  const [saved, setSaved] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const text = draft ?? saved ?? '';
  const dirty = draft !== undefined && draft !== saved;

  useEffect(() => {
    let live = true;
    api
      .artDirection(project.id)
      .then(({ text }) => live && setSaved(text))
      .catch(() => live && setSaved(''));
    return () => {
      live = false;
    };
  }, [project.id]);

  const setDraft = (value: string | undefined) =>
    set((s) => {
      const next = { ...s.artDrafts };
      if (value === undefined) delete next[project.id];
      else next[project.id] = value;
      return { artDrafts: next };
    });

  const save = async () => {
    setSaving(true);
    try {
      await api.saveArtDirection(project.id, text);
      setSaved(text);
      setDraft(undefined);
      toast(t.dialogs.artDirection.saved, 'success');
      closeModal();
    } catch {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={t.dialogs.artDirection.title}
      subtitle={t.dialogs.artDirection.subtitle}
      onClose={closeModal}
      width="max-w-3xl"
      bodyClassName="p-0"
      initialFocus={area}
      footer={
        <>
          <p className="mr-auto text-xs text-ink-3">
            {dirty
              ? t.dialogs.artDirection.unsaved
              : t.dialogs.artDirection.hint(
                  <>
                    <Kbd>⌘</Kbd> <Kbd>S</Kbd>
                  </>,
                )}
          </p>
          {dirty && (
            <Button variant="ghost" onClick={() => setDraft(undefined)}>
              {t.dialogs.artDirection.discard}
            </Button>
          )}
          <Button variant="primary" loading={saving} disabled={saved === null || !dirty} onClick={() => void save()}>
            {t.common.save}
          </Button>
        </>
      }
    >
      {saved === null ? (
        <div className="grid h-[60vh] place-items-center">
          <Spinner />
        </div>
      ) : (
        <textarea
          ref={area}
          value={text}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
              e.preventDefault();
              if (dirty) void save();
            }
          }}
          spellCheck
          lang={language}
          aria-label={t.dialogs.artDirection.label}
          className="block h-[62vh] w-full resize-none bg-white px-6 py-5 font-mono text-[13px] leading-[1.7] text-ink-2 outline-none"
        />
      )}
    </Modal>
  );
}
