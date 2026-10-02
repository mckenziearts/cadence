// « Publier » an exported video: the network, then what it asks for (title, text, visibility), then the upload's
// progress and the link. The upload runs on the server: closing the dialog does not stop it, the video's card keeps
// showing it.
import { CircleAlert, CircleCheck, ExternalLink, Send } from 'lucide-react';
import { useState } from 'react';
import type { NetworkAccount, NetworkId, Publication, Visibility } from '../../shared/types';
import { api } from '../api';
import { NETWORK_LOGOS } from '../components/logos';
import { Button, Field, Modal, Segmented, fieldBase, inputClass } from '../components/ui';
import { useT } from '../i18n';
import { relative } from '../lib/format';
import { NONE, set, useStore } from '../store';
import { PROFILE_PAGE } from '../store/project';
import { closeModal } from '../store/ui';

export function PublishModal({ file }: { file: string }) {
  const t = useT();
  const project = useStore((s) => s.project)!;
  const video = useStore((s) => s.renders.files.find((f) => f.name === file));
  const networks = useStore((s) => s.app?.networks ?? NONE);
  const publications = useStore((s) => s.publishing.publications);
  // The first connected network, else the first one: its card says what to do.
  const [networkId, setNetworkId] = useState<NetworkId | null>(null);
  const network = networks.find((n) => n.id === networkId) ?? networks.find((n) => n.account) ?? networks[0];
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useStore((s) => s.publishing.jobs.find((j) => j.id === jobId));
  const [title, setTitle] = useState(project.name);
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<Visibility | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [starting, setStarting] = useState(false);

  if (!network) return null;
  const texts = t[network.id].publish;
  const { fields } = network;
  const chosen = visibility && fields.visibilities.includes(visibility) ? visibility : fields.visibilities[0];
  const forbidden = Boolean(texts.forbidden) && /[<>]/.test(title + description);
  const sending = job?.status === 'uploading';
  const sent = job?.status === 'done' ? job.publication : undefined;
  const earlier = publications.filter((p) => p.file === file && p.network === network.id && p.publishedAt !== sent?.publishedAt);
  const ready =
    Boolean(network.account) &&
    (fields.title === null || Boolean(title.trim())) &&
    (!fields.textRequired || Boolean(description.trim())) &&
    !forbidden;

  const publish = async () => {
    setStarting(true);
    try {
      const started = await api.publish(project.id, {
        file,
        network: network.id,
        title: fields.title === null ? '' : title.trim(),
        description: fields.text === null ? '' : description,
        visibility: chosen,
      });
      // Its events may have come first: keep what they said.
      set((s) => ({
        publishing: {
          ...s.publishing,
          jobs: s.publishing.jobs.some((j) => j.id === started.id) ? s.publishing.jobs : [started, ...s.publishing.jobs],
        },
      }));
      setJobId(started.id);
    } catch {
      // toast shown
    } finally {
      setStarting(false);
    }
  };

  const footer =
    sending || sent ? (
      <>
        <span className="mr-auto" />
        <Button variant={sent ? 'primary' : 'secondary'} onClick={closeModal}>
          {t.common.close}
        </Button>
      </>
    ) : (
      <>
        <span className="mr-auto" />
        <Button variant="ghost" onClick={closeModal}>
          {t.common.cancel}
        </Button>
        {network.account && (
          <Button
            variant="primary"
            icon={<Send className="size-4" />}
            loading={starting}
            disabled={!ready}
            onClick={() => void publish()}
          >
            {t.dialogs.publish.publishOn(network.label)}
          </Button>
        )}
      </>
    );

  return (
    <Modal title={t.dialogs.publish.title} subtitle={file} onClose={closeModal} width="max-w-[760px]" footer={footer}>
      <div className="grid grid-cols-[220px_minmax(0,1fr)] gap-6">
        <div className="space-y-2">
          <div className="grid aspect-square place-items-center border-2 border-ink bg-ink">
            {video && (
              <video
                src={`${video.url}#t=1.2`}
                preload="metadata"
                muted
                className="max-h-full max-w-full"
                aria-label={file}
                onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
              />
            )}
          </div>
          {video?.format && duration !== null && <p className="text-xs text-ink-3">{texts.formatHint(video.format, duration)}</p>}
        </div>

        <div className="min-w-0 space-y-4">
          <NetworkTabs
            networks={networks}
            value={network.id}
            locked={sending || Boolean(sent)}
            onChange={(id) => {
              setNetworkId(id);
              setJobId(null);
            }}
          />
          {!network.account ? (
            <div className="space-y-3 text-[13px] text-ink-2">
              <p>{texts.connectFirst}</p>
              <Button
                variant="secondary"
                onClick={() => {
                  closeModal();
                  location.hash = `#/${PROFILE_PAGE}`;
                }}
              >
                {t.dialogs.publish.openProfile}
              </Button>
            </div>
          ) : sending || sent ? (
            <Progress network={network} progress={job?.progress ?? 0} publication={sent} />
          ) : (
            <>
              <p className="text-[13px] text-ink-3">
                {texts.onAccount(<span className="font-semibold text-ink-2">{network.account.name}</span>)}
              </p>
              {fields.title !== null && (
                <Field label={t.dialogs.publish.videoTitle(title.length)} htmlFor="publish-title">
                  <input
                    id="publish-title"
                    className={inputClass}
                    value={title}
                    maxLength={fields.title}
                    onChange={(e) => setTitle(e.target.value)}
                  />
                </Field>
              )}
              {fields.text !== null && (
                <Field label={texts.text} htmlFor="publish-description">
                  <textarea
                    id="publish-description"
                    className={`${fieldBase} block min-h-28 w-full resize-y py-2 text-[13px]`}
                    value={description}
                    maxLength={fields.text}
                    onChange={(e) => setDescription(e.target.value)}
                  />
                </Field>
              )}
              {forbidden && <p className="text-xs text-alert">{texts.forbidden}</p>}
              {fields.visibilities.length > 1 ? (
                <Field label={t.dialogs.publish.visibilityLabel} hint={texts.hint}>
                  <Segmented
                    label={t.dialogs.publish.visibilityLabel}
                    size="sm"
                    value={chosen}
                    onChange={setVisibility}
                    options={fields.visibilities.map((value) => ({ value, label: t.common.visibilities[value] }))}
                  />
                </Field>
              ) : (
                <p className="text-xs text-ink-3">{texts.hint}</p>
              )}
              {job?.status === 'error' && (
                <p className="flex items-start gap-1.5 text-[13px] text-alert">
                  <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                  {job.error}
                </p>
              )}
            </>
          )}
          {earlier.length > 0 && <Earlier publications={earlier} />}
        </div>
      </div>
    </Modal>
  );
}

function NetworkTabs(props: {
  networks: NetworkAccount[];
  value: NetworkId;
  locked: boolean;
  onChange: (id: NetworkId) => void;
}) {
  const t = useT();
  return (
    <Segmented
      label={t.dialogs.publish.network}
      size="sm"
      value={props.value}
      onChange={props.onChange}
      options={props.networks.map((n) => {
        const Logo = NETWORK_LOGOS[n.id];
        return {
          value: n.id,
          disabled: props.locked && n.id !== props.value,
          label: (
            <span className="flex items-center gap-1.5">
              <Logo className="size-3.5" />
              {n.label}
            </span>
          ),
        };
      })}
    />
  );
}

function Progress(props: { network: NetworkAccount; progress: number; publication?: Publication }) {
  const t = useT();
  const { network, publication } = props;
  const texts = t[network.id].publish;
  if (!publication) {
    const pct = Math.round(props.progress * 100);
    return (
      <div className="space-y-2 text-[13px] text-ink-2">
        <p className="font-semibold text-ink">
          {pct < 100 ? t.dialogs.publish.uploading(network.label, pct) : t.dialogs.publish.processing(network.label)}
        </p>
        <div className="h-2 border-2 border-ink bg-white">
          <div className="h-full bg-ink transition-[width] duration-300" style={{ width: `${Math.max(2, pct)}%` }} />
        </div>
        <p className="text-ink-3">{t.dialogs.publish.keepsRunning}</p>
      </div>
    );
  }
  const kept = publication.visibility !== publication.requested;
  return (
    <div className="space-y-3 text-[13px] text-ink-2">
      <p className="flex items-center gap-1.5 font-semibold text-ok">
        <CircleCheck className="size-4 shrink-0" aria-hidden /> {texts.sent(network.account?.name ?? '')}
      </p>
      {publication.url && (
        <a
          href={publication.url}
          target="_blank"
          rel="noreferrer"
          className="focus-ring inline-flex items-center gap-1.5 font-semibold text-ink underline underline-offset-2"
        >
          {t.dialogs.publish.watch} <ExternalLink className="size-3.5" aria-hidden />
        </a>
      )}
      <p className="text-ink-3">
        {t.dialogs.publish.visibilityIs(t.common.visibilities[publication.visibility].toLowerCase())}
        {kept && ` ${texts.keptPrivate}`}
      </p>
    </div>
  );
}

function Earlier({ publications }: { publications: Publication[] }) {
  const t = useT();
  return (
    <div className="space-y-1.5 border-t-2 border-rule pt-3">
      <p className="label-caps text-[11px] text-ink-3">{t.dialogs.publish.earlier}</p>
      <ul className="space-y-1 text-[12.5px] text-ink-2">
        {publications.map((p) => {
          const name = p.title || t.common.visibilities[p.visibility];
          return (
            <li key={`${p.publishedAt} ${p.url}`}>
              {p.url ? (
                <a href={p.url} target="_blank" rel="noreferrer" className="focus-ring underline underline-offset-2">
                  {name}
                </a>
              ) : (
                name
              )}{' '}
              ({t.common.visibilities[p.visibility].toLowerCase()}), {relative(p.publishedAt)}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
