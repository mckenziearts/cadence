import type fr from '../fr/api';

export default {
  projectNotFound: (id: string) => `Project not found: ${id}`,
  sceneNotFound: (id: string) => `Scene not found: ${id}`,
  fileNotFound: (file: string) => `File not found: ${file}`,
  unknownFormat: (format: unknown) => `Unknown format: ${format}`,
  unreadableFile: (file: string, error: string) => `Could not read ${file}: ${error}`,
  invalidFile: (file: string, issues: string) => `Invalid ${file}: ${issues}`,
  internalError: (error: string) => `Internal error: ${error}`,
  ids: {
    id: 'id',
    project: 'project id',
    scene: 'scene id',
    brand: 'brand id',
    template: 'template id',
  },
  util: {
    invalidPath: (rel: string) => `Invalid path: ${rel}`,
    invalidId: (what: string, id: string) => `Invalid ${what}: ${id}`,
  },
  routes: {
    fileNotFound: 'File not found',
    errorLog: '[cadence] API error:',
    unknownRoute: (method: string, path: string) => `Unknown route: ${method} ${path}`,
    tooLarge: 'Request too large',
    eventsUnavailable: 'Event stream unavailable',
    rendering: 'A render of this project is running: cancel it first.',
    publishing: 'A video of this project is being sent to a network: wait for the upload to finish.',
    videoSending: 'This video is being sent to a network: wait for the upload to finish before deleting it.',
    noMusic: 'This project has no music',
    imageName: (name: string) => `Invalid image name: ${name}`,
    gitHost: (host: string) => `Unknown Git host: ${host}`,
    captureHost: (host: string) => `Invalid host: ${host}`,
    logoVariant: (variant: string) => `Unknown logo variant: ${variant}`,
    defaultBrand: 'The neutral Cadence brand cannot be deleted: new brands start from it.',
    brandInUse: (projects: string[]) => {
      const names = projects.map((name) => `"${name}"`);
      return names.length === 1
        ? `The project ${names[0]} uses this brand: delete it or change its brand first.`
        : `The projects ${names.join(', ')} use this brand: delete them or change their brand first.`;
    },
    agentBusy: (agent: string | null) => `${agent ?? 'Our AI'} is working on this project: stop the current answer first.`,
    invalidJson: 'Invalid JSON request body',
    issue: (path: string, message: string) => `${path}: ${message}`,
    invalidBody: (issues: string[]) => `Invalid request: ${issues.join('; ')}`,
    rangeOrder: 'the end must come after the start',
    fileTooLarge: (mb: number) => `File too large (${mb} MB max)`,
    invalidUpload: 'Invalid file upload (multipart/form-data expected)',
    noFile: 'No file received ("file" field)',
    unknownChat: (key: string) => `Unknown chat: ${key}`,
    unknownNetwork: (id: string) => `Unknown network: ${id}`,
    missingParam: (name: string) => `Missing "${name}" parameter`,
    invalidParam: (name: string, value: string) => `Invalid "${name}" parameter: ${value}`,
  },
  versions: {
    initial: 'Initial state',
    templateInserted: (scene: string) => `Template inserted: ${scene}`,
    projectEdited: 'Project edited',
    artDirectionEdited: 'Art direction edited',
    sceneAdded: (scene: string) => `Scene added: ${scene}`,
    sceneEdited: (scene: string) => `Scene edited: ${scene}`,
    sceneDeleted: 'Scene deleted',
    scenesReordered: 'Scenes reordered',
    musicAdded: (file: string) => `Music added: ${file}`,
    musicChosen: (file: string) => `Music chosen: ${file}`,
    musicEdited: 'Music settings edited',
    musicRemoved: 'Music removed',
    cutsSnapped: 'Cuts snapped to the music',
    manual: 'Manual save',
    unsaved: 'Unsaved changes',
    untitled: 'Untitled version',
    restoredScene: (scene: string, version: string) => `Restored "${scene}" (${version})`,
    restored: (version: string) => `Restored ${version}`,
    undone: (label: string) => `Undone: ${label}`,
    redone: (label: string) => `Redone: ${label}`,
    notSaved: (error: string) => `[cadence] version not saved: ${error}`,
    sceneMissing: (scene: string, version: string) => `The scene "${scene}" does not exist in version ${version}`,
    sceneGone: (scene: string) => `The scene "${scene}" no longer exists in the project: restore the whole version`,
    notFound: (version: string) => `Version not found: ${version}`,
    unreadableIndex: (file: string) => `Could not read the version history: ${file}`,
    unreadableManifest: (version: string) => `Could not read version ${version} (manifest missing or corrupted)`,
    invalidHash: (hash: string) => `Invalid hash in the history: ${hash}`,
    missingObject: (hash: string) => `Missing content in the history: ${hash}`,
    linkedFolder: (file: string) => `Restore refused: "${file}" goes through a symbolic link. Remove the link, then try again.`,
  },
  projects: {
    skipped: (error: string) => `[cadence] project skipped: ${error}`,
    names: { project: 'Project name', scene: 'Scene name' },
    nameRequired: (what: string) => `${what} is required`,
    nameTooLong: (what: string) => `${what} is too long (120 characters max)`,
    unknownBrand: (brand: string) => `Unknown brand: ${brand}`,
    exists: (id: string) => `The project "${id}" already exists`,
    starterScene: 'Title',
    codeTooLarge: 'Scene code too large (1 MB max)',
    sceneFileNotFound: (file: string) => `Scene file not found: ${file}`,
    copy: (name: string) => `${name} (copy)`,
    lastScene: 'A project must keep at least one scene',
    order: 'The new order must hold each scene exactly once',
    music: (issues: string) => `Invalid music settings: ${issues}`,
    relativePath: 'expected a path relative to the project',
    duplicateScene: (id: string) => `duplicate scene "${id}"`,
    musicGrid: (id: string, error: string) => `[cadence] music grid unavailable (${id}): ${error}`,
    voiceOver: (id: string, error: string) => `[cadence] voice-over unavailable (${id}): ${error}`,
    voiceOverSettings: (issues: string) => `Invalid voice-over settings: ${issues}`,
    sceneVoiceOver: (issues: string) => `Invalid voice-over: ${issues}`,
    duplicateSpeaker: (id: string) => `the speaker id "${id}" is used twice`,
    speakerName: 'a name without control or invisible formatting characters',
    scriptTooLong: (max: number) => `the lines add up to more than ${max} characters`,
    textOrLines: 'a text or lines, not both',
    unknownSpeaker: (id: string) => `Unknown speaker: "${id}" (add it to the voice-over settings first)`,
    speakerInUse: (id: string, scene: string) => `The speaker "${id}" still says lines in the scene "${scene}"`,
    outsideProject: (folder: string) => `The project's ${folder}/ folder points outside the project: nothing was written`,
    reload: (id: string, error: string) => `[cadence] could not reload the code (${id}): ${error}`,
    pickFormat: 'Choose at least one format',
    fps: (value: unknown) => `Invalid frame rate: ${value} (24, 30 or 60)`,
    language: (value: unknown) => `Invalid language: ${String(value)} (fr, en or null)`,
    tempo: (value: unknown) => `Invalid tempo: ${value} (between 30 and 300 BPM)`,
    captions: (value: unknown) => `Invalid captions setting: ${String(value)} (true or false)`,
    duration: (value: unknown) => `Invalid duration: ${value}`,
    root: 'root',
    artDirection: `# Art direction

This document is reread before every change. Describe here the style all scenes share.

## Palette
- Background: the brand's \`background\` color; cards and panels in \`surface\`.
- Main text in \`ink\`, secondary text in \`muted\`, dividers in \`line\`.
- \`primary\` for the main action and the key moments; \`accent\` sparingly, for annotations.

## Typography
- Titles in the \`display\` font: 96 to 160 px in 16:9, weight 600 to 700, tight letter spacing (-0.03 to -0.045 em), line height 1.0 to 1.1.
- Text and interfaces in the \`body\` font (20 to 32 px); numbers and code in \`mono\`.
- One idea per scene, eight words at most per title.

## Motion
- Calm and precise. Entrances of 0.5 to 0.9 s that decelerate (ease.outExpo, springs for interface objects).
- Shorter exits (0.25 to 0.4 s) that accelerate.
- Offset related elements by 40 to 70 ms; start the next movement before the previous one has settled.
- Time the key moments to the music (beats, bars, phrases) rather than to fixed seconds.

## Layout
- Generous margins (at least 8% of the frame), centered compositions unless stated otherwise.
- Each scene adapts to every format of the project with \`useFormat()\`: no text cut off in 9:16.

## Cuts
- Invisible cuts: when an object carries on from one scene to the next, the last frame of the scene is identical to the first frame of the next one.
`,
  },
  assets: {
    unsupported: (name: string) =>
      `Unsupported file type: ${name} (PNG, JPEG, WebP, GIF or SVG images, WOFF, WOFF2, TTF or OTF fonts)`,
    empty: (name: string) => `Empty file: ${name}`,
    tooLarge: (name: string) => `File too large: ${name} (50 MB max)`,
    invalidUrl: (url: string) => `Invalid URL: ${url}`,
    httpOnly: (url: string) => `Only http:// and https:// URLs can be captured: ${url}`,
    unknownDevice: (device: string) => `Unknown device: ${device}`,
    captureFailed: (url: string, error: string) => `Could not capture ${url}: ${error}`,
  },
  brands: {
    hex: 'expected a #rrggbb color',
    notFound: (id: string) => `Brand not found: ${id}`,
    skipped: (error: string) => `[cadence] brand skipped: ${error}`,
    building: 'This brand is being built: cancel the build first.',
  },
  archives: {
    projectUnreadable: (ids: string) => `Cannot read project.json of ${ids}: fix or delete it before exporting.`,
    brandLinked: (brand: string) => `The folder of the brand "${brand}" is a link: an export only reads real folders.`,
    brandMissing: (brand: string) => `The brand "${brand}" is not on this computer: its projects cannot be exported without it.`,
    unreadable: (detail: string) => `This file is not a readable Cadence archive (${detail}).`,
    refused: (detail: string) => `Archive refused: ${detail}`,
    tooLarge: (detail: string) => `Archive too large: ${detail}`,
    collision: (entry: string) => `Archive refused: ${entry} collides with another file of the archive.`,
    cssCodeExec: (entry: string) =>
      `Archive refused: ${entry} contains @plugin or @config, which would run code while the CSS compiles.`,
    cssImport: (entry: string) =>
      `Archive refused: ${entry} imports a file that is not a stylesheet, which Tailwind would read as CSS.`,
    brandFolderTaken: (brand: string) =>
      `The folder brands/${brand}/ exists on this computer but holds no brand: remove it, then import again.`,
    manifestFirst: 'Archive refused: manifest.json must be its first file. Choose an archive exported by Cadence.',
    manifestInvalid: (detail: string) => `Archive refused: manifest.json is invalid (${detail}).`,
    newerFormat: (createdWith: string) =>
      `This archive comes from Cadence ${createdWith}, newer than this installation: update Cadence to import it.`,
    unexpectedEntry: (entry: string) => `Archive refused: ${entry} belongs to no project or brand of the manifest.`,
    projectMissing: (id: string) => `Archive refused: the project "${id}" has no project.json.`,
    projectInvalid: (id: string, issues: string) =>
      `Archive refused: the project.json of the project "${id}" is invalid: ${issues}`,
    brandUnavailable: (brand: string, project: string) =>
      `Archive refused: the project "${project}" uses the brand "${brand}", which is neither in the archive nor on this computer.`,
    brandIncomplete: (brand: string, problems: string) => `Archive refused: the brand "${brand}" is incomplete: ${problems}`,
    brandBuilding: (brand: string) =>
      `The brand "${brand}" is being built on this computer: wait for the end or cancel the build, then import again.`,
  },
  templates: {
    sceneSkipped: (error: string) => `[cadence] scene template skipped: ${error}`,
    projectSkipped: (error: string) => `[cadence] project template skipped: ${error}`,
    sceneNotFound: (id: string) => `Scene template not found: ${id}`,
    projectNotFound: (id: string) => `Project template not found: ${id}`,
    missingCode: (file: string) => `Missing ${file}`,
    sceneNames: 'one name per scene',
  },
  frames: {
    method: 'Method not allowed',
    forbidden: 'A frame reads only its own project or brand and the templates',
    notServed: (file: string) => `${file} is outside this project, its brand and the templates: the frame does not load it`,
  },
  server: {
    starting: 'Cadence is starting...',
    portInUse: (address: string) => `Address ${address} is already in use: stop the other program or choose another port.`,
    stopChats: (error: string) => `[cadence] stopping the chats: ${error}`,
    stopBrandBuilds: (error: string) => `[cadence] stopping the brand builds: ${error}`,
    closeChromium: (error: string) => `[cadence] closing Chromium: ${error}`,
    closeVite: (error: string) => `[cadence] closing Vite: ${error}`,
    projects: 'Projects',
    agentUnavailable: (detail: string) => `unavailable: ${detail}`,
    mcpHint: '(npm run cadence -- mcp to add it to Claude Code)',
  },
} satisfies typeof fr;
