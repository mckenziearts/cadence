import type { SeamResult } from '../../../src/shared/types';
import type fr from '../fr/agent';

export default {
  internalError: (error: string) => `Internal error: ${error}`,
  refused: 'Our AI refused the connection: try again.',
  chat: {
    invalidKey: (key: string) => `Invalid chat: ${key}`,
    empty: 'The message is empty.',
    invalidModel: (model: string) => `Invalid model: ${model}`,
    invalidEffort: (effort: string) => `Invalid effort level: ${effort}`,
    stopping: 'Cadence is shutting down.',
    busy: (agent: string | null) => `${agent ?? 'Our AI'} is still working on the previous message of this chat.`,
    sceneNotFound: (sceneId: string) => `Scene not found: ${sceneId}`,
    stopFirst: 'Stop the current answer first.',
    projectNotFound: (projectId: string) => `Project not found: ${projectId}`,
    interrupted: 'Answer interrupted: Cadence stopped while it was being written.',
    sceneGone: (sceneId: string) => `Scene "${sceneId}" no longer exists.`,
    outsideChanges: 'Changes outside the chat',
    failed: (agent: string | null) => `${agent ?? 'Our AI'} stopped on an error.`,
    seam: (r: SeamResult) =>
      `${r.from} to ${r.to} (${r.format}): ${r.diffPercent.toFixed(2)}%${r.error ? ` (error: ${r.error})` : ''}`,
    notSaved: '[cadence] Chat not saved:',
    turnFailed: '[cadence] Chat turn failed:',
    wrapUpFailed: (projectId: string, key: string) => `[cadence] End of turn (${projectId}, ${key}):`,
    activity: {
      file: 'a file',
      scene: 'the scene',
      video: 'the video',
      page: 'the page',
      read: (file: string) => `Reading ${file}`,
      edit: (file: string) => `Editing ${file}`,
      glob: (pattern: string) => `Finding files (${pattern})`,
      grep: (pattern: string) => `Searching for "${pattern}"`,
      render: (count: number, of: string | null, format: string | null) =>
        `Rendering ${count === 1 ? '1 frame' : `${count} frames`}${of === null ? '' : ` of ${of}`}${format === null ? '' : ` (${format})`}`,
      seams: 'Checking cuts',
      motion: 'Checking motion',
      project: 'Reading the project structure',
      brand: 'Reading the brand',
      music: 'Reading the music grid',
      templates: 'Listing templates',
      duration: (duration: string) => `Duration set to ${duration}`,
      voiceOver: (cleared: boolean) => (cleared ? 'Voice-over removed' : 'Voice-over written and generated'),
      version: (label: string) => `Version "${label}"`,
      newScene: (name: string) => `New scene "${name}"`,
      duplicate: (scene: string) => `Duplicating ${scene}`,
      remove: (scene: string) => `Deleting ${scene}`,
      move: (scene: string, position: string) => `Moving ${scene} to position ${position}`,
      rename: (scene: string, name: string) => `Renaming ${scene} to "${name}"`,
      grids: { beat: 'beats', bar: 'bars', phrase: 'phrases' },
      grid: 'the grid',
      snap: (grid: string) => `Cuts snapped to ${grid}`,
      capture: (url: string) => `Capturing ${url}`,
    },
  },
  claudeCode: {
    notLoggedIn: 'Claude Code is not logged in to your Claude account: open a terminal, run "claude" then /login, and try again.',
    exitCode: (code: number) => `exit code ${code}`,
    notFound: (bin: string, error: string) =>
      `Claude Code not found ("${bin}"): install it and log in, or set CLAUDE_PATH. (${error})`,
    loggedIn: (how: string) => `Logged in (${how})`,
    spawnFailed: (bin: string, error: string) =>
      `Could not start Claude Code ("${bin}"): ${error}. Install Claude Code or set CLAUDE_PATH.`,
    stopped: 'Stopped.',
    crashed: (agent: string | null, code: number | null, tail: string) =>
      `${agent ?? 'Our AI'} stopped unexpectedly${code === null ? '' : ` (code ${code})`}${tail ? `:\n${tail}` : '.'}`,
    returnedError: (agent: string | null, kind: string, text: string) =>
      `${agent ?? 'Our AI'} returned an error${kind}${text ? `: ${text}` : '.'}`,
  },
  codex: {
    notLoggedIn: 'Codex is not logged in: open a terminal, run "codex login", then try again.',
    exitCode: (code: number) => `exit code ${code}`,
    notFound: (bin: string, error: string) => `Codex not found ("${bin}"): install it and log in, or set CODEX_PATH. (${error})`,
    loggedIn: 'Logged in to ChatGPT',
    spawnFailed: (bin: string, error: string) => `Could not start Codex ("${bin}"): ${error}. Install Codex or set CODEX_PATH.`,
    stopped: 'Stopped.',
    crashed: (agent: string | null, code: number | null, tail: string) =>
      `${agent ?? 'Our AI'} stopped unexpectedly${code === null ? '' : ` (code ${code})`}${tail ? `:\n${tail}` : '.'}`,
  },
  grok: {
    notFound: (bin: string, error: string) => `Grok not found ("${bin}"): install it, or set GROK_PATH. (${error})`,
    installed: 'Installed, connect it',
  },
  gemini: {
    notFound: (bin: string, error: string) => `Gemini not found ("${bin}"): install it, or set GEMINI_PATH. (${error})`,
    installed: 'Installed, connect it',
  },
  mcpServer: {
    method: 'Method not allowed: the Cadence MCP only accepts POST.',
    browser: 'Request refused: the Cadence MCP does not accept calls from a browser.',
    token: 'Missing, invalid or expired MCP token.',
    tooLarge: 'Request too large.',
    badJson: 'Invalid JSON body.',
    internalError: (error: string) => `MCP internal error: ${error}`,
  },
  mcpTools: {
    noScene: (sceneId: string, projectId: string, scenes: string[]) =>
      `No scene "${sceneId}" in ${projectId}. Scenes: ${scenes.join(', ') || 'none'}.`,
    otherProject: (projectId: string) => `This chat can only act on project "${projectId}".`,
    projectIdNeeded: (projects: string[]) =>
      `Pass projectId (the folder name under projects/). Projects: ${projects.join(', ') || 'none'}.`,
    otherScene: (sceneId: string, denied: string) => `This chat is limited to scene "${sceneId}": ${denied}`,
    sceneIdNeeded: (scenes: string[]) => `Pass sceneId. Scenes: ${scenes.join(', ') || 'none'}.`,
    sceneOrVideo: 'Choose sceneId or wholeVideo, not both.',
    timesOrStrip: 'Pass either times or strip, not both.',
    renderOwnScene: 'render your scene, or the whole video with wholeVideo: true.',
    checkOwnSeams: 'check the cuts of your scene.',
    checkOwnMotion: 'check the motion of your scene.',
    setOwnDuration: 'change the duration of your scene; the project chat sets the others.',
    setOwnVoiceOver: 'set the voice-over of your scene; the project chat sets the others.',
    badUrl: (url: string) => `Invalid URL: ${url} (only http(s) URLs can be captured).`,
  },
  mcpTokens: {
    listenerFailed: '[cadence] An MCP activity listener failed:',
  },
} satisfies typeof fr;
