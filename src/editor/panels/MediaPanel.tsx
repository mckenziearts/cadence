// Media: project assets (images, SVG, fonts, clips, Lottie files) and reference captures the agent reads to rebuild interfaces.
import clsx from 'clsx';
import {
  AlertTriangle,
  Camera,
  Code2,
  FileQuestion,
  Film,
  ImagePlus,
  Monitor,
  Smartphone,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { AssetInfo, ClipState } from '../../shared/types';
import { api, ignore } from '../api';
import {
  Button,
  Checkbox,
  ConfirmButton,
  EmptyState,
  IconButton,
  Segmented,
  SectionTitle,
  Spinner,
  inputClass,
} from '../components/ui';
import { useT } from '../i18n';
import { bytes, secsLabel } from '../lib/format';
import { useStore, type AssetUpload } from '../store';
import { isAudioFile, uploadMusic } from '../store/music';
import { dismissUpload, uploadAssets } from '../store/project';
import { copyText, toast } from '../store/ui';
import { useAgentName } from '../components/agents';

const ASSET_ACCEPT = 'image/*,.svg,.woff,.woff2,.ttf,.otf,.mp4,.mov,.m4v,.webm,.json';

export function MediaPanel() {
  const texts = useT().conversation.media;
  const project = useStore((s) => s.project)!;
  const tick = useStore((s) => s.assetsTick);
  const uploads = useStore((s) => s.uploads).filter((row) => row.projectId === project.id);
  const [assets, setAssets] = useState<AssetInfo[] | null>(null);
  const list = useRef<HTMLUListElement>(null);
  const empty = useRef<HTMLParagraphElement>(null);

  // A list asked before a newer one, or before a card was deleted here, is out of date when it lands.
  const generation = useRef(0);
  const load = () => {
    const asked = ++generation.current;
    return api
      .assets(project.id)
      .catch(() => [])
      .then((all) => asked === generation.current && setAssets(all));
  };

  useEffect(() => {
    void load();
  }, [project.id, tick]);

  const upload = (files: FileList) => {
    // A soundtrack dropped here goes where it belongs.
    const audio = [...files].find(isAudioFile);
    if (audio) void uploadMusic(audio);
    const others = [...files].filter((file) => !isAudioFile(file));
    if (others.length) void uploadAssets(others);
  };

  // The focused control left with its row: the focus goes to the row now in its place, or to the text of the empty list.
  const removeRow = (row: HTMLLIElement | null, drop: () => void) => {
    const index = row ? [...(list.current?.children ?? [])].indexOf(row) : -1;
    flushSync(drop);
    if (index < 0 || document.activeElement !== document.body) return;
    const rows = list.current?.children;
    ((rows?.[Math.min(index, rows.length - 1)] as HTMLElement | undefined) ?? empty.current)?.focus();
  };

  const files = assets?.filter((a) => !a.isReference) ?? [];
  const refs = assets?.filter((a) => a.isReference) ?? [];

  return (
    <div className="min-h-0 flex-1 space-y-6 overflow-y-auto border-t border-rule px-4 py-4">
      <section className="space-y-2.5">
        <SectionTitle>{texts.files}</SectionTitle>
        <UploadZone onFiles={upload} busy={uploads.some((row) => row.error === null)} />
        {assets === null ? (
          <div className="grid grid-cols-2 gap-2">
            {[0, 1].map((i) => (
              <div key={i} className="skeleton aspect-[4/3] rounded-xl" />
            ))}
          </div>
        ) : files.length === 0 && uploads.length === 0 ? (
          <p ref={empty} tabIndex={-1} className="text-xs leading-relaxed text-ink-3 outline-none">
            {texts.filesHint(<code className="font-mono text-[11px]">asset('…')</code>)}
          </p>
        ) : (
          <ul ref={list} className="grid grid-cols-2 gap-2">
            {uploads.map((row) => (
              <UploadRow key={row.id} upload={row} onDismiss={(li) => removeRow(li, () => dismissUpload(row.id))} />
            ))}
            {files.map((asset) => (
              <AssetCard
                key={asset.path}
                asset={asset}
                clip={project.clips[asset.path]}
                onRemoved={(li) =>
                  removeRow(li, () => {
                    generation.current++;
                    setAssets((all) => all && all.filter((a) => a.path !== asset.path));
                  })
                }
              />
            ))}
          </ul>
        )}
      </section>
      <References refs={refs} onChange={load} />
      <CaptureHosts key={project.id} />
    </div>
  );
}

function UploadZone({ onFiles, busy }: { onFiles: (files: FileList) => void; busy: boolean }) {
  const texts = useT().conversation.media;
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  return (
    <div
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        e.stopPropagation();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        e.stopPropagation();
        setOver(false);
        onFiles(e.dataTransfer.files);
      }}
      className={clsx(
        'flex items-center gap-3 rounded-xl border border-dashed px-3.5 py-3 transition-colors',
        over ? 'border-now bg-now/10' : 'border-ink-4 bg-white',
      )}
    >
      <ImagePlus className="size-5 shrink-0 text-ink-4" aria-hidden />
      <p className="min-w-0 flex-1 text-[12.5px] leading-snug text-ink-3">
        {texts.drop}
        <span className="block text-[11px] text-ink-4">{texts.maxSize}</span>
      </p>
      <Button
        size="sm"
        variant="secondary"
        icon={<Upload className="size-3.5" />}
        loading={busy}
        onClick={() => input.current?.click()}
      >
        {texts.add}
      </Button>
      <input
        ref={input}
        type="file"
        multiple
        accept={ASSET_ACCEPT}
        className="hidden"
        onChange={(e) => {
          if (e.target.files?.length) onFiles(e.target.files);
          e.target.value = '';
        }}
      />
    </div>
  );
}

/**
 * A live region that comes in empty and takes `text` a moment later: a region added along with its text is often not
 * read. A `settled` text, a state reached before the row appeared, shows at once: it is not news.
 */
function LiveText({ text, settled = false, className }: { text: string; settled?: boolean; className?: string }) {
  const [shown, setShown] = useState(settled);
  useEffect(() => {
    const timer = setTimeout(() => setShown(true), 100);
    return () => clearTimeout(timer);
  }, []);
  return (
    <p role="status" className={className}>
      {shown && text}
    </p>
  );
}

function UploadRow({ upload, onDismiss }: { upload: AssetUpload; onDismiss: (row: HTMLLIElement | null) => void }) {
  const texts = useT().conversation.media;
  const row = useRef<HTMLLIElement>(null);
  return (
    <li
      ref={row}
      data-upload={upload.name}
      tabIndex={-1}
      className="focus-ring col-span-2 flex items-start gap-2 rounded-xl bg-white py-2 pr-1.5 pl-2.5 ring-1 ring-rule"
    >
      {upload.error ? (
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warn" aria-hidden />
      ) : (
        <Spinner className="mt-0.5 size-3.5" />
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-[12px] font-medium text-ink-2">{upload.name}</p>
        <LiveText
          text={upload.error ?? texts.sending}
          className={clsx('text-[11px] select-text', upload.error ? 'text-warn-ink' : 'text-ink-4')}
        />
      </div>
      {upload.error !== null && (
        <IconButton
          size="xs"
          variant="secondary"
          label={texts.dismiss(upload.name)}
          icon={<X className="size-3" />}
          onClick={() => onDismiss(row.current)}
        />
      )}
    </li>
  );
}

function AssetCard({
  asset,
  clip,
  onRemoved,
}: {
  asset: AssetInfo;
  clip: ClipState | undefined;
  onRemoved: (row: HTMLLIElement | null) => void;
}) {
  const texts = useT().conversation.media;
  const project = useStore((s) => s.project)!;
  const row = useRef<HTMLLIElement>(null);
  const name = asset.path.split('/').pop() ?? asset.path;
  const code = `asset('${asset.path}')`;
  return (
    <li
      ref={row}
      data-asset={asset.path}
      tabIndex={-1}
      className="focus-ring group overflow-hidden rounded-xl bg-white ring-1 ring-rule"
    >
      <div className="relative grid aspect-[4/3] place-items-center overflow-hidden bg-[conic-gradient(#f4f4f5_25%,#fff_0_50%,#f4f4f5_0_75%,#fff_0)] [background-size:14px_14px]">
        <Preview asset={asset} />
        <div className="absolute top-1.5 right-1.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
          <ConfirmButton
            size="xs"
            variant="secondary"
            iconOnly
            label={texts.remove(name)}
            confirmLabel={texts.removeConfirm}
            icon={<Trash2 className="size-3" />}
            onConfirm={async () => {
              await api.deleteAsset(project.id, asset.path);
              onRemoved(row.current);
            }}
          />
        </div>
      </div>
      <div className="border-t border-rule px-2.5 py-2">
        <p className="truncate text-[12px] font-medium text-ink-2" title={asset.path}>
          {name}
        </p>
        {(asset.kind === 'video' || clip) && (
          <LiveText
            text={
              !clip
                ? ''
                : clip.status === 'preparing'
                  ? texts.preparing
                  : clip.status === 'ready'
                    ? texts.ready(secsLabel(clip.duration, 1))
                    : clip.error
            }
            settled={clip?.status !== 'preparing'}
            className={clsx('mt-0.5 text-[11px] select-text', clip?.status === 'error' ? 'text-warn-ink' : 'text-ink-3')}
          />
        )}
        <div className="mt-1 flex items-center gap-1">
          <span className="text-[11px] text-ink-4">{bytes(asset.size)}</span>
          <button
            type="button"
            onClick={() => void copyText(code, texts.copied(code))}
            className="focus-ring ml-auto inline-flex items-center gap-1 rounded-md px-1 py-0.5 font-mono text-[10.5px] text-ink-3 hover:bg-wash hover:text-ink"
            title={texts.copy(code)}
          >
            <Code2 className="size-3" aria-hidden />
            asset()
          </button>
        </div>
      </div>
    </li>
  );
}

let fontSeq = 0;

function Preview({ asset }: { asset: AssetInfo }) {
  const texts = useT().conversation.media;
  const [family, setFamily] = useState<string | null>(null);
  useEffect(() => {
    if (asset.kind !== 'font') return;
    // Load the uploaded font under a private name to show a specimen.
    const name = `cadence-asset-${++fontSeq}`;
    const face = new FontFace(name, `url(${asset.url})`);
    let live = true;
    face
      .load()
      .then(() => {
        document.fonts.add(face);
        if (live) setFamily(name);
      })
      .catch(ignore);
    return () => {
      live = false;
      document.fonts.delete(face);
    };
  }, [asset.kind, asset.url]);

  if (asset.kind === 'image' || asset.kind === 'svg')
    return <img src={asset.url} alt="" loading="lazy" className="max-h-full max-w-full object-contain p-2" />;
  if (asset.kind === 'font')
    return (
      <span className="text-3xl text-ink-2" style={{ fontFamily: family ?? 'inherit' }}>
        Aa Gg
      </span>
    );
  if (asset.kind === 'video')
    return (
      <video src={asset.url} preload="metadata" muted playsInline aria-hidden className="max-h-full max-w-full object-contain" />
    );
  if (asset.kind === 'lottie')
    return (
      <span className="flex flex-col items-center gap-1 text-[11px] text-ink-3">
        <Film className="size-6 text-ink-4" aria-hidden />
        {texts.lottie}
      </span>
    );
  return <FileQuestion className="size-6 text-ink-4" aria-hidden />;
}

// References

function References({ refs, onChange }: { refs: AssetInfo[]; onChange: () => void }) {
  const texts = useT().conversation.media;
  const agent = useAgentName();
  const project = useStore((s) => s.project)!;
  const [url, setUrl] = useState('');
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');
  const [fullPage, setFullPage] = useState(false);
  const [busy, setBusy] = useState(false);

  const capture = async () => {
    let target = url.trim();
    if (!target) return;
    if (!/^https?:\/\//i.test(target)) target = `https://${target}`;
    setBusy(true);
    try {
      const asset = await api.captureRef(project.id, { url: target, device, fullPage });
      toast(texts.captured(asset.path), 'success');
      setUrl('');
      onChange();
    } catch {
      // toast shown
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-2.5">
      <SectionTitle>{texts.references}</SectionTitle>
      <p className="text-xs leading-relaxed text-ink-3">{texts.referencesHint(agent)}</p>
      <form
        className="space-y-2.5 rounded-xl bg-wash/80 p-3 ring-1 ring-rule/80"
        onSubmit={(e) => {
          e.preventDefault();
          void capture();
        }}
      >
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={texts.urlPlaceholder}
          aria-label={texts.url}
          inputMode="url"
          className={inputClass}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            label={texts.device}
            size="sm"
            value={device}
            onChange={setDevice}
            options={[
              { value: 'desktop', label: texts.desktop, icon: <Monitor className="size-3.5" /> },
              { value: 'mobile', label: texts.mobile, icon: <Smartphone className="size-3.5" /> },
            ]}
          />
          <Checkbox checked={fullPage} onChange={setFullPage} label={texts.fullPage} />
          <Button
            type="submit"
            size="sm"
            variant="primary"
            icon={<Camera className="size-3.5" />}
            loading={busy}
            disabled={!url.trim()}
            className="ml-auto"
          >
            {texts.capture}
          </Button>
        </div>
      </form>
      {refs.length === 0 ? (
        <EmptyState icon={<Camera className="size-5" />} title={texts.noCaptures} className="py-6">
          {texts.noCapturesHint(agent)}
        </EmptyState>
      ) : (
        <ul className="space-y-2">
          {refs.map((asset) => (
            <li key={asset.path} className="group flex items-center gap-3 rounded-xl p-1.5 ring-1 ring-rule">
              <a
                href={asset.url}
                target="_blank"
                rel="noreferrer"
                className="focus-ring shrink-0 overflow-hidden rounded-lg bg-wash ring-1 ring-black/5"
              >
                <img src={asset.url} alt="" loading="lazy" className="h-12 w-20 object-cover object-top" />
              </a>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[12.5px] font-medium text-ink-2">{asset.path.replace(/^refs\//, '')}</p>
                <p className="text-[11px] text-ink-4">{bytes(asset.size)}</p>
              </div>
              <ConfirmButton
                size="xs"
                iconOnly
                label={texts.remove(asset.path)}
                confirmLabel={texts.removeConfirm}
                icon={<Trash2 className="size-3" />}
                onConfirm={async () => {
                  await api.deleteAsset(project.id, asset.path);
                  onChange();
                }}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// Allowed hosts

function CaptureHosts() {
  const texts = useT().conversation.captureHosts;
  const agent = useAgentName();
  const project = useStore((s) => s.project)!;
  const [hosts, setHosts] = useState<string[] | null>(null);
  const list = useRef<HTMLUListElement>(null);
  const none = useRef<HTMLParagraphElement>(null);

  // Keyed by project: a late answer for another project lands on an unmounted list.
  useEffect(() => {
    api
      .captureHosts(project.id)
      .then((answer) => setHosts(answer.hosts))
      .catch(ignore);
  }, [project.id]);

  // Two removals in flight may answer in either order: each one drops its own host only.
  const remove = async (host: string, index: number) => {
    try {
      await api.removeCaptureHost(project.id, host);
    } catch {
      return; // toast shown
    }
    flushSync(() => setHosts((hosts) => hosts && hosts.filter((h) => h !== host)));
    // The focused button left with its host: the focus goes to the button now in its place, not to the top of the page.
    if (document.activeElement !== document.body) return;
    const buttons = list.current?.querySelectorAll('button');
    (buttons?.[Math.min(index, buttons.length - 1)] ?? none.current)?.focus();
  };

  return (
    <section className="space-y-2.5">
      <SectionTitle>{texts.title}</SectionTitle>
      <p className="text-xs leading-relaxed text-ink-3">{texts.hint(agent)}</p>
      {hosts?.length === 0 && (
        <p ref={none} tabIndex={-1} className="text-[12.5px] text-ink-3 outline-none">
          {texts.none}
        </p>
      )}
      {hosts && hosts.length > 0 && (
        <ul ref={list} className="space-y-1.5">
          {hosts.map((host, index) => (
            <li key={host} className="flex items-center gap-2 rounded-xl py-1.5 pr-1.5 pl-3 ring-1 ring-rule">
              <span dir="ltr" className="min-w-0 flex-1 font-mono text-[12.5px] break-all text-ink-2">
                {host}
              </span>
              <IconButton
                size="xs"
                variant="secondary"
                label={texts.remove(host)}
                icon={<X className="size-3" />}
                onClick={() => void remove(host, index)}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
