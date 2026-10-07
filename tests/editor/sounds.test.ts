// The sound effects of the preview and Present, against a fake AudioContext: what is scheduled when, and only once.
// node --import tsx --test tests/editor/sounds.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SoundPlayer, type AudioOut, type SoundLibrary } from '../../src/editor/lib/sounds';
import { SOUND_NAMES, SOUND_PEAKS, type SoundCue, type SoundName } from '../../src/shared/sounds';

const DURATIONS: Record<SoundName, number> = { click: 0.1, key: 0.11, pop: 0.2, whoosh: 0.6, impact: 1.2 };
const LIBRARY = new Map(SOUND_NAMES.map((sound) => [sound, { duration: DURATIONS[sound] }])) as unknown as SoundLibrary;

class FakeNode {
  output: unknown = null;
  connect<T>(node: T): T {
    this.output = node;
    return node;
  }
}

class FakeGain extends FakeNode {
  gain = { value: 1 };
}

class FakeLimiter extends FakeNode {
  threshold = { value: -24 };
  knee = { value: 30 };
  ratio = { value: 12 };
  attack = { value: 0.003 };
  release = { value: 0.25 };
}

class FakeSource extends FakeNode {
  buffer: { duration: number } | null = null;
  started: { when: number; offset: number } | null = null;
  stopped = false;
  onended: (() => void) | null = null;
  start(when: number, offset: number) {
    // Web Audio throws a RangeError on these.
    if (!(when >= 0 && offset >= 0)) throw new RangeError(`start(${when}, ${offset})`);
    this.started = { when, offset };
  }
  stop() {
    this.stopped = true;
  }
}

class FakeContext {
  currentTime = 10;
  state = 'suspended';
  destination = {};
  resumed = 0;
  closed = false;
  sources: FakeSource[] = [];
  limiters: FakeLimiter[] = [];
  wake: () => void = () => undefined;
  constructor(private readonly resumes: 'runs' | 'fails' | 'waits' = 'runs') {}
  resume() {
    this.resumed++;
    if (this.resumes === 'fails') return Promise.reject(new Error('no audio device'));
    const running = () => void (this.state = 'running');
    if (this.resumes === 'runs') return Promise.resolve(running());
    return new Promise<void>((resolve) => (this.wake = () => resolve(running())));
  }
  close() {
    this.closed = true;
    this.state = 'closed';
    return this.resumes === 'fails' ? Promise.reject(new Error('already closed')) : Promise.resolve();
  }
  createGain() {
    return new FakeGain();
  }
  createDynamicsCompressor() {
    const limiter = new FakeLimiter();
    this.limiters.push(limiter);
    return limiter;
  }
  createBufferSource() {
    const source = new FakeSource();
    this.sources.push(source);
    return source;
  }
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function makePlayer(load: () => Promise<SoundLibrary> = async () => LIBRARY, resumes?: 'runs' | 'fails' | 'waits') {
  const contexts: FakeContext[] = [];
  const sounds = new SoundPlayer(() => {
    const ctx = new FakeContext(resumes);
    contexts.push(ctx);
    return ctx as unknown as AudioOut;
  }, load);
  return { player: sounds, ctx: () => contexts.at(-1)!, contexts };
}

async function setup(cues: unknown, shown = { sceneId: 'intro' as string | null, duration: 4, scenes: 1 }, from = 0) {
  let loads = 0;
  const made = makePlayer(async () => {
    loads++;
    return LIBRARY;
  });
  made.player.show(shown);
  made.player.receive(shown.sceneId, cues);
  made.player.play(from);
  await flush();
  return { ...made, loads: () => loads };
}

const started = (ctx: FakeContext) => ctx.sources.filter((s) => s.started).map((s) => ({ ...s.started!, sound: soundOf(s) }));
const soundOf = (source: FakeSource) => SOUND_NAMES.find((sound) => DURATIONS[sound] === source.buffer?.duration);
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
const pop = (at: number, gain = 1): SoundCue => ({ at, sound: 'pop', gain });

test('the play gesture opens and resumes one AudioContext; the library loads once, and only once cues come', async () => {
  const { player, contexts, loads } = await setup([]);
  assert.equal(loads(), 0, 'a scene without sounds fetches nothing');
  player.receive('intro', [pop(0.1)]);
  player.receive('intro', [pop(0.2)]);
  player.play(0);
  await flush();
  assert.equal(loads(), 1);
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].resumed, 2);
  const [limiter] = contexts[0].limiters;
  assert.equal(contexts[0].limiters.length, 1);
  assert.equal(limiter.output, contexts[0].destination);
  assert.ok(limiter.threshold.value >= -2 && limiter.ratio.value >= 20 && limiter.attack.value <= 0.003);
});

test('a tick schedules the cues of the next 0.15 s, the sound starting so its peak lands on the cue', async () => {
  const { player, ctx } = await setup([pop(0.1, 0.5), pop(0.2), pop(1)]);
  player.tick(0, true);
  assert.equal(started(ctx()).length, 1);
  near(started(ctx())[0].when, 10 + 0.1 - SOUND_PEAKS.pop);
  assert.equal(started(ctx())[0].offset, 0);
  assert.equal(started(ctx())[0].sound, 'pop');
  const gain = ctx().sources[0].output as FakeGain;
  assert.equal(gain.gain.value, 0.5);
  assert.equal(gain.output, ctx().limiters[0], 'through the limiter');
});

test('no cue is scheduled twice across ticks', async () => {
  const { player, ctx } = await setup([pop(0.1), pop(0.2), pop(1)]);
  player.tick(0, true);
  ctx().currentTime += 0.05;
  player.tick(0.05, true);
  ctx().currentTime += 0.016;
  player.tick(0.066, true);
  assert.equal(started(ctx()).length, 2);
  near(started(ctx())[1].when, 10.066 + 0.2 - SOUND_PEAKS.pop - 0.066);
  ctx().currentTime += 0.9;
  player.tick(0.966, true);
  player.tick(0.966, true);
  assert.equal(started(ctx()).length, 3);
});

test('a seek into a sound starts it at the seek point; one whose peak is before the seek is not owed', async () => {
  const cues = [
    { at: 0.5, sound: 'pop' },
    { at: 0.6, sound: 'whoosh' },
  ];
  const { player, ctx } = await setup(cues, undefined, 0.55);
  player.tick(0.55, true);
  assert.deepEqual(
    started(ctx()).map((s) => s.sound),
    ['whoosh'],
  );
  assert.equal(started(ctx())[0].when, 10);
  near(started(ctx())[0].offset, 0.55 - (0.6 - SOUND_PEAKS.whoosh));
});

test('cues at the start point still play when the first tick comes a frame late', async () => {
  const { player, ctx } = await setup([
    { at: 0, sound: 'pop' },
    { at: 0, sound: 'impact' },
  ]);
  player.tick(0.016, true);
  const heard = started(ctx()).sort((a, b) => a.sound!.localeCompare(b.sound!));
  assert.deepEqual(
    heard.map((s) => [s.sound, s.when]),
    [
      ['impact', 10],
      ['pop', 10],
    ],
  );
  near(heard[0].offset, SOUND_PEAKS.impact);
  near(heard[1].offset, SOUND_PEAKS.pop);
});

test('the cue at a seek point and at the loop start plays when the first tick comes a frame late', async () => {
  const { player, ctx } = await setup([pop(0), pop(1)]);
  player.reset(1);
  player.tick(1.016, true);
  assert.equal(started(ctx()).length, 1);
  assert.equal(started(ctx())[0].when, 10);
  near(started(ctx())[0].offset, SOUND_PEAKS.pop);
  for (const t of [2, 3, 4]) player.tick(t, true);
  player.reset(0);
  player.tick(0.016, true);
  assert.equal(started(ctx()).length, 2);
  assert.equal(started(ctx())[1].when, 10);
  near(started(ctx())[1].offset, SOUND_PEAKS.pop);
});

test('ticks while the library decodes lose nothing; a cue more than 0.1 s late is skipped', async () => {
  for (const [first, expected] of [
    [0.05, 1],
    [0.2, 0],
  ] as const) {
    let decoded!: (library: SoundLibrary) => void;
    const { player, ctx } = makePlayer(() => new Promise<SoundLibrary>((resolve) => (decoded = resolve)));
    player.show({ sceneId: 'intro', duration: 4, scenes: 1 });
    player.receive('intro', [{ at: 0.02, sound: 'whoosh' }]);
    player.play(0);
    player.tick(0.016, true);
    player.tick(0.033, true);
    assert.equal(ctx().sources.length, 0);
    decoded(LIBRARY);
    await flush();
    player.tick(first, true);
    player.tick(first + 0.016, true);
    assert.equal(started(ctx()).length, expected, `first ready tick at ${first}`);
    if (expected) {
      assert.equal(started(ctx())[0].when, 10);
      near(started(ctx())[0].offset, SOUND_PEAKS.whoosh - 0.02);
    }
  }
});

test('a load that fails is tried again at the next play, and nothing rejects', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    let loads = 0;
    const { player, ctx } = makePlayer(async () => {
      if (++loads === 1) throw new Error('offline');
      return LIBRARY;
    });
    player.show({ sceneId: 'intro', duration: 4, scenes: 1 });
    player.receive('intro', [pop(0.1)]);
    assert.equal(player.play(0), undefined);
    await flush();
    player.tick(0, true);
    assert.equal(ctx().sources.length, 0);
    player.play(0);
    await flush();
    assert.equal(loads, 2);
    player.tick(0, true);
    assert.equal(started(ctx()).length, 1);

    const broken = makePlayer(async () => LIBRARY, 'fails');
    broken.player.play(0);
    broken.player.close();
    await flush();
    assert.equal(broken.ctx().closed, true);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('a seek stops the pending sounds and schedules again from the new playhead', async () => {
  const { player, ctx } = await setup([pop(0.1), pop(2)]);
  player.tick(0, true);
  assert.equal(started(ctx()).length, 1);
  player.reset(1.9);
  assert.ok(ctx().sources[0].stopped);
  player.tick(1.9, true);
  assert.equal(started(ctx()).length, 2);
  near(started(ctx())[1].when, 10 + 2 - SOUND_PEAKS.pop - 1.9);
  player.reset(0);
  player.tick(0, true);
  assert.equal(started(ctx()).length, 3);
});

test('nothing plays while paused, and a pause stops what was pending', async () => {
  const { player, ctx } = await setup([pop(0.1)]);
  player.tick(0, false);
  assert.equal(ctx().sources.length, 0);
  player.tick(0, true);
  player.tick(0.01, false);
  assert.ok(ctx().sources[0].stopped);
  player.tick(0.01, false);
  assert.equal(ctx().sources.length, 1);
});

test('muted ticks owe nothing: a cue before the unmute is not played, one in the last frame is played late', async () => {
  const { player, ctx } = await setup([
    { at: 0.49, sound: 'whoosh' },
    { at: 0.51, sound: 'whoosh' },
  ]);
  player.tick(0.5, false);
  player.tick(0.52, true);
  assert.equal(started(ctx()).length, 1);
  assert.equal(started(ctx())[0].when, 10);
  near(started(ctx())[0].offset, 0.5 - (0.51 - SOUND_PEAKS.whoosh));
});

test('new cues and a scene change stop the pending sounds', async () => {
  const { player, ctx } = await setup([pop(0.1)]);
  player.tick(0, true);
  player.receive('intro', [pop(0.12)]);
  player.tick(0, true);
  assert.ok(ctx().sources[0].stopped);
  near(started(ctx())[1].when, 10 + 0.12 - SOUND_PEAKS.pop);
  player.show({ sceneId: 'outro', duration: 4, scenes: 1 });
  assert.ok(ctx().sources[1].stopped);
  player.tick(0, true);
  assert.equal(ctx().sources.length, 2);
  // Back on the scene of the last message: its cues hold again.
  player.show({ sceneId: 'intro', duration: 4, scenes: 1 });
  player.tick(0, true);
  assert.equal(ctx().sources.length, 3);
});

test('a burst of messages is planned once, at the next tick, from the last one', async () => {
  const { player, ctx } = await setup([pop(0.1)]);
  player.tick(0, true);
  player.receive('intro', [pop(0.12)]);
  player.receive('intro', [pop(0.13)]);
  assert.equal(ctx().sources[0].stopped, false, 'nothing is parsed before the tick');
  player.tick(0, true);
  assert.ok(ctx().sources[0].stopped);
  assert.equal(started(ctx()).length, 2);
  near(started(ctx())[1].when, 10 + 0.13 - SOUND_PEAKS.pop);
});

test('the message of another scene is ignored, and a new frame forgets the previous one', async () => {
  const { player, ctx } = await setup([pop(0.1)]);
  player.receive('outro', [pop(0.1)]);
  player.tick(0, true);
  assert.equal(ctx().sources.length, 0);
  player.receive(null, [pop(0.1)]);
  player.tick(0, true);
  assert.equal(ctx().sources.length, 0);
  player.receive('intro', [pop(0.1)]);
  player.forget();
  player.tick(0, true);
  assert.equal(ctx().sources.length, 0);
});

test('cues are checked again: an invalid message plays nothing', async () => {
  for (const cues of [
    'nope',
    [{ at: 4.5, sound: 'pop' }],
    [{ at: 0.1, sound: 'boom' }],
    [{ at: 0.1, sound: 'pop', gain: 2 }],
    Array.from({ length: 1001 }, () => pop(0.1)),
  ]) {
    const { player, ctx } = await setup(cues);
    player.tick(0, true);
    assert.equal(ctx().sources.length, 0, JSON.stringify(cues).slice(0, 80));
  }
  // The whole video takes up to 1000 cues per scene, past the video's last millisecond.
  const whole = { sceneId: null, duration: 4, scenes: 2 };
  const { player, ctx } = await setup([...Array.from({ length: 1999 }, () => pop(3)), pop(4.0005)], whole, 2.9);
  player.tick(2.9, true);
  for (const source of ctx().sources) source.onended?.();
  player.tick(3.9, true);
  assert.equal(ctx().sources.length, 65);
});

test('at most 64 sounds play at once, however many cues share an instant', async () => {
  const { player, ctx } = await setup(Array.from({ length: 999 }, () => pop(0.1)).concat(pop(0.3)));
  player.tick(0, true);
  assert.equal(ctx().sources.length, 64);
  player.tick(0.01, true);
  assert.equal(ctx().sources.length, 64);
  for (const source of ctx().sources) source.onended?.();
  player.tick(0.2, true);
  assert.equal(ctx().sources.length, 65);
});

test('closing stops the sounds and the context; the next play opens a new one', async () => {
  const { player, ctx, contexts } = await setup([pop(0.1)]);
  player.tick(0, true);
  player.close();
  assert.ok(contexts[0].sources[0].stopped);
  assert.ok(contexts[0].closed);
  player.tick(0, true);
  assert.equal(contexts[0].sources.length, 1);
  player.play(0);
  assert.equal(contexts.length, 2);
  player.tick(0, true);
  assert.equal(ctx().sources.length, 1);
});

test('the library is fetched and decoded once per page for every player, and again after a failure', async (t) => {
  let fetches = 0;
  let offline = true;
  t.mock.method(globalThis, 'fetch', async () => {
    fetches++;
    if (offline) throw new Error('offline');
    return new Response(new ArrayBuffer(8));
  });
  Object.assign(globalThis, {
    OfflineAudioContext: class {
      decodeAudioData = async () => ({ duration: 0.2 });
    },
  });
  t.after(() => delete (globalThis as { OfflineAudioContext?: unknown }).OfflineAudioContext);
  const open = () => new FakeContext() as unknown as AudioOut;
  const preview = new SoundPlayer(open);
  preview.show({ sceneId: 'intro', duration: 4, scenes: 1 });
  preview.receive('intro', [pop(0.1)]);
  await flush();
  assert.equal(fetches, 5);
  offline = false;
  preview.play(0);
  await flush();
  assert.equal(fetches, 10);
  const present = new SoundPlayer(open);
  present.show({ sceneId: null, duration: 4, scenes: 1 });
  present.receive(null, [pop(0.1)]);
  present.play(0);
  await flush();
  assert.equal(fetches, 10, 'Present reuses what the preview decoded');
});

test('a failed load is not tried again for each message, only at the next play', async () => {
  let loads = 0;
  const { player } = makePlayer(async () => {
    loads++;
    throw new Error('offline');
  });
  player.show({ sceneId: 'intro', duration: 4, scenes: 1 });
  player.receive('intro', [pop(0.1)]);
  await flush();
  for (let i = 0; i < 100; i++) player.receive('intro', [pop(0.1 + i / 1000)]);
  await flush();
  assert.equal(loads, 1);
  player.play(0);
  await flush();
  assert.equal(loads, 2);
});

test('a malformed or oversized message is not kept: it plays nothing and loads nothing', async () => {
  let loads = 0;
  const fresh = makePlayer(async () => {
    loads++;
    return LIBRARY;
  });
  fresh.player.show({ sceneId: 'intro', duration: 4, scenes: 1 });
  fresh.player.receive(
    'intro',
    Array.from({ length: 10_001 }, () => pop(0.1)),
  );
  fresh.player.receive({ id: 'intro' }, [pop(0.1)]);
  await flush();
  assert.equal(loads, 0);

  const { player, ctx } = await setup([pop(0.1)]);
  player.tick(0, true);
  player.receive('intro', 'nope');
  player.tick(0.01, true);
  player.reset(0);
  player.tick(0, true);
  assert.equal(ctx().sources.length, 1);
  assert.ok(ctx().sources[0].stopped);
});

test('the same cues posted again leave the sounds already playing alone', async () => {
  const cues = [{ at: 0.5, sound: 'impact' }];
  const { player, ctx } = await setup(cues);
  for (const t of [0.4, 0.483, 0.5]) player.tick(t, true);
  player.receive('intro', structuredClone(cues));
  player.tick(0.516, true);
  assert.equal(started(ctx()).length, 1);
  assert.equal(ctx().sources[0].stopped, false);
});

test('after a long dropped frame, a late peak lands at most 0.1 s after its cue', async () => {
  const { player, ctx } = await setup([{ at: 1, sound: 'whoosh' }]);
  for (const t of [0, 0.4, 1.05]) player.tick(t, true);
  assert.equal(started(ctx()).length, 1);
  assert.equal(started(ctx())[0].when, 10);
  near(started(ctx())[0].offset, 0.95 - (1 - SOUND_PEAKS.whoosh));
});

test('a new frame forgets the cues of the previous one, even at the next play', async () => {
  const { player, ctx } = await setup([pop(0.1)]);
  player.tick(0, true);
  player.forget();
  player.tick(0.01, true);
  player.play(0);
  player.tick(0, true);
  assert.equal(ctx().sources.length, 1);
});

test('changed cues do not start again a sound the playhead has passed', async () => {
  const { player, ctx } = await setup([pop(0.1)]);
  player.tick(0, true);
  player.tick(0.15, true);
  player.receive('intro', [pop(0.1), { at: 2, sound: 'click' }]);
  player.tick(0.166, true);
  assert.equal(started(ctx()).length, 1);
});

test('nothing is scheduled until the context runs, and the cues owed since play then play late', async () => {
  const { player, ctx } = makePlayer(undefined, 'waits');
  player.show({ sceneId: 'intro', duration: 4, scenes: 1 });
  player.receive('intro', [pop(0)]);
  player.play(0);
  await flush();
  player.tick(0.016, true);
  assert.equal(ctx().sources.length, 0);
  ctx().wake();
  await flush();
  player.tick(0.05, true);
  assert.equal(started(ctx()).length, 1);
  assert.equal(started(ctx())[0].when, 10);
  near(started(ctx())[0].offset, SOUND_PEAKS.pop);
});
