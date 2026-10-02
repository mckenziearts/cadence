import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import type { CadenceConfig, Hub, ProjectStore } from '../../server/contracts';
import { LocalMusicService } from '../../server/music/service';
import { HttpError, KeyedMutex, roundMs } from '../../server/util';
import type { MusicAnalysis, MusicGridData, MusicSettings, ProjectFile, ProjectState, ServerEvent } from '../../src/shared/types';
import { encodeWav, hasFfmpeg, steadyAnalysis, synthTrack, tempDir } from './synth';

const ID = 'demo';

/** The parts of FileProjectStore the music service uses: project.json on disk, get() asks the grid provider. */
class FakeStore {
  readonly events = new EventEmitter();
  readonly durationWrites: Record<string, number>[] = [];
  provider: (id: string) => Promise<MusicGridData | null> = async () => null;
  private mutex = new KeyedMutex();

  constructor(
    readonly root: string,
    private data: ProjectFile,
  ) {}

  dir(id: string) {
    return path.join(this.root, id);
  }
  async exists(id: string) {
    return id === ID;
  }
  withLock<T>(id: string, fn: () => Promise<T>) {
    return this.mutex.run(id, fn);
  }
  async save() {
    await fs.mkdir(this.dir(ID), { recursive: true });
    await fs.writeFile(path.join(this.dir(ID), 'project.json'), JSON.stringify(this.data));
  }
  async get(id: string): Promise<ProjectState> {
    if (id !== ID) throw new HttpError(404, 'Projet introuvable');
    let start = 0;
    const scenes = this.data.scenes.map((s, index) => {
      const scene = { ...s, index, start: roundMs(start), file: '', url: '', codeVersion: '' };
      start += s.duration;
      return scene;
    });
    const { music } = this.data;
    return {
      ...this.data,
      language: this.data.language ?? null,
      id,
      dir: this.dir(id),
      scenes,
      duration: roundMs(start),
      musicUrl: null,
      musicGrid: music ? await this.provider(id) : null,
      codeGeneration: 0,
    };
  }
  async setMusic(id: string, music: MusicSettings | null) {
    this.data.music = music;
    await this.save();
    return this.get(id);
  }
  async setDurations(id: string, durations: Record<string, number>) {
    this.durationWrites.push(durations);
    for (const s of this.data.scenes) if (s.id in durations) s.duration = durations[s.id];
    await this.save();
    return this.get(id);
  }
  async update(id: string, patch: { tempo?: number }) {
    if (patch.tempo !== undefined) this.data.tempo = Math.round(patch.tempo * 100) / 100;
    await this.save();
    return this.get(id);
  }
}

class FakeHub {
  readonly events: ServerEvent[] = [];
  private waiters: { status: string; resolve: (e: ServerEvent) => void }[] = [];
  send(event: ServerEvent) {
    this.events.push(event);
    if (event.type !== 'music') return;
    for (const w of this.waiters.filter((w) => w.status === event.status)) w.resolve(event);
    this.waiters = this.waiters.filter((w) => w.status !== event.status);
  }
  handleSse() {}
  next(status: 'ready' | 'error'): Promise<ServerEvent> {
    return new Promise((resolve) => this.waiters.push({ status, resolve }));
  }
  count(status: string) {
    return this.events.filter((e) => e.type === 'music' && e.status === status).length;
  }
}

async function setup(scenes: { id: string; duration: number }[] = [{ id: 'intro', duration: 4 }]) {
  const root = tempDir();
  const store = new FakeStore(root, {
    version: 1,
    name: 'Démo',
    brand: null,
    fps: 30,
    formats: ['16:9'],
    tempo: 120,
    scenes: scenes.map((s) => ({ ...s, name: s.id })),
    music: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  await store.save();
  const hub = new FakeHub();
  const config = { ffmpegPath: 'ffmpeg' } as CadenceConfig;
  const music = new LocalMusicService({ config, store: store as unknown as ProjectStore, hub: hub as unknown as Hub });
  store.provider = (id) => music.grid(id);
  return { root, store, hub, music, musicDir: path.join(store.dir(ID), 'music') };
}

/** A track whose analysis is already cached (no ffmpeg needed). */
async function cachedTrack(musicDir: string, name: string, analysis: MusicAnalysis = steadyAnalysis()) {
  await fs.mkdir(musicDir, { recursive: true });
  const file = path.join(musicDir, name);
  await fs.writeFile(file, Buffer.from(`fake audio ${name}`));
  const stat = await fs.stat(file);
  await fs.writeFile(`${file}.analysis.json`, JSON.stringify({ size: stat.size, mtimeMs: stat.mtimeMs, analysis }));
  return file;
}

async function rejects(promise: Promise<unknown>, status: number, message: RegExp) {
  await assert.rejects(promise, (e: unknown) => e instanceof HttpError && e.status === status && message.test(e.message));
}

test('select, grid with overrides, validated updates, remove keeps the files', async () => {
  const { store, music, musicDir, hub } = await setup();
  await cachedTrack(musicDir, 'theme.mp3');

  let state = await music.select(ID, 'music/theme.mp3');
  assert.deepEqual(state.music, { file: 'music/theme.mp3', start: 0, volume: 1 });
  assert.equal(state.musicGrid?.bpm, 120);
  assert.equal(hub.count('analyzing'), 0, 'a fresh cache is not analysed again');
  assert.deepEqual(await music.tracks(ID), [{ file: 'music/theme.mp3', size: 20, analysed: true }]);
  assert.equal(await music.audioPath(ID), path.join(musicDir, 'theme.mp3'));

  state = await music.update(ID, { start: 1.23456, volume: 0.5, bpm: 100, beatsPerBar: 3, barOffset: 2, gridOffset: 0.0123 });
  assert.deepEqual(state.music, {
    file: 'music/theme.mp3',
    start: 1.235,
    volume: 0.5,
    bpm: 100,
    beatsPerBar: 3,
    barOffset: 2,
    gridOffset: 0.012,
  });
  assert.equal(state.musicGrid?.bpm, 100);
  assert.equal(state.musicGrid?.beatsPerBar, 3);

  await rejects(music.update(ID, { volume: 1.5 }), 400, /volume/);
  await rejects(music.update(ID, { bpm: 300 }), 400, /entre 40 et 240 BPM/);
  await rejects(music.update(ID, { beatsPerBar: 5 }), 400, /3, 4 ou 6/);
  await rejects(music.update(ID, { barOffset: 3 }), 400, /entre 0 et 2/);
  await rejects(music.update(ID, { gridOffset: 0.3 }), 400, /grille/);
  await rejects(music.update(ID, { start: -1 }), 400, /début/);
  // A shorter bar pulls the kept offset inside it; null resets an override.
  state = await music.update(ID, { beatsPerBar: 4 });
  assert.equal(state.music?.barOffset, 2);
  state = await music.update(ID, { bpm: null, beatsPerBar: null, barOffset: null, gridOffset: null });
  assert.deepEqual(state.music, { file: 'music/theme.mp3', start: 1.235, volume: 0.5, bpm: null });

  // Selecting the selected track keeps its settings.
  assert.equal((await music.select(ID, 'theme.mp3')).music?.start, 1.235);
  await rejects(music.select(ID, '../project.json'), 400, /invalide/);
  await rejects(music.select(ID, 'music/missing.mp3'), 404, /introuvable/);

  state = await music.remove(ID);
  assert.equal(state.music, null);
  assert.equal(await music.audioPath(ID), null);
  assert.equal(await music.analysis(ID), null);
  await fs.access(path.join(musicDir, 'theme.mp3'));
  await fs.access(path.join(musicDir, 'theme.mp3.analysis.json'));
  await rejects(music.update(ID, { volume: 1 }), 400, /pas de musique/);
  assert.equal(store.durationWrites.length, 0);
});

test('snapCuts moves every cut to the nearest grid point in video time, in one write', async () => {
  // Bars every 2 s from 1 s of the track; the video starts 0.5 s into it, so bar lines sit at 0.5, 2.5, 4.5... s.
  const scenes = [
    { id: 'a', duration: 1.8 },
    { id: 'b', duration: 2.3 },
    { id: 'c', duration: 0.3 },
    { id: 'd', duration: 3.1 },
  ];
  const { store, music, musicDir } = await setup(scenes);
  await cachedTrack(musicDir, 'theme.wav');
  await music.select(ID, 'music/theme.wav');
  await music.update(ID, { start: 0.5 });

  let state = await music.snapCuts(ID, 'bar');
  assert.deepEqual(store.durationWrites, [{ a: 2.5, b: 2, c: 2, d: 2 }]);
  assert.deepEqual(
    state.scenes.map((s) => s.duration),
    [2.5, 2, 2, 2],
  );

  await store.setDurations(ID, { a: 1.8, b: 2.3, c: 0.3, d: 3.1 });
  state = await music.snapCuts(ID, 'beat');
  // c (0.3 s) grows to the 0.4 s minimum's next beat; d's end already sits on a beat.
  assert.deepEqual(
    state.scenes.map((s) => s.duration),
    [2, 2, 0.5, 3],
  );

  // Phrases (every 8 s from 0.5 s of video); a cut past the end of the music keeps its place.
  await store.setDurations(ID, { a: 7, b: 9.5, c: 20, d: 10 });
  state = await music.snapCuts(ID, 'phrase');
  assert.deepEqual(
    state.scenes.map((s) => s.duration),
    [8.5, 8, 16, 14],
  );
});

test('snapCuts keepBars: scenes keep their bars, cuts land on the bar lines, snapping again changes nothing', async () => {
  // A campaign sized at 145 BPM (4, 2, 3 and 10 bars) on the 120 BPM track: bar lines every 2 s from 1 s of the track.
  const bars = { a: 4, b: 2, c: 3, d: 10 };
  const { store, music, musicDir } = await setup(
    Object.entries(bars).map(([id, n]) => ({ id, duration: roundMs((n * 240) / 145) })),
  );
  await store.update(ID, { tempo: 145 });
  await cachedTrack(musicDir, 'theme.wav');
  await music.select(ID, 'music/theme.wav');
  await music.update(ID, { start: 0.5 });
  const durations = async () => (await store.get(ID)).scenes.map((s) => s.duration);

  // Bar lines from 0.5 s to 32.5 s of video, every 2 s: the 0.5 s lead-in joins the first scene, and d runs on past the last
  // detected bar line in 2 s bars. The music does not move; bars now count at the track's tempo.
  const state = await music.snapCuts(ID, 'bar', { keepBars: true });
  assert.deepEqual(
    state.scenes.map((s) => s.duration),
    [8.5, 4, 6, 20],
  );
  assert.deepEqual([state.music?.start, state.tempo], [0.5, 120]);
  await music.snapCuts(ID, 'bar', { keepBars: true });
  assert.deepEqual(await durations(), [8.5, 4, 6, 20], 'snapping again keeps every bar count');

  // A lead-in over half a bar (bar lines at 1.2, 3.2... s) does not count as one more bar of the first scene.
  await music.update(ID, { start: 1.8 });
  await music.snapCuts(ID, 'bar', { keepBars: true });
  assert.deepEqual(await durations(), [9.2, 4, 6, 20]);
  await music.snapCuts(ID, 'bar', { keepBars: true });
  assert.deepEqual(await durations(), [9.2, 4, 6, 20]);
});

test('context: tempo, bars, cuts and scene-local times for the agent', async () => {
  const { music, musicDir, store } = await setup([
    { id: 'intro', duration: 2 },
    { id: 'demo', duration: 4.1 },
  ]);
  assert.match(await music.context(ID), /No music track.*120 BPM/);
  await cachedTrack(musicDir, 'theme.mp3');
  await music.select(ID, 'music/theme.mp3');
  await music.update(ID, { start: 1 });

  const project = await music.context(ID);
  assert.match(project, /Tempo 120\.00 BPM, 4 beats per bar: 1 beat = 0\.500 s, 1 bar = 2\.000 s/);
  assert.match(project, /Grid confidence 0\.90/);
  assert.match(project, /intro → demo at 2\.000 s: on bar 2/);
  assert.match(project, /Video end 6\.100 s: 0\.100 s \(0\.20 beat\) after bar 4/);

  const scene = await music.context(ID, 'demo');
  assert.match(scene, /scene-local/);
  assert.match(scene, /It starts on bar 2 and ends 0\.100 s \(0\.20 beat\) after bar 4/);
  assert.match(scene, /Bar lines: 0\.000 \[bar 2\], 2\.000 \[bar 3\], 4\.000 \[bar 4\]/);
  assert.match(scene, /Beats: 0\.000, 0\.500, 1\.000/);
  await rejects(music.context(ID, 'nope'), 404, /Scène introuvable/);
  assert.equal(store.durationWrites.length, 0);
});

test(
  'upload: sanitized name, selection, one shared background analysis, cache, re-upload',
  { skip: !hasFfmpeg && 'ffmpeg introuvable' },
  async () => {
    const { music, musicDir, hub } = await setup();
    const track = synthTrack({ bpm: 128, beatsPerBar: 4, bars: 8, kick: [0], snare: [2], hat: 0.5 });
    const wav = encodeWav(track.samples, track.sampleRate);

    await rejects(music.upload(ID, { name: 'notes.txt', body: [wav] }), 400, /Format audio non pris en charge/);
    await rejects(music.upload(ID, { name: 'vide.mp3', body: [Buffer.alloc(0)] }), 400, /vide/);

    const ready = hub.next('ready');
    let state = await music.upload(ID, { name: 'Mon Morceau (final).WAV', body: [wav] });
    assert.deepEqual(state.music, { file: 'music/mon-morceau-final.wav', start: 0, volume: 1 });
    assert.equal(state.musicGrid, null, 'no grid while analysing');
    const [a1, a2] = await Promise.all([music.analysis(ID), music.analysis(ID), music.grid(ID)]);
    await ready;
    assert.equal(hub.count('analyzing'), 1, 'concurrent callers share one analysis');
    assert.equal(a1, a2);
    assert.ok(Math.abs(a1!.bpm - 128) <= 1);

    const file = path.join(musicDir, 'mon-morceau-final.wav');
    const stat = await fs.stat(file);
    const cache = JSON.parse(await fs.readFile(`${file}.analysis.json`, 'utf8'));
    assert.deepEqual([cache.size, cache.mtimeMs, cache.analysis.version], [stat.size, stat.mtimeMs, 2]);
    assert.ok((await music.grid(ID))?.downbeats.length);

    // Re-uploading the same bytes reuses the file and keeps the settings; other bytes never replace it.
    await music.update(ID, { start: 2 });
    state = await music.upload(ID, { name: 'mon morceau (final).wav', body: [wav] });
    assert.equal(state.music?.start, 2);
    const second = hub.next('ready');
    state = await music.upload(ID, { name: 'Mon Morceau (final).wav', body: [Buffer.concat([wav, Buffer.alloc(2)])] });
    assert.deepEqual(state.music, { file: 'music/mon-morceau-final-2.wav', start: 0, volume: 1 });
    await second;
    const names = await fs.readdir(musicDir);
    assert.deepEqual(names.filter((n) => n.endsWith('.wav')).sort(), ['mon-morceau-final-2.wav', 'mon-morceau-final.wav']);
    assert.ok(!names.some((n) => n.startsWith('.upload-')), 'no temp file left behind');

    // A file that changed since its analysis is analysed again.
    await music.select(ID, 'music/mon-morceau-final.wav');
    const before = hub.count('analyzing');
    await fs.utimes(file, new Date(), new Date(Date.now() + 5000));
    assert.ok(await music.analysis(ID));
    assert.equal(hub.count('analyzing'), before + 1);
  },
);

test('upload never replaces a hand-copied track whose name differs only in case', async () => {
  const { music, musicDir } = await setup();
  await fs.mkdir(musicDir, { recursive: true });
  await fs.writeFile(path.join(musicDir, 'Generique.mp3'), 'hand-copied bytes');
  // The same bytes are a re-upload of that file (macOS volumes are case-insensitive: it is "generique.mp3" too).
  let state = await music.upload(ID, { name: 'generique.mp3', body: [Buffer.from('hand-copied bytes')] });
  assert.equal(state.music?.file, 'music/Generique.mp3');
  state = await music.upload(ID, { name: 'Générique.MP3', body: [Buffer.from('other bytes')] });
  assert.equal(state.music?.file, 'music/generique-2.mp3');
  assert.equal(await fs.readFile(path.join(musicDir, 'Generique.mp3'), 'utf8'), 'hand-copied bytes');
});

test(
  'a file ffmpeg cannot decode reports one error and is not retried by grid()',
  { skip: !hasFfmpeg && 'ffmpeg introuvable' },
  async () => {
    const { music, hub } = await setup();
    const failed = hub.next('error');
    const state = await music.upload(ID, { name: 'broken.mp3', body: [Buffer.from('this is not audio at all')] });
    assert.equal(state.music?.file, 'music/broken.mp3');
    const event = await failed;
    assert.ok(event.type === 'music' && /Analyse de broken\.mp3 impossible/.test(event.error ?? ''));
    for (let i = 0; i < 3; i++) assert.equal(await music.grid(ID), null);
    await rejects(music.analysis(ID), 422, /impossible/);
    assert.equal(hub.count('analyzing'), 1);
    assert.equal(hub.count('error'), 1);
  },
);
