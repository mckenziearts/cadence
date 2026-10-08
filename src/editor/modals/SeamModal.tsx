import clsx from 'clsx';
import { RefreshCw, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { chatKeyForScene, type FormatId, type SeamResult } from '../../shared/types';
import { api, ignore } from '../api';
import { Button, Modal, Spinner } from '../components/ui';
import { useT } from '../i18n';
import { percent, relative, seamTone } from '../lib/format';
import { useStore } from '../store';
import { prefill } from '../store/chat';
import { checkSeams } from '../store/project';
import { closeModal } from '../store/ui';
import { useAgentName } from '../components/agents';

type Detail = { result: SeamResult; fromUrl: string; toUrl: string; diffUrl: string };

export function SeamModal({ from, to, format }: { from: string; to: string; format: FormatId }) {
  const t = useT();
  const agent = useAgentName();
  const project = useStore((s) => s.project)!;
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [nonce, setNonce] = useState(0);
  const fromScene = project.scenes.find((s) => s.id === from);
  const toScene = project.scenes.find((s) => s.id === to);

  useEffect(() => {
    let live = true;
    setDetail(null);
    setError(null);
    api
      .seamDetail(project.id, from, to, format)
      .then((d) => live && setDetail(d))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [project.id, from, to, format, nonce]);

  const recheck = async () => {
    setChecking(true);
    await checkSeams({ sceneId: from, format }).catch(ignore);
    setChecking(false);
    setNonce((n) => n + 1);
  };

  const ask = () => {
    if (!toScene || !detail) return;
    closeModal();
    prefill(
      chatKeyForScene(toScene.id),
      t.timeline.seamModal.prompt(fromScene?.name ?? from, percent(detail.result.diffPercent), format),
    );
  };

  const value = detail?.result.diffPercent ?? 0;
  const tone = seamTone(detail?.result);
  const clean = tone === 'clean';
  return (
    <Modal
      title={t.timeline.seamModal.title(fromScene?.name ?? from, toScene?.name ?? to)}
      subtitle={t.timeline.seamModal.subtitle(fromScene?.name ?? from, toScene?.name ?? to, format)}
      onClose={closeModal}
      width="max-w-5xl"
      footer={
        <>
          <p className="mr-auto text-xs text-ink-3">
            {detail ? t.timeline.seamModal.checked(relative(detail.result.checkedAt)) : ''}
          </p>
          <Button variant="secondary" icon={<RefreshCw className="size-3.5" />} loading={checking} onClick={() => void recheck()}>
            {t.timeline.seamModal.recheck}
          </Button>
          {(tone === 'jump' || tone === 'cut') && (
            <Button variant="primary" icon={<Sparkles className="size-3.5" />} onClick={ask}>
              {t.timeline.seamModal.askAgent(agent)}
            </Button>
          )}
        </>
      }
    >
      {error ? (
        <p className="py-10 text-center text-[13px] text-alert">{error}</p>
      ) : !detail ? (
        <div className="flex h-64 flex-col items-center justify-center gap-2 text-[13px] text-ink-3">
          <Spinner className="size-5" />
          {t.timeline.seamModal.capturing}
        </div>
      ) : (
        <div className="space-y-4">
          <div
            className={clsx(
              'flex items-center gap-3 rounded-xl px-4 py-3 ring-1',
              clean ? 'bg-ok/8 ring-ok/30' : 'bg-warn/8 ring-warn/30',
            )}
          >
            <span className={clsx('font-mono text-xl font-semibold tabular-nums', clean ? 'text-ok' : 'text-warn-ink')}>
              {percent(value)}
            </span>
            <p className="text-[13px] text-ink-2">
              {detail.result.error
                ? t.timeline.seams.checkFailed(detail.result.error)
                : clean
                  ? t.timeline.seamModal.invisible
                  : t.timeline.seamModal.visible}
            </p>
          </div>
          <div className="grid grid-cols-3 gap-3">
            {(
              [
                [detail.fromUrl, t.timeline.seamModal.end(fromScene?.name ?? from)],
                [detail.toUrl, t.timeline.seamModal.start(toScene?.name ?? to)],
                [detail.diffUrl, t.timeline.seamModal.difference],
              ] as const
            ).map(([src, label]) => (
              <figure key={label} className="min-w-0">
                <img src={src} alt={label} className="w-full rounded-lg bg-wash ring-1 ring-black/10" />
                <figcaption className="mt-1.5 truncate text-xs text-ink-3">{label}</figcaption>
              </figure>
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
}
