import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildSystemPrompt, writeProjectsGuide } from '../../server/agent/guide';
import { barSeconds, buildTurnPrompt, projectOverview } from '../../server/agent/prompts';
import type { CadenceConfig } from '../../server/contracts';
import type { ProjectState } from '../../src/shared/types';

test('the system prompt carries the guide, the runtime reference and one scope', () => {
  const scene = buildSystemPrompt({ scope: 'scene' });
  const project = buildSystemPrompt({ scope: 'project' });
  for (const prompt of [scene, project]) {
    assert.match(prompt, /^# Cadence\n/);
    assert.match(prompt, /## Craft/);
    assert.match(prompt, /# `cadence` runtime/);
    assert.doesNotMatch(prompt, /\{\{(RUNTIME_API|SCOPE)\}\}|<!-- scope|## Scope: terminal/);
  }
  // Rules the renders depend on: seam threshold (as check_seams reports it), motion checks, text is layout, locales,
  // frozen images, the text checks of render_frames.
  for (const rule of [
    /under 0\.05 % of pixels is invisible/,
    /Run `check_motion` on each scene you created or retimed before answering/,
    /"<scene> does not move" is a failure[^\n]*still stretches of about 2 s or more \(measured between samples[^\n]*A beat pulse \(`music\.pulse`\) counts as motion; an animated `Grain` \(with `t`\) makes the check pass but is texture, not motion: the scene must still move on its own/,
    /Changing on-screen text \(copy, language, size\) is a layout change/,
    /explicit locale to `Intl\.\*` and `toLocale\*\(\)`/,
    /Animated GIF, WebP and SVG images freeze on their first frame in renders/,
    /`Checks at <t> s \(<format>\):`[^\n]*fix each one or say in your answer why it is deliberate[^\n]*clip-path or mask is not checked at all\. "unavailable" means the checks could not run/,
  ]) {
    assert.match(scene, rule);
  }
  assert.match(scene, /## Scope: scene chat/);
  assert.doesNotMatch(scene, /## Scope: project chat/);
  assert.match(project, /## Scope: project chat/);
  assert.doesNotMatch(project, /## Scope: scene chat/);
});

test('projects/CLAUDE.md is written for terminal sessions and left alone once the user owns it', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cadence-guide-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = { projectsDir: path.join(root, 'projects') } as CadenceConfig;
  await fs.mkdir(config.projectsDir);
  const file = path.join(config.projectsDir, 'CLAUDE.md');

  await writeProjectsGuide(config);
  const written = await fs.readFile(file, 'utf8');
  assert.match(written, /^<!-- cadence:managed-guide/);
  assert.match(written, /## Scope: terminal session/);
  assert.doesNotMatch(written, /## Scope: (scene|project) chat/);

  await fs.writeFile(file, written.replace('## Craft', '## Old craft'));
  await writeProjectsGuide(config);
  assert.equal(await fs.readFile(file, 'utf8'), written, 'managed copies are refreshed');

  await fs.writeFile(file, '# Mes notes\n');
  await writeProjectsGuide(config);
  assert.equal(await fs.readFile(file, 'utf8'), '# Mes notes\n');
});

test('the turn context: timing in bars, playhead in video time, brief only when new', () => {
  const dir = '/p/demo';
  const project: ProjectState = {
    id: 'demo',
    dir,
    name: 'Démo',
    brand: 'orbit',
    fps: 30,
    formats: ['9:16'],
    tempo: 120,
    language: null,
    scenes: ['intro', 'outro'].map((id, index) => ({
      id,
      name: id === 'intro' ? 'Intro | hook' : 'Outro',
      duration: 4,
      index,
      start: index * 4,
      file: `${dir}/scenes/${id}.tsx`,
      url: '',
      codeVersion: '',
    })),
    duration: 8,
    music: { file: 'music/a.mp3', start: 0, volume: 1 },
    musicUrl: null,
    musicGrid: {
      bpm: 90,
      beatsPerBar: 3,
      beats: [],
      downbeats: [],
      phrases: [],
      sections: [],
      accents: [],
      waveform: [],
      duration: 30,
      confidence: 1,
    },
    voiceOver: { voice: 'fr_FR-siwis-medium', speed: 1, musicLevel: 0.3 },
    voiceOverUrl: null,
    voiceOverLines: [],
    voiceOverPending: [],
    voiceOverError: null,
    captions: false,
    codeGeneration: 1,
    createdAt: '',
    updatedAt: '',
  };
  assert.equal(barSeconds(project), 2);
  const overview = projectOverview(project);
  assert.match(overview, /music at 90 BPM, 3 beats per bar, 1 bar = 2\.000 s/);
  assert.match(overview, /\| 1 \| intro \| Intro \/ hook \| 0\.000 \| 4\.000 \| 2 \|/);

  const context = {
    project,
    scene: null,
    text: 'Resserre le rythme',
    playhead: { sceneId: null, t: 5.5, format: '9:16' as const },
    brief: null,
    music: '',
    seams: [],
    errors: null,
    references: [],
    dirs: { brand: '/b', templates: '/t', runtime: '/r' },
  };
  const prompt = buildTurnPrompt(context);
  assert.match(prompt, /This is the project chat/);
  assert.match(prompt, /looking at video time 5\.500 s \(scene outro at 1\.500 s\), format 9:16\./);
  assert.match(prompt, /Seams: not checked yet\./);
  assert.match(prompt, /unchanged since earlier in this conversation/);
  assert.doesNotMatch(prompt, /<brand>|<art_direction>|Render errors|Music:/);
  assert.ok(prompt.endsWith('</cadence_context>\n\nResserre le rythme'));

  // On-screen language: the project's setting, else the brand's.
  assert.match(buildTurnPrompt({ ...context, brandLanguage: 'en' }), /\nOn-screen language: English \(brand default\)\.\n/);
  const french = { ...project, language: 'fr' as const };
  assert.match(
    buildTurnPrompt({ ...context, project: french, brandLanguage: 'en' }),
    /\nOn-screen language: French \(project setting\)\.\n/,
  );
  assert.match(projectOverview(french), /On-screen language: French \(project setting\)\./);
  assert.doesNotMatch(projectOverview(project), /On-screen language/);
});

test('the voice-over in the context: sentence times in scene seconds, pending scenes, a voice longer than its scene', () => {
  const dir = '/p/demo';
  const scenes = ['intro', 'outro', 'logo'].map((id, index) => ({
    id,
    name: id,
    duration: 4,
    index,
    start: index * 4,
    file: `${dir}/scenes/${id}.tsx`,
    url: '',
    codeVersion: '',
    ...(id === 'logo' ? {} : { voiceOver: { text: id === 'intro' ? 'Un. Deux.' : 'Trois.', at: 0.5 } }),
  }));
  const project: ProjectState = {
    id: 'demo',
    dir,
    name: 'Démo',
    brand: null,
    fps: 30,
    formats: ['16:9'],
    tempo: 120,
    language: null,
    scenes,
    duration: 12,
    music: null,
    musicUrl: null,
    musicGrid: null,
    voiceOver: { voice: 'fr_FR-siwis-medium', speed: 1.2, musicLevel: 0.25 },
    voiceOverUrl: '/api/projects/demo/voice-over/audio?v=1',
    voiceOverLines: [
      { sceneId: 'intro', text: 'Un.', start: 0.5, end: 2, speaker: null, words: [], level: [] },
      { sceneId: 'intro', text: 'Deux.', start: 2, end: 4.6, speaker: null, words: [], level: [] },
    ],
    voiceOverPending: ['outro'],
    voiceOverError: null,
    captions: false,
    codeGeneration: 1,
    createdAt: '',
    updatedAt: '',
  };
  const overview = projectOverview(project);
  assert.match(overview, /\nVoice-over \(voice fr_FR-siwis-medium, speed 1\.2, music at 25 % while it speaks\)/);
  assert.match(
    overview,
    /\n- intro: 0\.500-2\.000 "Un\." \/ 2\.000-4\.600 "Deux\."; it runs 0\.600 s past the end of the scene\n/,
  );
  assert.match(overview, /\n- outro: from 0\.500 s, "Trois\." \(not generated yet, so no timing\)$/);
  assert.doesNotMatch(overview, /- logo/);

  const context = {
    project,
    scene: project.scenes[1],
    text: 'Cale le titre sur la voix',
    brief: null,
    music: '',
    seams: [],
    errors: null,
    references: [],
    dirs: { brand: '/b', templates: '/t', runtime: '/r' },
  };
  const prompt = buildTurnPrompt(context);
  assert.match(prompt, /\n- outro: from 0\.500 s, "Trois\."/);
  assert.doesNotMatch(prompt, /- intro:/, 'a scene chat sees its own voice-over only');
  assert.doesNotMatch(buildTurnPrompt({ ...context, scene: project.scenes[2] }), /Voice-over/);

  const dialogue: ProjectState = {
    ...project,
    scenes: project.scenes.map((s) =>
      s.id === 'outro'
        ? {
            ...s,
            voiceOver: {
              text: 'Trois.\nQuatre.',
              at: 0.5,
              lines: [
                { id: 'trois', speaker: 'camille', text: 'Trois.' },
                { id: 'quatre', speaker: 'sami', text: 'Quatre.' },
              ],
            },
          }
        : s,
    ),
    voiceOver: {
      engine: 'elevenlabs',
      voice: 'voice-narrator',
      model: 'eleven_v3',
      speed: 1,
      musicLevel: 0.3,
      speakers: [
        { id: 'camille', name: 'Camille', voice: 'voice-camille' },
        { id: 'sami', name: 'Sami', voice: 'voice-sami', model: 'eleven_multilingual_v2' },
      ],
    },
    voiceOverLines: [
      { sceneId: 'intro', text: 'Un.', start: 0.5, end: 2, speaker: 'camille', words: [], level: [] },
      { sceneId: 'intro', text: 'Deux.', start: 2.2, end: 3, speaker: 'sami', words: [], level: [] },
    ],
  };
  const spoken = projectOverview(dialogue);
  assert.match(
    spoken,
    /\nVoice-over \(ElevenLabs voice voice-narrator, model eleven_v3, speed 1, music at 30 % while it speaks\)/,
  );
  assert.match(
    spoken,
    /\nSpeakers: camille "Camille" \(voice voice-camille\), sami "Sami" \(voice voice-sami, model eleven_multilingual_v2\)\n/,
  );
  assert.match(spoken, /\n- intro: 0\.500-2\.000 camille: "Un\." \/ 2\.200-3\.000 sami: "Deux\."\n/);
  assert.match(spoken, /\n- outro: from 0\.500 s, camille: "Trois\." \/ sami: "Quatre\." \(not generated yet, so no timing\)$/);

  const silent: ProjectState = { ...dialogue, scenes: dialogue.scenes.map(({ voiceOver: _, ...s }) => s), voiceOverLines: [] };
  assert.match(projectOverview(silent), /\nSpeakers: camille "Camille"/, 'the speakers show before any scene has a voice-over');
});
