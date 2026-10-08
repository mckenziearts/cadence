import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { useEffect } from 'react';
import { useT } from '../i18n';
import { useStore } from '../store';
import { closeModal, openModal } from '../store/ui';
import { ArtDirectionModal } from './ArtDirectionModal';
import { NewBrandModal } from './NewBrandModal';
import { NewProjectModal } from './NewProjectModal';
import { PublishModal } from './PublishModal';
import { SeamModal } from './SeamModal';
import { SettingsModal } from './SettingsModal';
import { TemplateGallery } from './TemplateGallery';
import { createPortal } from 'react-dom';
import { useAgentName } from '../components/agents';

export function Modals() {
  const modal = useStore((s) => s.modal);
  const hasProject = useStore((s) => Boolean(s.project));
  if (!modal) return null;
  switch (modal.kind) {
    case 'new-project':
      return <NewProjectModal brand={modal.brand} />;
    case 'new-brand':
      return <NewBrandModal buildId={modal.buildId} />;
    case 'settings':
      return <SettingsModal />;
    case 'art':
      return hasProject ? <ArtDirectionModal /> : null;
    case 'seam':
      return hasProject ? <SeamModal from={modal.from} to={modal.to} format={modal.format} /> : null;
    case 'templates':
      return hasProject ? <TemplateGallery /> : null;
    case 'lightbox':
      return <Lightbox images={modal.images} index={modal.index} />;
    case 'publish':
      return hasProject ? <PublishModal file={modal.file} /> : null;
  }
}

/** Frames the agent rendered, full size. */
function Lightbox({ images, index }: { images: string[]; index: number }) {
  const t = useT();
  const agent = useAgentName();
  const go = (i: number) => openModal({ kind: 'lightbox', images, index: (i + images.length) % images.length });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeModal();
      else if (e.key === 'ArrowRight') go(index + 1);
      else if (e.key === 'ArrowLeft') go(index - 1);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });
  const name = images[index]?.split('/').pop() ?? '';
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t.dialogs.lightbox.label(agent)}
      className="no-drag fixed inset-0 z-50 flex animate-fade-in flex-col bg-ink/90 backdrop-blur-sm"
      onPointerDown={(e) => e.target === e.currentTarget && closeModal()}
    >
      <div className="flex items-center gap-3 px-5 py-3 text-white/80">
        <p className="min-w-0 flex-1 truncate font-mono text-xs">
          {index + 1} / {images.length} · {name}
        </p>
        <button
          type="button"
          onClick={closeModal}
          aria-label={t.common.close}
          className="focus-ring grid size-8 place-items-center rounded-lg hover:bg-white/10 hover:text-white"
        >
          <X className="size-5" />
        </button>
      </div>
      <div
        className="relative flex min-h-0 flex-1 items-center justify-center px-16 pb-10"
        onPointerDown={(e) => e.target === e.currentTarget && closeModal()}
      >
        <img src={images[index]} alt="" className="max-h-full max-w-full rounded-lg shadow-2xl ring-1 ring-white/10" />
        {images.length > 1 && (
          <>
            <button
              type="button"
              onClick={() => go(index - 1)}
              aria-label={t.dialogs.lightbox.previous}
              className="focus-ring absolute left-4 grid size-10 place-items-center rounded-full bg-white/10 text-white hover:bg-white/20"
            >
              <ChevronLeft className="size-5" />
            </button>
            <button
              type="button"
              onClick={() => go(index + 1)}
              aria-label={t.dialogs.lightbox.next}
              className="focus-ring absolute right-4 grid size-10 place-items-center rounded-full bg-white/10 text-white hover:bg-white/20"
            >
              <ChevronRight className="size-5" />
            </button>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
