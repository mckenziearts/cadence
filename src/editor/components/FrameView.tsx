// Bridge to frame.html, which runs on the FRAME origin: a cross-origin iframe driven by postMessage only
// (src/shared/frameProtocol.ts). Both sides check origins; the editor also checks the message comes from its iframe.
import { useEffect, useImperativeHandle, useMemo, useRef, type CSSProperties, type Ref } from 'react';
import type { EditorToFrame, FrameToEditor } from '../../shared/frameProtocol';
import type { FormatId } from '../../shared/types';

export interface FrameHandle {
  /** Synchronous render, for playback and scrubbing. */
  render(t: number): void;
  /** Exact frame (fonts and images settled), for a paused playhead. */
  seek(t: number): void;
}

type Outgoing = EditorToFrame extends infer M ? (M extends { source: 'cadence-editor' } ? Omit<M, 'source'> : never) : never;

interface Props {
  ref?: Ref<FrameHandle>;
  frameOrigin: string;
  projectId: string;
  mode: 'editor' | 'present';
  /** null = whole video. Changes are sent with `set-scene` (no page reload). */
  sceneId: string | null;
  format: FormatId;
  /** Time shown until the first render/seek call. */
  initialTime: number;
  /** Bump to make the frame re-fetch the project and re-import changed modules (up to `generation`). */
  reload: number;
  generation: number;
  title: string;
  className?: string;
  style?: CSSProperties;
  onReady?: () => void;
  onErrors?: (errors: string[]) => void;
}

/** Mount it with a `key` per project (and per reconnect epoch): the page itself is loaded once. */
export function FrameView(props: Props) {
  const iframe = useRef<HTMLIFrameElement>(null);
  const ready = useRef(false);
  const last = useRef(props.initialTime);
  /** Scene and format the frame currently shows. */
  const shown = useRef({ sceneId: props.sceneId, format: props.format });
  const latest = useRef(props);
  latest.current = props;
  const requests = useRef(0);

  const src = useMemo(() => {
    const query = new URLSearchParams({
      project: props.projectId,
      format: props.format,
      mode: props.mode,
      t: String(props.initialTime),
    });
    if (props.sceneId) query.set('scene', props.sceneId);
    return `${props.frameOrigin}/frame.html?${query}`;
    // The page loads once per mount; later changes go through messages.
  }, []);

  const bridge = useMemo(() => {
    const post = (message: Outgoing) => {
      const win = iframe.current?.contentWindow;
      if (ready.current && win) win.postMessage({ source: 'cadence-editor', ...message }, latest.current.frameOrigin);
    };
    const seek = (t: number) => {
      last.current = t;
      post({ type: 'seek', t, requestId: `seek-${++requests.current}` });
    };
    const render = (t: number) => {
      last.current = t;
      post({ type: 'render', t });
    };
    /** Scene, format, then the exact time: `seek` is queued behind `set-scene` in the frame, `render` is not. */
    const sync = () => {
      const want = latest.current;
      if (shown.current.sceneId !== want.sceneId) post({ type: 'set-scene', sceneId: want.sceneId });
      if (shown.current.format !== want.format) post({ type: 'set-format', format: want.format });
      shown.current = { sceneId: want.sceneId, format: want.format };
      seek(last.current);
    };
    return { post, seek, render, sync };
  }, []);

  useImperativeHandle(props.ref, () => ({ render: bridge.render, seek: bridge.seek }), [bridge]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== latest.current.frameOrigin || event.source !== iframe.current?.contentWindow) return;
      const message = event.data as FrameToEditor | null;
      if (message?.source !== 'cadence-frame') return;
      if (message.type === 'ready') {
        ready.current = true;
        bridge.sync();
        latest.current.onReady?.();
      } else if (message.type === 'errors') {
        latest.current.onErrors?.(message.errors);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [bridge]);

  useEffect(() => {
    if (ready.current) bridge.sync();
  }, [bridge, props.sceneId, props.format]);

  useEffect(() => {
    if (ready.current && props.reload > 0) bridge.post({ type: 'reload', generation: props.generation });
    // Only a new reload request triggers it; the generation rides along.
  }, [bridge, props.reload]);

  return (
    <iframe
      ref={iframe}
      src={src}
      title={props.title}
      className={props.className}
      style={props.style}
      // Own origin kept (it fetches its project data); no navigation, popups or forms.
      sandbox="allow-scripts allow-same-origin"
      tabIndex={-1}
    />
  );
}
