// A scene's voice-over written line by line in the Voice tab: who says each line, its text, its gesture (set by the
// agent, kept as is), its order, and when it is heard once spoken.
import clsx from 'clsx';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { ScriptLine, ScriptLineInput, Speaker } from '../../shared/types';
import { useT } from '../i18n';
import { secsLabel } from '../lib/format';
import { editLine, moveLine, nextLineSpeaker } from '../lib/voiceOver';
import { Button, IconButton, fieldBase, inputClass, useFocusAfter } from './ui';

/** Applied to the lines as last saved; resolves to false when the server refused it. */
export type ChangeLines = (change: (lines: ScriptLine[]) => ScriptLineInput[]) => Promise<boolean>;

export function ScriptLines(props: {
  scene: string;
  speakers: Speaker[];
  lines: ScriptLine[];
  /** Each line's start and end in scene seconds; null while the scene is not spoken. */
  times: ({ start: number; end: number } | null)[] | null;
  onChange: ChangeLines;
}) {
  const { scene, speakers, lines, times, onChange } = props;
  const texts = useT().production.voiceOver.script;
  // A new line stays here until its text is saved: the server refuses a blank one.
  const [adding, setAdding] = useState(false);
  const [newSpeaker, setNewSpeaker] = useState<string | null>(null);
  const { list: rows, focusAfter } = useFocusAfter<HTMLDivElement>();
  const close = () => {
    setAdding(false);
    setNewSpeaker(null);
  };
  // Applied to the lines as last saved, each change finds its row's line there by id.
  const edit = (id: string, change: (list: ScriptLine[], i: number) => ScriptLine[]) =>
    onChange((list) => editLine(list, id, change));
  const update = (id: string, patch: Partial<ScriptLine>) =>
    edit(id, (list, i) => list.map((line, j) => (j === i ? { ...line, ...patch } : line)));
  const control = (id: string, name: 'up' | 'down' | 'remove') => `[data-line="${id}"] [data-control="${name}"]`;
  // The moved line's button keeps the focus, or the other one once the line reaches the top or the bottom.
  const move = (id: string, by: -1 | 1) =>
    focusAfter(
      onChange((list) => moveLine(list, id, by)),
      by < 0 ? [control(id, 'up'), control(id, 'down')] : [control(id, 'down'), control(id, 'up')],
    );
  // The next line's button takes the focus, or the add button after the last line.
  const remove = (id: string, next: string | undefined) =>
    focusAfter(
      edit(id, (list, at) => list.filter((_, j) => j !== at)),
      [...(next ? [control(next, 'remove')] : []), '[data-control="add"]'],
    );
  const speaker = newSpeaker ?? (speakers.length ? nextLineSpeaker(speakers, lines) : '');

  return (
    <div ref={rows} className="space-y-2">
      <ol className="space-y-2">
        {lines.map((line, i) => (
          <LineRow
            key={line.id}
            scene={scene}
            n={i + 1}
            line={line}
            speakers={speakers}
            time={times?.[i] ?? null}
            onText={(text) => update(line.id, { text })}
            onSpeaker={(id) => void update(line.id, { speaker: id })}
            onRemove={() => remove(line.id, lines[i + 1]?.id)}
            onUp={i > 0 ? () => move(line.id, -1) : undefined}
            onDown={i < lines.length - 1 ? () => move(line.id, 1) : undefined}
          />
        ))}
        {adding && (
          <LineRow
            key="new"
            scene={scene}
            n={lines.length + 1}
            line={{ speaker, text: '' }}
            speakers={speakers}
            time={null}
            autoFocus
            onText={async (text) => {
              const ok = await onChange((list) => [...list, { speaker, text }]);
              if (ok) close();
              return ok;
            }}
            onSpeaker={setNewSpeaker}
            onRemove={close}
          />
        )}
      </ol>
      {!adding && speakers.length > 0 && (
        <Button
          size="xs"
          variant="secondary"
          icon={<Plus className="size-3" />}
          aria-label={texts.addLineLabel(scene)}
          data-control="add"
          onClick={() => setAdding(true)}
        >
          {texts.addLine}
        </Button>
      )}
    </div>
  );
}

function LineRow(props: {
  scene: string;
  n: number;
  line: ScriptLineInput;
  speakers: Speaker[];
  time: { start: number; end: number } | null;
  autoFocus?: boolean;
  onText: (text: string) => Promise<boolean>;
  onSpeaker: (id: string) => void;
  onRemove: () => void;
  onUp?: () => void;
  onDown?: () => void;
}) {
  const { scene, n, line, speakers, time, autoFocus, onText, onSpeaker, onRemove, onUp, onDown } = props;
  const texts = useT().production.voiceOver.script;
  // Kept until the server saved it: a refused text stays in the field beside the reason.
  const [text, setText] = useState<string | null>(null);
  const color = speakers.find((s) => s.id === line.speaker)?.color;
  return (
    <li data-line={line.id} className="space-y-1 border-l-2 pl-2" style={{ borderColor: color ?? 'transparent' }}>
      <div className="flex items-center gap-1">
        <select
          aria-label={texts.speakerLabel(scene, n)}
          value={line.speaker}
          onChange={(e) => onSpeaker(e.target.value)}
          className={clsx(inputClass, 'h-7 min-w-0 flex-1 appearance-none text-[13px]')}
        >
          {!speakers.some((s) => s.id === line.speaker) && <option value={line.speaker}>{line.speaker}</option>}
          {speakers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <IconButton
          size="xs"
          label={texts.moveUp(scene, n)}
          icon={<ArrowUp className="size-3" />}
          data-control="up"
          disabled={!onUp}
          onClick={onUp}
        />
        <IconButton
          size="xs"
          label={texts.moveDown(scene, n)}
          icon={<ArrowDown className="size-3" />}
          data-control="down"
          disabled={!onDown}
          onClick={onDown}
        />
        <IconButton
          size="xs"
          label={texts.removeLine(scene, n)}
          icon={<Trash2 className="size-3" />}
          data-control="remove"
          onClick={onRemove}
        />
      </div>
      <textarea
        aria-label={texts.lineLabel(scene, n)}
        placeholder={texts.linePlaceholder}
        rows={2}
        maxLength={2000}
        autoFocus={autoFocus}
        value={text ?? line.text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          if (text === null) return;
          const next = text.trim();
          if (!next || next === line.text) return setText(null);
          void onText(next).then((ok) => ok && setText(null));
        }}
        className={clsx(fieldBase, 'block w-full resize-y px-2 py-1.5 text-[13px]')}
      />
      {(line.gesture !== undefined || time) && (
        <p className="flex gap-2 text-xs text-ink-3">
          {line.gesture !== undefined && <span className="min-w-0 truncate">{texts.gesture(line.gesture)}</span>}
          {time && <span className="ml-auto shrink-0">{texts.lineTiming(secsLabel(time.start), secsLabel(time.end))}</span>}
        </p>
      )}
    </li>
  );
}
