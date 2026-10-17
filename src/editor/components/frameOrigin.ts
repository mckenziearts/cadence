import { useEffect, useState } from 'react';
import { type FrameKind, frameOriginOf } from '../../shared/frameOrigin';
import { useStore } from '../store';

/** The frame origin of a project or a brand, null until WebCrypto has hashed the id. */
export function useFrameOrigin(kind: FrameKind, id: string | null | undefined): string | null {
  const base = useStore((s) => s.app?.frameOrigin);
  const key = base && id ? `${base} ${kind} ${id}` : null;
  const [origin, setOrigin] = useState<{ key: string; value: string } | null>(null);
  useEffect(() => {
    if (!base || !id) return;
    let live = true;
    void frameOriginOf(base, kind, id).then((value) => live && setOrigin({ key: `${base} ${kind} ${id}`, value }));
    return () => {
      live = false;
    };
  }, [base, kind, id]);
  // Never the origin of the previous id while the new one is being hashed.
  return key && origin?.key === key ? origin.value : null;
}
