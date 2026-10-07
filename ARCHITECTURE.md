# Cadence architecture

Cadence is a local, prompt-driven motion-design studio for marketing videos. A video is an ordered list of
scenes; every scene is a React component that renders one frame for a given time `t`. You describe changes in a
chat next to a live preview; Claude (through the local Claude Code CLI) edits the scene, renders frames to check
its own work, and the preview updates. Videos are branded (brand kits), multi-format (16:9, 9:16, 1:1, 4:5),
synced to music (beat/bar/phrase grid), versioned, and exported to MP4.

Inspired by Caleb Porzio's "Storyboard" editor and by Saeed Vaziry's MIT reconstruction
(github.com/saeedvaziry/caleb-video-editor). Cadence is a new codebase; the music analyzer is ported from
Saeed's (MIT, see THIRD_PARTY_NOTICES.md).

This document is the contract between modules. Shared types: `src/shared/types.ts`, `src/shared/brandKit.ts`,
`src/shared/frameProtocol.ts`. Service interfaces: `server/contracts.ts`. Helpers: `server/util.ts`.

## Principles

1. **Every frame is a pure function of time.** Scenes render from props only. No state/effects-driven animation,
   timers, `requestAnimationFrame`, `Date.now()`, `Math.random()`, CSS transitions/animations, videos, network.
   Frames are rendered out of order, one at a time, in several browsers at once.
2. **What you see is what renders.** The editor preview, thumbnails, the agent's frames, seam checks and the MP4
   renderer all use the same page (`frame.html`).
3. **Brands and templates are orthogonal.** Every brand implements the same `BrandKit` interface; scene templates
   only use that interface (`useBrand()`), so any template works with any brand.
4. **Never lose work.** Every agent turn is snapshotted; restores are themselves new versions.
5. **The agent is boxed.** Claude Code runs restricted (no shell, no web), file writes limited to the chat's scope,
   MCP tools bound to per-turn scoped tokens, scene code runs on a separate origin with no access to the API.
6. **French and English UI, English code.** User-facing strings (editor, API error messages, chat activity labels, CLI
   output) come from typed dictionaries, `src/editor/i18n/{fr,en}` and `server/i18n/{fr,en}`: `en` is checked against
   `fr` by TypeScript. Components read them with `useT()`, other editor code with `t()`, the server with `m()`, always
   where the text is made (the language can change). The interface language is a setting (`Settings.language`, null
   until the editor first opens and saves the browser's); the server keeps it per process (`setLanguage`), the CLI
   follows `CADENCE_LANGUAGE`, then the setting, then the terminal's locale. Number, unit and date helpers
   (`src/editor/lib/format.ts`) switch with it. Frame and kit pages read it from `<html lang>`, which the servers
   write. A change reloads every open editor (SSE `language-changed`).

## Repository layout

```
cadence/
  bin/cadence.ts            CLI: start, render, analyze, new, list, doctor, mcp, soundtracks, sounds
  index.html                editor page (served on the EDITOR origin only)
  frame.html                frame page (served on the FRAME origin only)
  kit.html                  kit sheet of a brand (FRAME origin only, see "Brand builds")
  server/
    config.ts               loadConfig(overrides): CadenceConfig
    index.ts                startServer(options): RunningServer (wires everything)
    http.ts                 editor-origin request routing and guards
    editor.ts               the editor page: production build made at start, or Vite's dev server (--dev)
    hub.ts                  SseHub (server-to-editor events)
    settings.ts             FileSettingsStore (<root>/.cadence/settings.json)
    usage.ts                FileUsageLog (<root>/.cadence/usage.jsonl)
    i18n/                   server messages: index.ts (m, setLanguage, cliLanguage), fr/ and en/ by area
    doctor.ts               environment checks
    util.ts                 shared helpers (atomic writes, mutex, safe paths, ids)
    contracts.ts            service interfaces
    store/                  projects.ts, brands.ts, templates.ts, versions.ts, assets.ts
    brands/                 check.ts (brand checks), source.ts (GitHub via gh, GitLab via glab, else git),
                            fonts.ts (Google Fonts), build.ts (BrandBuilder)
    accounts/               accounts.ts (FileAccountService, <root>/.cadence/accounts.json), publish.ts (Publisher)
    networks/               youtube.ts, linkedin.ts, instagram.ts (through Facebook Login), tiktok.ts (drafts)
    api/                    Hono routes under /api (index.ts = createApi)
    frames/                 vite.ts (Vite dev server + plugins), frameServer.ts (frame-origin handler)
    capture/                capture.ts (Playwright), sheet.ts (contact sheets), seams.ts (pixelmatch), render.ts (ffmpeg)
    music/                  decode, fft, features, beats, structure, analyze, grid (overrides), service, cli,
                            worker (the analysis off the server's thread), synth + soundtracks (the preset
                            soundtracks, composed in code)
    voiceover/              piper.ts (PiperEngine: runs the user's Piper), elevenlabs.ts (ElevenLabsClient: the
                            user's own ElevenLabs key), voices.ts (the Piper voices offered, pinned files), wav.ts,
                            service.ts (LocalVoiceOverService)
    sounds/                 library.ts (the sound effects, written by `sounds`), track.ts (the sounds track of an MP4)
    agent/                  types.ts, claudeCode.ts (provider), guide.ts, prompts.ts, chat.ts (ChatManager)
    mcp/                    tokens.ts (McpTokens), server.ts (createMcpHandler), tools.ts, brandTools.ts
  src/
    shared/                 contracts (types, brandKit, frameProtocol), voiceOver.ts (when the music ducks),
                            subtitles.ts (subtitle cues from the voice-over sentences, SRT and WebVTT)
    runtime/                the `cadence` module scenes import (+ API.md, the reference the agent reads)
    frame/main.tsx          frame page app
    frame/captions.tsx      burned-in captions over the scene
    frame/kit.tsx           kit sheet app (kit.html)
    frame/texts.ts          the frame and kit pages' error texts, in the page's <html lang>
    frame/editor.ts         the editor that embeds a frame or kit page: its origins, and the one to post to
    editor/                 editor app (React + Tailwind v4, French and English UI); index.ts is what a host app imports
    editor/i18n/            useT() and t(), the fr/ and en/ dictionaries by area, links.tsx
    editor/soundtracks/     preset soundtracks (AAC) and presets.json, written by `soundtracks`
    editor/sounds/          the sound effects scenes cue (16-bit mono WAV, 44.1 kHz), written by `sounds`
  brands/<id>/              brands (see "Brands"): cadence ships, the others stay on each machine
  templates/scenes/<id>/    scene templates (template.json + scene.tsx)
  templates/projects/<id>/  campaign templates (template.json + optional art-direction.md)
  projects/<id>/            video projects (see "Project folder")
  art/                      logo exports for the networks' developer consoles
  tests/                    node:test suites: runtime/, music/, server/, brands/, templates/, editor/, e2e/ (data
                            in fixtures/)
```

## Processes, origins and security

One Node process (`npm start` runs `bin/cadence.ts start`, which calls `startServer()`), one Vite dev server in
middleware mode, two HTTP servers bound to **127.0.0.1 only**. The editor is a production build made at every start, in
memory (`server/editor.ts`, about 150 ms, so it is never stale); the Vite dev server serves the frame origin (scenes are
edited live), and the editor too with `npm run dev` (`start --dev`). Vite reads `NODE_ENV` once per process and sets it
when it is unset: `startServer()` sets it first, `production` (React's production build in the editor and in frames) or
`development` with `--dev`. Ctrl+C, SIGTERM and a closed terminal (SIGHUP) run `server.close()`, which stops the turns,
the renders and Chromium: Chromium is launched without Playwright's own signal handlers, which would exit first or, on
SIGHUP, keep the process alive. `startServer()` refuses Windows (scene URLs are `/@fs<absolute path>`), and points to
WSL 2.

| Origin | Default | Serves |
| --- | --- | --- |
| Editor | `http://127.0.0.1:5310` | `/` (editor HTML), `/assets/*` (the build; Vite modules with `--dev`), `/api/*`, `/api/events` (SSE), `/mcp`, `/oauth/<network>/callback` |
| Frame | `http://localhost:5311` | `/frame.html`, `/kit.html`, `/frame-api/*` (read-only), Vite modules (scenes, runtime, brands) |

Different ports are different origins: scene code (frame origin) cannot read or call the editor API. The frame origin
uses the name `localhost` for the same loopback (both servers listen on 127.0.0.1 only): for Chrome it is another site,
so the preview and the kit iframes run in their own process, off the editor's main thread. An editor opened as
`localhost` shares that site again: it works, without that gain.

Guards (editor origin, `server/http.ts`):
- Reject requests whose `Host` is not `127.0.0.1:<editorPort>` or `localhost:<editorPort>` (DNS rebinding).
- `/api/*` with a mutating method (POST/PUT/PATCH/DELETE) requires header `X-Cadence-Token: <editorToken>`.
  The token is random per server start and injected only into the editor HTML as
  `<meta name="cadence-token">`. A custom header forces a CORS preflight, which the server never approves.
- `/api/*` GET: allowed when `Sec-Fetch-Site` is `same-origin`, `none` or absent (media tags, curl). `cross-site`
  (the frame origin) and `same-site` (the frame origin, for an editor opened as `localhost`) are rejected.
  `/api/events` also accepts `?token=`.
- `/mcp` requires `Authorization: Bearer <mcpToken>`; the token resolves to a scope (see MCP). Requests with an
  `Origin` header are rejected (browsers never call MCP).
- `/frame.html` and `/kit.html` return 404 on the editor origin: scene and brand code never run next to the token.
- The editor HTML is sent with the CSP `frame-src <frame origin>; frame-ancestors 'none'`: the previews show the frame
  origin only (scene code cannot send its own frame to another site), and no other site may embed the editor.
- `GET /oauth/<network>/callback` is where a network sends the person back after the consent page: a cross-site
  navigation, so outside `/api`. It acts only on a state issued by `POST /api/networks/:id/connect` (editor token),
  single use, 10 minutes, bound to its network, and answers a small HTML page (CSP `default-src 'none'`, no referrer).

Frame origin (`server/frames/frameServer.ts`): Host check, GET/HEAD only, never serves `/api`, `/mcp`,
`/index.html`, `/__open-in-editor`. Every response is sent with a CSP, not only `frame.html` and `kit.html` (scene code
could load any other document of the origin in an iframe and send requests from there): `default-src 'self'; script-src
'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self';
media-src 'self' data: blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors <editor origins>`
(both `127.0.0.1` and `localhost` editor hosts), so scene code cannot fetch other origins and only the
editor may embed frames. HMR is off, and the Cadence plugin removes the Vite client's websocket dial (in middleware
mode it would target port 24678 and log an uncaught error on every page). `<meta name="cadence-editor-origin">` (space-separated list) drives postMessage origin checks.
Font files (`.woff2`, `.woff`, `.ttf`, `.otf`) answer `Access-Control-Allow-Origin` to the editor origins, and only
them: the brand panel shows the brand fonts (see "Brand builds").
The editor origin also answers 404 to `/__open-in-editor` (any website could otherwise launch the user's editor).

Capture pages (`server/capture/capture.ts`, thumbnails, agent frames, seams, renders) are locked down beyond the CSP,
which WebRTC ignores and which does not stop navigations or popups: every request that is not for the frame origin is
aborted (`context.route('**')`), other connections go to a dead proxy (`127.0.0.1:9`, frame host bypassed), WebRTC may
not use UDP (`--force-webrtc-ip-handling-policy=disable_non_proxied_udp`), service workers are blocked and popups are
closed. Chromium also runs with `--blink-settings=imageAnimationPolicy=2` (animated GIF/WebP/SVG keep their first frame)
and `--disable-partial-raster`. Capture contexts use the locale `CADENCE_LOCALE` (default `fr-FR`, checked at start);
the editor preview uses the viewer's, so scenes pass an explicit locale to `Intl.*`.
Contact sheets (`sheet.ts`) lay the strip's PNG tiles out as data URLs in a context of their own, JavaScript off and
every request aborted: that page loads nothing and is not the frame origin.

Reference captures (`screenshotUrl`) check every request by origin: host names are resolved, link-local,
unspecified and multicast addresses (IPv4-mapped included) are refused, and so are Cadence's own ports; other
loopback and private hosts stay allowed (local dev sites). Redirect hops are checked as they start and a refused hop
voids the capture (that one GET has still left; a checking forward proxy would stop it, and DNS rebinding too).

Vite (`server/frames/vite.ts`): `root = <root>`, `appType: 'custom'`, `server.middlewareMode`, `server.hmr: false`,
`server.ws: false` (no HMR websocket, so several Cadence servers can run side by side),
`server.fs.allow` = `src/`, `projects/`, `brands/`, `templates/`, `node_modules/` (+ `CADENCE_VITE_CACHE_DIR`), so the
server code and root files are never served; `server.fs.deny` adds `**/.cadence/**`, `**/.git/**`, `.env*`. `CADENCE_VITE_CACHE_DIR`
gives a server its own dependency cache.
Aliases: `cadence` for `src/runtime/index.ts`, `@brands` for `brands/`. Plugins: `@vitejs/plugin-react`,
`@tailwindcss/vite`, and a Cadence plugin whose `hotUpdate` returns `[]` for files under projects/, brands/,
templates/ (Cadence reloads frames itself). `optimizeDeps.entries = ['index.html', 'frame.html']`; `include` adds React,
lucide-react and clsx, and the Heroicons and Tabler sets that the brands present at start import (bundling all of them
made a cold start 0.9 s and 983 MB instead of 0.2 s and 509 MB). A brand built later gets its set bundled at its first
import, which pages already open take in their stride: they keep a single React.

Code reloads: `ProjectStore.watch(vite.watcher)` debounces the file events of Vite's watcher, which already watches the
root; `createVite` adds the managed dirs that live outside it. Its `server.watch.ignored` leaves out what only piles up (`.cadence/` folders, renders, soundtracks, trashed
projects): on Linux each watched file holds an inotify watch, and a recursive `fs.watch` there walks the whole tree at
start. `syncCode(id)` hashes code files (scenes/**, components/**, and the project's brand folder); on change it calls
the injected module invalidator (invalidates every Vite module under those dirs with a fresh HMR timestamp), bumps the
generation and emits `code-changed`. The editor forwards `{type: 'reload', generation}` to its frames; capture pages
call `__cadence.reload(generation)` before every capture. Frames re-import scenes and the brand with `?g=<generation>`
so imports are fresh.

## Project folder

```
projects/<id>/
  project.json          ProjectFile (name, brand, fps, formats, tempo, language, scenes[] (voiceOver?), music,
                        voiceOver, captions)
  art-direction.md      the look every scene follows (copied from the brand, then edited)
  scenes/<scene>.tsx    one component per scene (default export)
  components/           shared components/constants for this project (relative imports)
  assets/               images, SVGs, fonts; assets/refs/ = reference screenshots for the agent
  music/                audio tracks + <file>.analysis.json caches
  renders/              exported MP4s (gitignored)
  .cadence/             internal, gitignored: chats/ (project.json, scene-<id>.json, archive/), versions/,
                        thumbs/ (<scene>-<16x9>-<t>-g<run>.<gen>-<sig>.jpg), frames/ (what the agent rendered),
                        seams.json (version 2), publications.json (Publication[], newest first), trash/,
                        voice-over/ (<hash>.wav per spoken sentence, track.wav), sounds/ (<job id>.wav, the
                        sounds track of a running render: removed when it ends, one a killed render left is swept
                        after an hour with the .part files; nothing else in the folder is touched)
```

State files (chats, `publications.json`, `<root>/.cadence/settings.json` and `accounts.json`) count as empty only when
they do not exist: one that does not parse is a 500 naming the file (`readJsonOr`), and the next save never replaces
what it held. Caches (`seams.json`, `<file>.analysis.json`) are measured again instead.

Tailwind caveat: the scanner skips gitignored subfolders of an `@source` folder unless the `@source` names them
directly. `.gitignore` ignores the `projects/` folder as a whole, never individual project folders. Brand folders are
ignored one by one (all but `cadence`), which is fine: each brand's `theme.css` names its own folder (`@source '.'`).

Scene durations: seconds rounded to the ms, min 0.1. Scene order = `project.json` order.
`tempo` (default 120) is the fallback beat grid and converts template bars to seconds (1 bar = 240 / tempo s).
`language` (`fr` | `en` | null = the brand's) sets the on-screen language: the frame passes
`{ ...kit, language }` to scenes, and the agent's turn context names it.

Caches kept on disk (thumbnails, seams) are keyed by a random run id per service instance plus the code generation,
because generations restart at 0 in every process; the scene signature also covers the scene's `codeVersion` and the
project language.

## Scene contract

```tsx
import { Fill, SwapWords, ease, progress, spring, springs, useBrand, type SceneProps } from 'cadence';

export default function Anatomy({ t, duration, width, height, music, brand }: SceneProps) {
  const { ui, colors } = brand;
  const enter = progress(t, 0.1, 0.8, ease.outExpo);
  const lift = spring(t - music.beat(2), { from: 60, to: 0, ...springs.snappy });
  return (
    <Fill style={{ background: colors.background }}>
      <ui.Card style={{ position: 'absolute', left: width / 2 - 340, top: 380, transform: `translateY(${lift}px)` }}>
        ...
      </ui.Card>
    </Fill>
  );
}
```

`SceneProps` (defined in `src/runtime/types.ts`): `t` (scene-local seconds, 0 to duration), `duration`, `width`,
`height`, `format` (FormatId), `orientation`, `fps`, `music` (grid in scene-local seconds), `scene`
(`id, name, index, count, start`), `brand` (BrandKit). Imports allowed: `react`, `cadence`, `@brands/<id>`
(brand-specific extras) and relative files inside the project. Style with inline styles and/or Tailwind classes
(the brand's theme is loaded in the frame; its tokens are Tailwind theme values like `bg-primary`, `font-display`).
Animate with transform, opacity, filter, clip-path, SVG attributes. CSS 3D works. Assets via `asset('file.png')`.

## Runtime (`cadence` module, `src/runtime`)

Required exports (the runtime module may add more; `src/runtime/API.md` documents every export and is inlined into
the agent's system prompt):

- Time: `progress, interpolate, keyframes, spring, springs, springDuration, ease, bezier, mix, clamp, remap,
  stagger, staggerFrom, loop, pingpong`.
- Color (hex, rgb[a], hsl[a], oklch input; mixing in OKLab): `parseColor, toHex, mixColor, interpolateColor,
  withAlpha`.
- Random: `random, randomRange, noise, noise2`.
- Text: `SplitText, typed, measureText, TypeOn` (per-character fade + caret), `SwapWords` (words rise from a mask
  in Y), `Counter` (animated number, `Intl.NumberFormat`, fr-FR default).
- Scene: `Fill, SceneContext, useScene, BrandContext, useBrand, useFormat` (`{format, width, height, orientation,
  isPortrait, isLandscape, isSquare, pick({landscape, portrait, square}), safe}`), `asset, setAssetBase`.
- Motion kit: `Stage3D` (perspective container), `Camera` (zoom/pan/rotate around a focus point),
  `DrawPath` (SVG path drawn by progress), `Glow` (SVG glow filter + helper), `Callout` (dot, elbow line, then label),
  `Dimension` (measure line + label), `RadiusArc`, `Guide` (dashed line), `Tag` (pill label), `Highlight`
  (outline around a rect with a label), `Cursor` (pointer following keyframes, press/hover), `ClickRipple`,
  `BrowserFrame`, `PhoneFrame`, `Grain` (animated-by-seed noise to avoid banding), `Vignette`.
- Music: `createMusic({ grid, tempo, musicStart, sceneStart, sceneDuration }): Music` with `hasTrack, bpm,
  beatLength, barLength, beatsPerBar, beats, downbeats, phrases, sections, accents, beat(n), bar(n), phrase(n),
  bars(n)` (seconds for n bars), `snap(t, 'beat'|'bar'|'phrase'|'half'|'quarter'), pulse(t, {grid, decay}),
  beatPhase(t)`. Without a track: steady grid at `tempo` from the scene start.
- Types: `SceneProps, SceneInfo, Music, Easing`, re-export of `BrandKit`.
- Also exported (serving Caleb-style effects): `Layer3D`, `project3D(point, pose, {width, height})` (same math as
  the CSS, for callouts anchored on 3D parts), `useCameraZoom()` (annotations divide strokes by it: Chromium's
  non-scaling-stroke ignores CSS transforms on HTML ancestors), `rectPath`, `cursorAt`, `cursorPress`.
- `Stage3D`, `Layer3D` and `Camera` render a plain flat layer at rest (within 0.001°/px), so cuts stay pixel-exact.

Deterministic: no module-level mutable state besides the asset base; `random(seed)` only.

## Brands (`brands/<id>/`)

```
brand.json         BrandFile (colors hex, fonts, radius, logo paths, voice, language)
theme.css          Tailwind v4 entry for frames: @import "tailwindcss" source(none); @source "../../projects";
                   @source "../../templates"; @source "."; font imports (@fontsource... or @font-face on ./fonts);
                   @theme tokens (--color-primary, --color-surface..., --font-display, --font-body, --font-mono, radii)
index.tsx          default export: BrandKit (see src/shared/brandKit.ts); named exports for extras
ui/*.tsx           kit components (Card to ListItem), presentational, every state is a prop
extras/*.tsx       brand-specific showcase components (PaymentCard, ProductCard, TransactionRow...)
assets/            logo-mark.svg, logo-full.svg, optional product screenshots
fonts/             vendored font files when not on npm (a brand's own typeface)
art-direction.md   default art direction copied into new projects of this brand
KIT.md             agent-facing notes: when to use which component/extra, copy, do/don't
```

Cadence ships one brand, `cadence` (neutral default, and the base of every brand build). The others are built in the app
(see "Brand builds") or copied by hand, and stay on each machine: `brands/` is gitignored except `cadence`, like
`projects/`. A brand vendors a web font in `fonts/` when the npm build lacks what the product uses. Social-app safe
margins live in `SAFE_AREAS` (src/shared/types.ts), shared by the runtime (`useFormat().safe`) and the editor overlay.
The frame loads `theme.css?inline` into one `<style id="cadence-brand">` and the kit via
`import('/brands/<id>/index.tsx?g=<generation>')`, then waits for `brand.fonts.preload` faces before the first capture.
Brand kits never import from projects.

## Brand builds (`server/brands/`)

A brand kit built by Claude from a product's GitHub or GitLab repository, started from the « Nouvelle marque » card of
the New project modal. Each user runs Cadence with their own Claude login and their own Git access: Cadence keeps no
token.

- **Sources** (`source.ts`, one `BrandSource` per host): the repositories the host's CLI can see, GitHub through `gh`
  (`gh api user/repos`, owner, collaborator and organization member, 100 most recently pushed), GitLab through `glab`
  (`glab api --hostname gitlab.com projects?membership=true`, 100 most recently active; gitlab.com only), or a pasted
  address (`parseRepo`): `owner/name` (GitHub), `https://github.com/owner/name`, `git@github.com:owner/name.git`,
  and the same on gitlab.com with nested groups (`group/sub/name`, sub-pages after `/-/` ignored). The copy is
  `gh repo clone <owner>/<name> <dir> -- --depth 1 --single-branch --no-tags` (`glab repo clone` on GitLab), or
  `git clone` with the same flags when the CLI is missing or logged out, never prompting (`GIT_TERMINAL_PROMPT=0`,
  `NO_PROMPT=1`, SSH in batch mode, no LFS smudge). History and symbolic links are removed; the clone lives in
  `.cadence/brand-sources/<build>/` (never served) and goes at the end. `BrandSource.account()` names the CLI's login
  for the Profile page.
- **Build** (`build.ts`, `BrandBuilder`, one at a time): reserve `brands/<slug>/` with a `.building` marker holding
  `<pid> <build>` (unlisted by `FileBrandStore.list()`), copy `brands/cadence` into it with the new id and name, then
  run one restricted Claude turn: system prompt `server/agent/brand-guide.md`, cwd = the brand folder, Read on the
  clone, `brands/` and `src/shared/`, Write and Edit on the brand folder only, MCP scope `brand`. Then
  `checkBrand()`; problems left get one resumed fix turn, then the build fails. Each turn adds what it used to
  `BrandBuild.costUsd` (the fix turn: its session totals minus the first turn's) and to the usage log. Success
  removes the marker; failure and cancel remove the folder. `sweep()` at start removes folders whose marker names a dead process.
- **Checks** (`check.ts`): `brandProblems()` (brand.json, theme.css mirroring it, every named font loaded, SVG logos,
  notes) never runs the kit; the brand tests use it for the presets. `checkBrand()` adds the kit sheet: `kit.html`
  on the frame origin renders logos, colors, fonts, every UI sample (`src/shared/kitSamples.tsx`) and extras, and
  reports what throws or does not load (`CaptureService.kitSheet`); Vite's compile error replaces the browser's
  when the kit does not load.
- **Brand panel** (editor top bar, `BrandPanel.tsx`): a kit is code the brand builder may have written, so the editor
  never imports it. `kit.html?view=panel` (a smaller sheet) and `kit.html?view=extra&name=<extra>` run in sandboxed
  iframes on the frame origin and post `KitToEditor` messages (`src/shared/frameProtocol.ts`): their natural size,
  and from the panel view the extras, the copy and the theme's `@font-face` rules as data. The editor checks each
  message, lists the texts as text and registers the faces as `FontFace`s under its own names (`Cadence brand <id>
  <role>`), so a brand font never applies to the editor's own text. Chrome lays out a cross-origin iframe only once
  it is in view: an extra further down sizes itself when scrolled to.
- **MCP scope `brand`** (`brandTools.ts`): `copy_from_repo` (svg/png/jpg/webp/gif/avif/ico/woff2/woff/ttf/otf up to
  5 MB, clone to brand folder), `add_google_font` (woff2 from fonts.gstatic.com into `fonts/`, returns the
  @font-face rules), `preview_brand` (the kit sheet as an image), `check_brand`.
- **Deletion** (`DELETE /api/brands/:id`, `FileBrandStore.remove`): the folder moves to
  `.cadence/trash/brands/<id>-<time>`. Refused for `cadence` (where builds start, and the brand of projects without
  one), for a brand that projects use (named in the error, since they would no longer load their kit) and while it is
  being built. Every editor refetches its brand list on `brands-changed`.

## Templates

Scene template `templates/scenes/<id>/`: `template.json` (SceneTemplateMeta) + `scene.tsx` (default export,
imports only `react` and `cadence`, uses `useBrand()`/`props.brand` and `useFormat()` so it works for every brand
and format; editable constants such as `COPY` at the top). Inserting a template copies `scene.tsx` to
`projects/<id>/scenes/<sceneId>.tsx` and sets the duration from `bars` at the project tempo.

Campaign template `templates/projects/<id>/`: `template.json` (ProjectTemplateMeta) + optional
`art-direction.md` appended to the brand's. Creating a project from it instantiates each scene template in order.

## Versions (`projects/<id>/.cadence/versions/`)

Content-addressed: `objects/<sha256>` blobs, `manifests/<versionId>.json` = `{ relPath: sha256 }` of tracked
files (project.json, art-direction.md, scenes/**, components/**; text < 2 MB), `index.json` = `VersionEntry[]`
oldest first (`list()` returns newest first). `FileVersionStore` emits `versions-changed` on the project store's
events; restores always record a `restore` version, even when nothing changed.
`snapshot()` after every agent turn (and a `baseline` before the first one), on manual save, on template insert,
right after a project is created (« État initial », API and CLI) and before a music snap (« Avant le calage des
coupes »). While a turn runs (`ChatService.busy(id)`), the template-insert and snap versions are skipped, and restore
and project/scene deletion answer 409: the agent's own version would otherwise record someone else's change.
`restore()` first snapshots unsaved changes (`external`), writes the files (and for a scene restore: only that
scene file + its duration), then records a `restore` version. Nothing is ever deleted; object GC is not needed at
this scale.

## Agent (Claude Code)

`ClaudeCodeProvider.run(turn)` spawns the local `claude` in print mode, cwd = project folder:

```
claude -p --output-format stream-json --verbose --include-partial-messages
  --model <model> [--effort <effort>]            (omit --effort when the model does not support it)
  --restricted --tools Read,Edit,Write,Glob,Grep
  --permission-mode dontAsk --permission-prompts none
  --allowedTools <rules...>
  --disallowedTools Read(//<stateDir>/accounts.json) Read(//<stateDir>/elevenlabs.json)
  --add-dir <brandDir> <templatesDir> <runtimeDir>
  --mcp-config <tmp>/mcp.json           {"mcpServers":{"cadence":{"type":"http","url":"<mcpUrl>","headers":{"Authorization":"Bearer <turnToken>"}}}}
  --strict-mcp-config --append-system-prompt-file <tmp>/system-prompt.md
  (--session-id <uuid> | --resume <uuid>)
```

The guide and the MCP config are written to a private temp folder (0700, files 0600) removed when the turn ends,
so neither the bearer token nor the 30 KB guide shows up in `ps`. `--restricted` also means no CLAUDE.md memory
is loaded (verified with a canary: neither the project's nor the user's global CLAUDE.md reaches the in-app agent),
which is why the guide is appended to the system prompt.

Env: remove `ANTHROPIC_API_KEY` unless `config.useApiKey` (use the subscription login); remove `CLAUDECODE` and
`CLAUDE_CODE_ENTRYPOINT` (nested-session guards); `MCP_TOOL_TIMEOUT=300000`, `MAX_MCP_OUTPUT_TOKENS=120000`.

Rules (absolute paths use the `//` prefix): a scene chat gets `Read(//<project>/**)`, `Read(//<brandDir>/**)`,
`Read(//<templatesDir>/**)`, `Read(//<runtimeDir>/**)`, `Glob`, `Grep`, `Edit(//<project>/scenes/<id>.tsx)`,
`Write(//<project>/scenes/<id>.tsx)`, `mcp__cadence__<tool>` for scene tools. A project chat gets the same reads plus
`Edit`/`Write` on `scenes/**`, `components/**`, `art-direction.md`, and every project tool. Every turn, the brand build's
too, is denied the two key files: `--restricted` already keeps the file tools to its folders, the deny still holds if one
of them ever contains the state folder (the brand build clones into it).

`ChatManager`: one running turn per project (others queue); per-turn MCP token (revoked at the end); streams
text deltas (`chat-delta`), the running reply when it changes (`chat-message`) and the whole chat when a turn starts or
ends (`chat`) over SSE; persists chats in `.cadence/chats/project.json` and
`.cadence/chats/scene-<id>.json` (archives in `archive/`) with the Claude session id; `stopAll()` on shutdown; after a turn that changed files: `versions.snapshot()` (label = first 80 chars of the prompt),
`store.syncCode()`, `seams.check()` for the scene. Claude Code reports the running totals of its session
(`total_cost_usd`, tokens in `modelUsage`) and starts a resumed session from the totals it saved: the chat file keeps
the last totals of its session (`sessionUsage`), each reply stores what its turn added, and the project figure
(`GET /api/projects/:id/cost`) sums the replies, archives included. Each turn also goes to the usage log.

System prompt (static, `agent/guide.ts`): role, scene contract, `src/runtime/API.md`, brand kit usage, formats,
music, seams, craft rules, scope rules. Per-turn context (prepended to the user text): project, brand description
(`BrandStore.describe`), art direction, formats, fps, tempo, scene list with start/duration/bars, the scene file
path, playhead, music context, last seam results and render errors for the scene, and the on-screen language
(project setting or brand default).

## MCP (`/mcp`, streamable HTTP, stateless)

Scopes: `scene` (one scene), `project`, `open` (terminal token), `brand` (a brand build: only the four tools of
"Brand builds"). Tools (`mcp__cadence__*`):

| Tool | Scene | Project | Notes |
| --- | --- | --- | --- |
| `get_project` | yes | yes | structure, timing, formats, file paths |
| `get_brand` | yes | yes | tokens, kit, extras, copy |
| `get_music_context` | yes | yes | tempo, bars, phrases in scene-local seconds |
| `list_templates` | yes | yes | scene + campaign templates |
| `render_frames` | own scene / whole video | any | ≤ 8 times, format, quality low/normal/high, returns images and, per frame, text checks from the frame page (clipped, off canvas, outside the safe area, low contrast, under the captions; at most 6, never an error); or `strip` (4-24 consecutive frames around `at`, 12 by default) as one JPEG contact sheet |
| `check_seams` | own cuts | any | diff % per format (every project format by default), images when ≥ 0.05 % |
| `check_motion` | own scene | any (every scene by default) | half-size PNG samples every 0.25 s (≤ 120 per scene, ≤ 600 per call, the step widens beyond), odd samples one video frame late so a beat pulse is not sampled on its hits, consecutive samples diffed like `check_seams`; lists still stretches of about 2 s or more, measured between samples (under 0.01 % of pixels changing), an error when a scene of ≥ 2 s never moves; a render error stops that scene; a 240 s budget (`deadline` on `CaptureService.frames`) stops the scene in progress ("out of time") and the next ones ("not checked"); also an error when no scene could be checked |
| `set_scene_duration` | own scene | any | ms precision |
| `set_voice_over` | own scene | any | text + `at` (kept when left out); speaks it, answers each sentence's start and end in scene seconds |
| `create_scene`, `duplicate_scene`, `delete_scene`, `move_scene`, `rename_scene` | no | yes | `create_scene` takes a template id or TSX code |
| `snap_cuts_to_music` | no | yes | beat / bar / phrase, `keepBars` for campaigns |
| `capture_reference` | no | yes | screenshot an http(s) URL into assets/refs/ |
| `save_version` | yes | yes | named snapshot |

Project-only tools are not even registered for scene tokens. `render_frames` saves the JPEGs it returns (the frames,
or the strip's contact sheet) to `.cadence/frames/` and reports them with `tokens.reportActivity()` so the chat
shows what the agent looked at. Terminal usage: `npm run cadence -- mcp` prints the
`claude mcp add --transport http cadence <mcpUrl> --header "Authorization: Bearer <token>"` command.

## Accounts and publishing (`server/accounts/`, `server/networks/`)

The Profile page (`#/@profil`: no project id starts with `@`) shows what Cadence asked Claude (`GET /api/usage`),
lists the Git hosts (`GET /api/git-accounts`, through `BrandSource.account()`), the voice-over engines (`GET
/api/voices`: Piper's install state and downloaded voices; the ElevenLabs key form, then the voice new projects start
with and **Remove the key**; see "Voice-over") and the networks Cadence publishes to (`AppState.networks`, refreshed on
`accounts-changed`). A project's Voice tab keeps its own engine and voice; without a key it links to the Profile.

- **Usage** (`server/usage.ts`, `FileUsageLog`): one JSON line per Claude Code run Cadence starts, appended to
  `<root>/.cadence/usage.jsonl`: chat turns (project, chat key) and brand build turns (brand), each with what it added
  (API-equivalent cost, tokens read and written). `summary()` sums them per kind from the first line; unreadable
  lines are skipped. Sessions started in a terminal never reach it.

- **Networks** (`Network`, one per `NetworkId`: YouTube, LinkedIn, Instagram, TikTok): the team creates one
  developer app per network and every member pastes its keys in the Profile page. OAuth 2 with a loopback redirect to
  `http://<redirectHost>:<editorPort>/oauth/<network>/callback` (see "Processes, origins and security"): 127.0.0.1,
  or `localhost` for networks that only accept it (LinkedIn, Facebook Login). PKCE S256 where the network takes it
  (YouTube; TikTok wants the challenge in hex). Each network declares its `PublishFields` (longest title or none,
  longest text or none, text required, visibilities), which the publish dialog shows and the publisher checks.
  - YouTube: `youtube.upload` and `youtube.readonly`, offline access and a consent at every connection (Google sends a
    refresh token only then); resumable upload in 8 MiB chunks, resuming after what Google kept. A 9:16 video of 3
    minutes or less becomes a Short by itself. The uploads of a Google project that has not passed the YouTube API
    audit stay private: the publication records the visibility YouTube applied next to the one asked for.
  - LinkedIn: self-serve products (`openid profile w_member_social`), no PKCE, 60-day tokens without refresh. The
    Videos API (`LinkedIn-Version` 202609) takes the parts LinkedIn asks for, then the post (Posts API, "little" text
    format escaped) once the video is processed.
  - Instagram: the Instagram API with Facebook Login (the Instagram Login API cannot take a local file), long-lived
    user token (about 60 days, no refresh), the Instagram account chosen at connection kept with the tokens; a Reels
    container with `upload_type=resumable`, the bytes posted to rupload.facebook.com, then `media_publish`.
  - TikTok: Login Kit for Desktop, `video.upload` from a Sandbox app; the video goes to the person's inbox as a draft
    (`visibility` `draft`, no URL), posted from the TikTok app.
- **Accounts** (`FileAccountService`): app keys and tokens in `<root>/.cadence/accounts.json`, written with mode
  600 and never sent to the browser (`NetworkAccount` carries the client id, the redirect address and the channel).
  New keys drop the connection made with the previous ones. `tokens()` refreshes a token with less than 5 minutes
  left; a 401 from the network (revoked, expired for good, or 7 days in Google's « Test » mode) removes the
  connection and emits `accounts-changed`; so does a 401 during an upload for a network without refresh token.
  « Déconnecter » revokes on the network when it can (LinkedIn has no revocation), then forgets.
- **Publishing** (`Publisher`): `POST /api/projects/:id/publications` checks the file (`RenderService.resolveFile`)
  and the connection, then uploads in the background; `publish` events carry the job (progress by steps of 2 %), and
  a finished upload is kept in `projects/<id>/.cadence/publications.json`. Deleting the project waits for its
  uploads, deleting an exported video for its own. Jobs live for the run.

## REST API (editor origin, JSON, error messages `{ error }` in the interface language)

```
GET    /api/state                                  AppState
GET    /api/events                                 SSE ServerEvent stream
GET    /api/projects/:id                           ProjectState
POST   /api/projects                               CreateProjectInput (language?), answers ProjectState
PATCH  /api/projects/:id                           UpdateProjectInput (language: fr | en | null, voiceOver, captions), answers ProjectState
DELETE /api/projects/:id                           to projects/.trash; 409 while a turn, a render or an upload of it runs
GET    /api/projects/:id/art-direction             { text }
PUT    /api/projects/:id/art-direction             { text }
POST   /api/projects/:id/scenes                    CreateSceneInput, answers SceneState
PATCH  /api/projects/:id/scenes/:sid               { name?, duration?, voiceOver? (null removes it) }, answers ProjectState
POST   /api/projects/:id/scenes/:sid/duplicate     answers SceneState
DELETE /api/projects/:id/scenes/:sid               answers ProjectState (409 while a turn runs)
PUT    /api/projects/:id/order                     { ids }, answers ProjectState
GET    /api/projects/:id/scenes/:sid/thumbnail     ?t=&format=, answers image/jpeg
GET    /api/projects/:id/scenes/:sid/diagnostics   { error: string | null }
GET    /api/projects/:id/seams                     SeamResult[] (cached)
POST   /api/projects/:id/seams                     { sceneId?, format? }, answers SeamResult[] (no format: every format)
GET    /api/projects/:id/seams/detail              ?from=&to=&format=, answers { result, fromUrl, toUrl, diffUrl }
GET    /api/projects/:id/music/tracks              tracks
POST   /api/projects/:id/music                     ?name=<file name> and the file as the body (written to disk as it arrives), answers ProjectState
PUT    /api/projects/:id/music/select              { file }, answers ProjectState
PATCH  /api/projects/:id/music                     MusicSettingsPatch (null resets an override), answers ProjectState
DELETE /api/projects/:id/music                     answers ProjectState
GET    /api/projects/:id/music/audio               audio stream (Range support)
GET    /api/projects/:id/music/analysis            MusicAnalysis | null
POST   /api/projects/:id/music/snap                { grid, keepBars? }, answers ProjectState
GET    /api/voices                                 VoicesState (Piper's state, the voices offered and which are here,
                                                   elevenLabs.configured; never the key)
POST   /api/voices/:voice/download                 answers VoiceInfo once both files are in place, md5 checked
GET    /api/voices/elevenlabs                      { voices, models } from the saved key's account; 409 without a key
PUT    /api/voices/elevenlabs/key                  { key }, checked against ElevenLabs before it is saved, answers
                                                   { configured: true }; 400 when ElevenLabs refuses it
DELETE /api/voices/elevenlabs/key                  answers { configured: false }; drops Settings.defaultVoice too
                                                   (new projects start with Piper again)
POST   /api/projects/:id/voice-over/sync           speaks what is missing, failures included, answers ProjectState
GET    /api/projects/:id/voice-over/audio          ?v=, the voice-over track as audio/wav
GET    /api/projects/:id/subtitles                 ?format=srt|vtt, the voice-over sentences as a `<id>.srt` / `<id>.vtt`
                                                   attachment; 409 while a scene is not spoken, 404 without any sentence
GET    /api/projects/:id/versions                  ?scene=, answers VersionEntry[]
POST   /api/projects/:id/versions                  { label }, answers VersionEntry | null
POST   /api/projects/:id/versions/:vid/restore     { sceneId? }, answers VersionEntry (409 while a turn runs)
GET    /api/projects/:id/chats/:key                ChatState (key = project | scene:<id>)
POST   /api/projects/:id/chats/:key/messages       SendMessageInput, answers ChatState
POST   /api/projects/:id/chats/:key/stop
DELETE /api/projects/:id/chats/:key                answers ChatState
GET    /api/projects/:id/agent-frames/:name        image/jpeg or image/png (frames the agent rendered)
GET    /api/projects/:id/cost                      { totalUsd }
POST   /api/projects/:id/renders                   RenderRequest, answers RenderJob[]
GET    /api/projects/:id/renders                   { jobs: RenderJob[], files: RenderFile[] }
DELETE /api/renders/:jobId                         cancel
GET    /api/projects/:id/renders/:name             video/mp4 (Range support)
DELETE /api/projects/:id/renders/:name             moves the MP4 to .cadence/trash (409 while it uploads)
GET    /api/projects/:id/assets                    AssetInfo[]
POST   /api/projects/:id/assets                    multipart "file", answers AssetInfo
DELETE /api/projects/:id/assets                    ?path= 
GET    /api/projects/:id/assets/file               ?path=, answers file
POST   /api/projects/:id/refs                      CaptureRefInput, answers AssetInfo
GET    /api/brands/:id                             BrandFile
GET    /api/brands/:id/logo                        ?variant=mark|full, answers image/svg+xml
DELETE /api/brands/:id                             to .cadence/trash/brands; 400 for cadence, 409 if projects use it or it builds
GET    /api/brand-sources/:host                    RepoListing (host = github through gh, gitlab through glab)
POST   /api/brand-builds                           StartBrandBuildInput, answers the BrandBuild
DELETE /api/brand-builds/:id                       cancel
GET    /api/settings | PUT /api/settings           Settings (a new language: SSE `language-changed`; defaultVoice
                                                   checked like a project's ElevenLabs voice, null removes it)
GET    /api/usage                                  UsageSummary (chats and brand builds since the first run counted)
GET    /api/git-accounts                           { github: GitAccount, gitlab: GitAccount }
PUT    /api/networks/:network/app                  { clientId, clientSecret }
POST   /api/networks/:network/connect              { url }: the consent page, bound to a new state
DELETE /api/networks/:network                      revoke and forget the connection (the keys stay)
GET    /api/projects/:id/publications              { jobs: PublishJob[], publications: Publication[] }
POST   /api/projects/:id/publications              PublishRequest, answers the PublishJob (409 without a connection)
```

Frame origin read-only data: `GET /frame-api/projects/:id` answers `{ project: ProjectState, brand: BrandFile,
brandId: string, brandUrl: string }` (brand = the project's brand, or `cadence`; `brandUrl` = `/@fs<brandsDir>/<id>/`,
from which the frame imports `theme.css?inline&g=<gen>` and `index.tsx?g=<gen>`),
`GET /frame-api/projects/:id/scenes/:sid/diagnostics`, `GET /frame-api/brands/:id` (kit.html), which
answers `{ brand, brandId, brandUrl }`.

## Rendering

`FfmpegRenderService`: jobs run one at a time (one job per requested format). A job opens up to
`min(4, cpus/2)` capture pages at the format's canvas × scale (× 2 when supersampling), splits the frame range in
contiguous chunks, captures `t = i / fps` with `seek()`, and feeds frames to ffmpeg in order
(`image2pipe`). Encoding: libx264, yuv420p, BT.709, `+faststart`; quality presets
draft (CRF 23, veryfast, JPEG q80) / standard (CRF 16, medium, JPEG q95) / master (CRF 10, slow, JPEG q100).
Sizes are rounded down to even numbers and the `-vf` chain starts with a crop to that size (× 2 when
supersampling), so odd sizes are cropped, never stretched (4:5 at 0,5× = 540 × 674); supersampling then downsizes
with `scale=W:H:flags=lanczos`, and `setparams` tags the frames BT.709 (tv range). Once the render pages are open,
their duration and code generation are compared with the job's; on a mismatch they reload, and a second mismatch
fails the job (« Le projet a changé pendant le lancement du rendu »). Audio (when the project has music): track from
`music.start`, AAC 192 k, `volume`, 0.6 s fade-out, `loudnorm=I=-14:TP=-1.5:LRA=11`, cut to the video length. With a
voice-over, its track is a second input (see "Voice-over"), unless no sentence falls in the rendered range, and the
audio goes through `-filter_complex`, voice alone or mixed, ending with the same limiter.
Sound effects: before capture, the render reads `__cadence.sounds()` on its first page (the cues of every scene, in
video seconds) and checks them again in Node (`parseSoundCues`, at most 1000 cues per scene and 10,000 per video),
since scene code can replace `__cadence`. `server/sounds/track.ts` places each library file so its peak lands on its
cue, times its gain, sums them in 32 bits and clamps them into a mono WAV exactly as long as the rendered range: a cue
that starts before the range is trimmed, one that runs past it is cut. When no cue is heard in the range there is no sounds input
at all; otherwise the track is one more `-filter_complex` input, alone or mixed with the music and the voice by
`amix=normalize=0`, through the same limiter and fade, so a video with neither music nor voice-over still gets audio.
A missing or non-44.1 kHz library file fails the render naming it.
The preview and Present play the same cues: the frame posts `{type: 'sounds', sceneId, cues}` whenever they change
(scene seconds in scene mode, video seconds for the whole video), and the editor ignores a message for a scene it does not
show and checks the cues again with the same caps. `src/editor/lib/sounds.ts` decodes the library once per page, then
at each playback frame schedules on Web Audio the cues of the next 0.15 s, through one limiter, at most 64 sounding at
once. A cue whose peak the playhead passed (the first frame after play, a seek, a loop or a dropped frame) lands at
most 0.1 s after its cue; later than that it is skipped, so a seek past a cue's peak skips it in the preview, where the
MP4 mixes its tail. Pause, mute and a change of cues stop the sounds already playing.
Output: `projects/<id>/renders/<project>-<16x9>-<YYYYMMDD-HHmmss>.mp4`. Deleting one moves it to the project's
`.cadence/trash/` (`RenderService.remove`); what the networks received stays in `publications.json`.

## Music

Analyzer ported from Saeed's `server/music` (pure TypeScript DSP, in this order: ffmpeg decode, SuperFlux onsets, tempo,
Ellis 2007 DP beat tracking, constant-tempo grids refined to the ms, downbeats, phrases, sections, accents),
plus: overrides (`bpm`, `beatsPerBar`, `barOffset`, `gridOffset`) applied in `grid()`, and tests on synthetic
click tracks with known tempo and downbeats. A reading of 140 BPM or more is halved when nothing sits between the
beats (a backbeat read as beats). `snapCuts` moves each cut to the nearest grid point in video time; with
`keepBars` each scene keeps its bar count (round(duration × tempo / 240), at least 1), cuts land on the detected
downbeats (the lead-in joins the first scene) and `project.tempo` becomes 240 / bar length.

The analysis runs in a worker thread (`server/music/worker.mjs`, JavaScript so that it loads tsx itself: Node 22.12
starts a worker without the parent's `--import` hooks): its DSP would hold the server for about 1 s per 10 minutes of
audio, and the memory it peaks at goes away with the worker. An upload is written to disk as it arrives.

Preset soundtracks (Music panel, « Ou choisissez une ambiance »): ten styles composed in code by
`server/music/soundtracks.ts` on a small offline synthesizer (`synth.ts`: PolyBLEP oscillators, SVF and RBJ filters,
drum and FM voices, Freeverb, ping-pong delay, sidechain, BS.1770 loudness, look-ahead limiter), each in versions of
about 15, 30 and 60 s: an even number of bars, the last one a final hit, mastered to −16 LUFS and encoded to AAC by
ffmpeg. The editor picks the shortest version that covers the video and sends it through the normal upload, so
analysis, snapping and the agent's music context are unchanged. Arrangements keep the beat readable by the analyzer
(kick and snare on the beats, a pulse under breaks); `tests/music/soundtracks.test.ts` checks tempo, beats and bar ones.

Seams (`PixelSeamService`): the last frame of a scene and the first of the next, at full size, in every project
format, compared with `pixelmatch({ threshold: 0.01, includeAA: true })`. Under 0.05 % of pixels the cut is
invisible. Structural changes (duration, order, deletion, snap, formats, brand, tempo, language) re-check in the
background once the edits settle (`recheck`: 1.5 s after the last one, one check for a burst). Only the seam dialog
(`detail`) draws the diff image.

## Voice-over

A scene's `voiceOver` (`{ text, at }` in `project.json`) is spoken with the project's `voiceOver` settings: Piper by
default (`{ voice, speed, musicLevel }`; until someone picks one, the default voice of the on-screen language:
`fr_FR-siwis-medium` or `en_US-joe-medium`), or ElevenLabs (`{ engine: 'elevenlabs', voice, model, speed, musicLevel }`,
speed 0.7 to 1.2). Piper settings carry no `engine`, so the projects written before ElevenLabs read and save unchanged.
A new project starts with `Settings.defaultVoice` (`{ engine: 'elevenlabs', voice, model }` in
`<root>/.cadence/settings.json`, picked in the Profile; absent = Piper): `POST /api/projects` and `cadence create` pass
it to `ProjectStore.create`, which writes `voiceOver` (speed 1, music level 0.3) into `project.json` once, at creation.
Without it nothing is written, as before; a later change of the default never touches an existing project (re-speaking
it would bill the person's account). The editor never sends it: the create schema drops a `voiceOver` field.
Piper (GPL-3.0) is never shipped: each user installs it (`pipx install piper-tts`), and `PiperEngine` runs
`piper -m <voice>.onnx -d <tmp> --length-scale <1/speed>` with one sentence per line on stdin (`execFile`-style
arguments, no shell), then renames each WAV into place in the order of Piper's monotonic file names.

- ElevenLabs (`ElevenLabsClient`, behind `ElevenLabsApi`; `startServer({ elevenLabs })` injects a fake in tests): the
  person's own API key, saved by `PUT /api/voices/elevenlabs/key` in `<root>/.cadence/elevenlabs.json` with mode 600,
  after a `GET /v2/voices` that proves ElevenLabs accepts it. Like `accounts.json`, it never reaches the browser or a
  project (projects are versioned), and Claude Code turns are denied both files (`--disallowedTools`); Codex's
  `workspace-write` sandbox limits writes, not reads, so a Codex turn can read them. One that no longer parses is a
  500 that names the file without quoting it (`JSON.parse` would). One `POST /v1/text-to-speech/<voice>?output_format=pcm_24000`
  per sentence, in order (16-bit mono PCM at 24 kHz on every plan), wrapped by `writeWav`: the cache, the track, the
  ducking and the render do not know which engine spoke. A refused key is a 400 (401 stays for Cadence's own tokens),
  a spent quota or a rate limit a 429, anything else a 502 carrying ElevenLabs' message, the key masked out of it.
  Every request bills the person's account, so ElevenLabs never speaks on the automatic try below: only a sync does.
- Piper voices: `server/voiceover/voices.ts` lists the single-speaker French and English voices offered, with the license
  of their dataset (`commercial`, `credit` for CC-BY). Downloads come from the commit of the v1.0.0 tag of
  `rhasspy/piper-voices`, md5 checked before the file is renamed in, into `<root>/.cadence/voices/`.
- Sentences: `Intl.Segmenter` (line breaks end one too). Each sentence's WAV is cached in
  `projects/<id>/.cadence/voice-over/<hash>.wav`, the hash covering voice, speed and text (and, for ElevenLabs, the
  engine and the model; Piper's hash is the one it always was): a retouch speaks only the changed sentence, and
  restoring a version finds its sentences again. Piper splits in its voice's language, ElevenLabs in the video's.
- `ProjectState` (`setVoiceOverProvider`): `voiceOver` (settings in use), `voiceOverLines` (generated sentences laid
  one after the other from `scene.start + at`, in video seconds), `voiceOverPending` (scenes with a sentence not
  generated; they have no line at all), `voiceOverError` (why the engine last failed on the sentences still missing;
  null while a sync tries them again, once they change, or once spoken) and `voiceOverUrl` (the track, `?v=` changes
  with the lines). With Piper, computing it schedules one try of the missing sentences, 400 ms after the first read
  that finds a new set of them and never during a sync: the editor and the frames read the project at will, and a read
  neither postpones that try nor queues a second one. A failure goes to the editor (SSE `voice-over`, which then refetches the project); the
  same sentences are not tried again on their own, only by a sync: `POST .../voice-over/sync` (the **Generate** button
  of each pending scene in the Voice tab, a voice download), an export, or `set_voice_over`. A success sends
  `project-changed`.
- Track: `track.wav`, the sentences laid at their times over silence, one per project, rebuilt when its lines change.
  Sentences that overlap (one running into the next scene's voice-over) are summed; where the sum would pass full
  scale, the shared stretch is lowered just enough (one gain for the stretch, 20 ms linear ramps on each side) instead
  of being clipped. Without overlap, the samples are the sentences' own.
  The preview plays it in a second `<audio>` that follows the video clock (`src/editor/lib/voiceOver.ts`).
- Music under the voice: `voiceSpans` merges back-to-back sentences, `duckGain` gives the music `musicLevel` inside a
  span with 0.25 s linear ramps (`src/shared/voiceOver.ts`), in the preview and in the MP4 (`duckExpression`, a
  `volume` expression). The render's voice branch has no `loudnorm` (it turns the digital silence between sentences
  into garbage); the voice alone and the mix with the music both end with `alimiter=limit=0.95:level=disabled` (the
  default auto-level would undo the ducking). A range where no sentence falls gets no voice input at all, so the MP4
  does not depend on what a given ffmpeg does with an input sought past its end.
- Subtitles: `subtitleCues` (`src/shared/subtitles.ts`) cuts each sentence into cues of at most `maxChars` (84 for
  the files: two lines of 42) at breakable spaces only (a non-breaking space keeps `« oui »` whole), balanced and
  ending after punctuation when one is near the middle, timed in proportion to their characters; where sentences
  overlap, the one that started last shows. The download reads the lines and
  never syncs: with ElevenLabs a sync bills the person (with Piper, the read may try the missing sentences like any
  other). With `captions` on (off by default), the frame page burns them in (`src/frame/captions.tsx`): the cue of the
  video time over the scene, outside its error boundary, centered in the bottom band of the format's safe area, at
  44 / 52 / 48 px for landscape / portrait / square with `maxChars` 84 / 42 / 48 so a cue fits on two lines. The
  preview, the agent's frames and the MP4 show them; seam checks and thumbnails open the page with `captions=0` (part
  of the capture slot key), since they look at the scene. A scene that fails to compile shows the error page alone,
  without them.
  The Voice tab's Subtitles section sets `captions` and downloads the files; it disables them while the route would
  answer 409 or 404, and fetches them rather than linking them, so a refusal shows its message instead of a file.
- Scenes get `voiceOver` (`{ text, lines }` in scene seconds) in their props; the agent sets text and timing with
  `set_voice_over` and reads the sentence times in its turn context and `get_project`.

## CLI (`npm run cadence -- <command>`)

- `start [--port] [--frame-port]`
- `render <project> [--formats 16:9,9:16] [--quality standard] [--scale 1] [--fps 60] [--supersample]`
- `analyze <audio>`
- `new <name> --brand <id> [--template <id>] [--formats ...] [--fps 60]`
- `list`, `doctor`, `mcp`
- `soundtracks [preset...]` (recomposes the preset soundtracks, about 2 min)
- `sounds` (rewrites the sound effects in `src/editor/sounds`)

`render` starts a quiet server on free ports (`port 0`).

`startServer(options)` accepts `Partial<CadenceConfig>` plus `{ quiet?: boolean; provider?: AgentProvider }` and the
hooks of "Embedding Cadence", and returns `{ config, services, editorToken, close() }` (`close()` cancels renders and stops agent turns first). Ports may be 0: servers listen first, then origins are computed and the
dependent services are created.

## Embedding Cadence

A host app can run Cadence inside its own shell: it calls `startServer()` with options that shape the core and builds
its own editor page on top of the core's components. These options and the exports of `src/editor/index.ts` are public
contract: removing or reshaping one is a major version.

- `editorRoot`: a folder with the host's own `index.html`, built instead of the core's at every start (the same
  in-memory production build, `server/editor.ts`) and served with the same token, frame-origin metas and guards. Its
  scripts import the core editor through `src/editor/index.ts`, which exports `App`, `Profile`, `api`, `ApiError`,
  `useStore` and `useT` (and the `Pages` type) and nothing else; an export is added when a host needs it. `Profile` is
  the core's `@profil` page, for a host page that wraps it rather than replacing it.
- `pages`: `<App pages={{ '@compte': Account }} />` adds the host's screens to the editor's hash router. A page id
  starts with `@`, which no project id can, so a page never shadows a project; `#/@compte` opens it in place of the
  home (closing the open project), a reload keeps it, and an id that neither the host nor the core provides goes home
  with the hash reset to `#/`. A host page wins over a core page of the same id, so a host may replace `@profil`; every
  replaced page is a screen the host maintains against each core release, so replacements stay rare. Host pages keep
  their own fr and en strings and read the language with `useStore((s) => s.language)`. `tests/editor/routing.test.ts`
  checks the hash parsing and the resolution, `tests/server/editor-root.test.ts` a host page in Chromium.
- CSS: the host stylesheet imports the core's (`@import '<core>/src/editor/styles.css';`) and adds `@source './';` for
  its own files. Tailwind only generates the classes it finds in scanned sources, and the core stylesheet scans
  `src/editor/` only: without its own `@source`, the host's screens come out unstyled.
- React: the host installs `react` and `react-dom` at the exact versions of the core's `package.json`. The build
  resolves both from `editorRoot` (`resolve.dedupe`), so the core components run on the host's copy: one React in the
  bundle, where two would leave a blank editor ("Invalid hook call"). `tests/server/editor-root.test.ts` checks it.
- `api`: `startServer({ api: { compte: account } })` serves a host app's Hono app (`Hono<{ Bindings: HttpBindings }>`)
  under `/api/compte`, mounted after the built-in routes. A name is a lowercase slug (`/^[a-z][a-z0-9-]*$/`) that no
  built-in route starts with: `startServer()` rejects any other. Host routes go through the same guards as the core's
  (Host check, `sec-fetch-site`, `X-Cadence-Token` on every method but GET and HEAD), and a host app without its own
  `onError` answers errors like the core API: `HttpError` keeps its status, anything else is a 500, both as JSON
  `{ error }`; request bodies keep the core's 2 MB limit. A GET only gets the Host and `sec-fetch-site` checks, so a
  host route never changes anything on GET. `tests/server/host-api.test.ts` checks the guards, the errors and both
  refusals.
- `features`: `startServer({ features: { gitSources: false } })` hides editor sections. `Features` and
  `DEFAULT_FEATURES` (every flag `true`) live in `src/shared/types.ts`; a missing key stays on, and the merged object
  reaches the editor in `GET /api/state` (`AppState.features`). `agentPicker` hides the agent cards and usage of the
  Profile and the agent choice of the new project and new brand dialogs, `gitSources` the Profile's Git accounts,
  `networkApps` the buttons that edit a network app's keys (connect and disconnect stay), `modelPicker` the model and
  effort choice of the settings (both chat scopes) and of the chat composers (a message then carries no model, so the
  turn runs on the settings' models, which the host may set outside the editor's catalog), `costs` every dollar amount
  (chat messages, versions, brand build progress, Profile usage, the project total in the top bar). Flags shape the UI only:
  the routes behind a hidden section still answer, so a flag is never a security boundary. A flag is an `if` around an
  existing section, with no new component or string; adding one is a minor version. Flags stay few and coarse: a host
  that would need more than twelve is better served by a page of its own (`pages`). `tests/server/features.test.ts`
  checks the merge, `tests/editor/ui.test.ts` the hidden sections in Chromium.
- Title bar: a host window without a native title bar drags by the editor's top bar. The `TopBar` header is a window
  drag region (`app-region: drag`, the `titlebar` utility of `src/editor/styles.css`) whose links, buttons, fields,
  focusable elements and menus are `no-drag`, and layers that cover it (modal backdrops, the lightbox, the
  presentation) are `no-drag` too. The header pads its start by `var(--titlebar-inset, 0px)`: the host sets
  `--titlebar-inset` on `:root` to the width of its window buttons. This is CSS, not a flag: a browser ignores
  `app-region` and the inset defaults to 0, so nothing changes there. Off the editor (the home and every page, a
  host's too) the header is a box as wide as the page's content (`max-w-[92rem] px-6`), 16 px from the top, and the
  strip around it drags as well; a project, even while it loads, keeps the full-width bar. A host whose window buttons
  sit at the top left places them for the bar it shows. `tests/editor/ui.test.ts` checks both in Chromium.
- `--dev` (`dev: true`) is reserved to work on the core itself: `startServer()` refuses it together with `editorRoot`.
- The frame origin never serves `editorRoot`: its Vite server keeps the core as its root and its `fs.allow` list.
- `projectsDir` and `brandsDir` (and `templatesDir`) may live anywhere, e.g. in the host's user data. Scenes and brand
  kits there import the core's `dependencies` (its `package.json`, read at start) and nothing else: the frames Vite
  server lists them in `resolve.dedupe`, so they resolve from the core's `node_modules` and never from the importer's
  folder. Vite's watcher gets them too, so edits made outside the editor still reload. `tests/server/outside-root.test.ts`
  checks both, and that the `CLAUDE.md` written there names no core path.

## Tests

`node:test` via `npm test` (tsx loader). Unit tests never need the network. E2E tests (`tests/e2e`) start a real
server on free ports with projects under `projects/e2e-*` (gitignored, cleaned up) and their state in a temp folder,
need Chromium (`npm run setup`) and ffmpeg, and use a fake `AgentProvider` (no real Claude calls).
`tests/editor/ui.test.ts` drives the editor in Chromium the same way. Assertions that depend on the capture locale
read it from `captureLocale()`, so `CADENCE_LOCALE` and the shell's language never fail a run.
