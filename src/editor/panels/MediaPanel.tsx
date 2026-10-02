// Media: project assets (images, SVG, fonts) and reference captures the agent reads to rebuild interfaces.
import clsx from 'clsx';
import { Camera, Code2, FileQuestion, ImagePlus, Monitor, Smartphone, Trash2, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { AssetInfo } from '../../shared/types';
import { api, ignore } from '../api';
import { Button, Checkbox, ConfirmButton, EmptyState, Segmented, SectionTitle, inputClass } from '../components/ui';
import { useT } from '../i18n';
import { bytes } from '../lib/format';
import { useStore } from '../store';
import { isAudioFile, uploadMusic } from '../store/music';
import { copyText, toast } from '../store/ui';

const ASSET_ACCEPT = 'image/*,.svg,.woff,.woff2,.ttf,.otf';

export function MediaPanel() {
  const texts = useT().conversation.media;
  const project = useStore((s) => s.project)!;
  const tick = useStore((s) => s.assetsTick);
  const [assets, setAssets] = useState<AssetInfo[] | null>(null);
  const [uploading, setUploading] = useState(0);

  const load = () =>
    api
      .assets(project.id)
      .then(setAssets)
      .catch(() => setAssets([]));

  useEffect(() => {
    void load();
  }, [project.id, tick]);

  const upload = async (files: FileList | File[]) => {
    // A soundtrack dropped here goes where it belongs.
    const audio = [...files].find(isAudioFile);
    if (audio) void uploadMusic(audio);
    const list = [...files].filter((file) => !isAudioFile(file));
    if (list.length === 0) return;
    setUploading((n) => n + list.length);
    for (const file of list) {
      try {
        await api.uploadAsset(project.id, file);
      } catch {
        // toast shown
      } finally {
        setUploading((n) => n - 1);
      }
    }
    await load();
  };

  const files = assets?.filter((a) => !a.isReference) ?? [];
  const refs = assets?.filter((a) => a.isReference) ?? [];

  return (
    <div className="min-h-0 flex-1 space-y-6 overflow-y-auto border-t border-rule px-4 py-4">
      <section className="space-y-2.5">
        <SectionTitle>{texts.files}</SectionTitle>
        <UploadZone onFiles={upload} busy={uploading > 0} />
        {assets === null ? (
          <div className="grid grid-cols-2 gap-2">
            {[0, 1].map((i) => (
              <div key={i} className="skeleton aspect-[4/3] rounded-xl" />
            ))}
          </div>
        ) : files.length === 0 ? (
          <p className="text-xs leading-relaxed text-ink-3">
            {texts.filesHint(<code className="font-mono text-[11px]">asset('…')</code>)}
          </p>
        ) : (
          <ul className="grid grid-cols-2 gap-2">
            {files.map((asset) => (
              <AssetCard key={asset.path} asset={asset} onRemoved={load} />
            ))}
          </ul>
        )}
      </section>
      <References refs={refs} onChange={load} />
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

function AssetCard({ asset, onRemoved }: { asset: AssetInfo; onRemoved: () => void }) {
  const texts = useT().conversation.media;
  const project = useStore((s) => s.project)!;
  const name = asset.path.split('/').pop() ?? asset.path;
  const code = `asset('${asset.path}')`;
  return (
    <li className="group overflow-hidden rounded-xl bg-white ring-1 ring-rule">
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
              onRemoved();
            }}
          />
        </div>
      </div>
      <div className="border-t border-rule px-2.5 py-2">
        <p className="truncate text-[12px] font-medium text-ink-2" title={asset.path}>
          {name}
        </p>
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
  return <FileQuestion className="size-6 text-ink-4" aria-hidden />;
}

// References

function References({ refs, onChange }: { refs: AssetInfo[]; onChange: () => void }) {
  const texts = useT().conversation.media;
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
      <p className="text-xs leading-relaxed text-ink-3">{texts.referencesHint}</p>
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
          {texts.noCapturesHint}
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
