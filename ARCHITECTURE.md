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
    store/                  projects.ts, brands.ts, templates.ts, versions.ts, assets.ts, captureHosts.ts
                            (FileCaptureHosts, <root>/.cadence/capture-hosts.json)
    brands/                 check.ts (brand checks), source.ts (GitHub via gh, GitLab via glab, else git),
                            fonts.ts (Google Fonts), build.ts (BrandBuilder)
    accounts/               accounts.ts (FileAccountService, <root>/.cadence/accounts.json), publish.ts (Publisher)
    networks/               youtube.ts, linkedin.ts, instagram.ts (through Facebook Login), tiktok.ts (drafts)
    api/                    Hono routes under /api (index.ts = createApi)
    archive/                tar.ts (ustar reader and writer, no dependency), projects.ts (ProjectArchiver)
    frames/                 vite.ts (Vite dev server + plugins), frameServer.ts (frame-origin handler)
    capture/                capture.ts (Playwright), browser-host.ts + chromium-server.mjs (Chromium in a child
                            process), serve-chromium.mjs (the Chromium server that process runs, exported for a
                            host app), sheet.ts (contact sheets), seams.ts (pixelmatch), render.ts (ffmpeg),
                            policy.ts (what a capture may reach), pinned.ts (the captures' own fetch)
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
middleware mode, two HTTP servers bound to the loopback only, **127.0.0.1 and ::1** on the same port: Chromium tries
`localhost` on ::1 as well, so no other local user can take `[::1]:<port>` in front of Cadence. With port 0, ::1 takes
the port IPv4 got, and both start again (5 tries) when it is taken there; with a fixed port, a taken ::1 fails the
start; a host without IPv6 runs on 127.0.0.1 alone (`server/index.ts`, `listenLoopback()`). The editor is a production
build made at every start, in memory (`server/editor.ts`, about 150 ms, so it is never stale); the Vite dev server
serves the frame origins (scenes are edited live), and the editor too with `npm run dev` (`start --dev`). Vite reads
`NODE_ENV` once per process and sets it when it is unset: `startServer()` sets it first, `production` (React's
production build in the editor and in frames) or `development` with `--dev`. Ctrl+C, SIGTERM and a closed terminal
(SIGHUP) run `server.close()`, which stops the turns, the renders and Chromium: Chromium is launched without
Playwright's own signal handlers, which would exit first or, on SIGHUP, keep the process alive, and its host process
(see "Capture pages") ignores SIGINT, SIGTERM and SIGHUP: it ends when the server closes its IPC channel, or dies.
`startServer()` refuses Windows (scene URLs are `/@fs<absolute path>`), and points to WSL 2.

| Origin | Default | Serves |
| --- | --- | --- |
| Editor | `http://127.0.0.1:5310` | `/` (editor HTML), `/assets/*` (the build; Vite modules with `--dev`), `/api/*`, `/api/events` (SSE), `/mcp`, `/oauth/<network>/callback` |
| Frame | `http://p-<label>.localhost:5311`, `http://b-<label>.localhost:5311` | `/frame.html`, `/kit.html`, `/frame-api/*` (read-only), Vite modules (scenes, runtime, brands) |

Different ports are different origins: scene code (frame origin) cannot read or call the editor API. Each project and
each brand has a frame origin of its own on the frame port: a project's scenes load from
`http://p-<label>.localhost:<framePort>`, a brand's kit from `http://b-<label>.localhost:<framePort>`, where the label
is the first 32 hex characters of the SHA-256 of the id (`frameOriginOf()` in `src/shared/frameOrigin.ts`: an id may be
longer than a DNS label or start with `xn--`). Scene or kit code therefore never shares storage or a same-origin frame
with another project's or brand's. The label sits right under `localhost`, so each frame origin is also a site of its
own: no cookie domain covers two of them (under a shared `project.localhost`, one would reach every project). Chrome
resolves every `*.localhost` name to the loopback itself, without DNS, and both servers listen on 127.0.0.1 and ::1
only. `CadenceConfig.frameOrigin` stays the base, `http://localhost:<framePort>`, which serves nothing. For Chrome a
frame origin is another site than the editor, so the preview and the kit iframes run in their own process, off the
editor's main thread. The cost: the browser's HTTP cache is split per origin as well, so the first open of each project
or brand fetches the runtime and its dependencies again (about 0.5 to 2 MB from the loopback).

Guards (editor origin, `server/http.ts`):
- With a request secret (`startServer({ requestSecret })`, see "Embedding Cadence"), every request without
  `X-Cadence-Secret: <secret>` gets 403 first, before the Host check and any routing; WebSocket upgrades are plain
  requests here (no `upgrade` listener) and get the same check. Only `GET /oauth/<network>/callback` (its state) and
  `/mcp` (its bearer token) are exempt. Without the secret nothing changes.
- Reject requests whose `Host` is not `127.0.0.1:<editorPort>` or `localhost:<editorPort>` (DNS rebinding).
- `/api/*` with a mutating method (POST/PUT/PATCH/DELETE) requires header `X-Cadence-Token: <editorToken>`.
  The token is random per server start and injected only into the editor HTML as
  `<meta name="cadence-token">`. A custom header forces a CORS preflight, which the server never approves.
- `/api/*` GET: allowed when `Sec-Fetch-Site` is `same-origin`, `none` or absent (media tags, curl). `cross-site`
  and `same-site` (the frame origins) are rejected.
  `/api/events` also accepts `?token=`.
- `/mcp` requires `Authorization: Bearer <mcpToken>`; the token resolves to a scope (see MCP). Requests with an
  `Origin` header are rejected (browsers never call MCP).
- `/frame.html` and `/kit.html` return 404 on the editor origin: scene and brand code never run next to the token.
- The editor HTML is sent with the CSP `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src
  'self' data: blob:; font-src 'self' data: http://*.localhost:<framePort>; media-src 'self' blob:; connect-src 'self';
  object-src 'none'; base-uri 'none'; form-action 'self'; frame-src http://*.localhost:<framePort>; frame-ancestors
  'none'`. The editor has no inline script (the dev mode has no React preamble, HMR is off), so an injected tag cannot
  run next to the token. `font-src` takes the frame origins for the brand fonts (only a brand's origin answers CORS for
  a font), `img-src` takes `data:` for the favicon, and an ElevenLabs voice's sample comes through
  `/api/voices/elevenlabs/:voice/preview` so `media-src` stays `'self'`. The previews show frame origins only (scene
  code cannot send its own frame to another site), and no other site may embed the editor. What the editor origin serves
  besides its page, the API, MCP and the network callbacks (the built assets, or in dev mode whatever Vite serves,
  project and brand files under `/@fs` included) is sent with the CSP `default-src 'none'; sandbox` and `nosniff`, so an
  SVG an agent wrote, opened as a page, runs no script next to the token.
- `GET /oauth/<network>/callback` is where a network sends the person back after the consent page: a cross-site
  navigation, so outside `/api`. It acts only on a state issued by `POST /api/networks/:id/connect` (editor token),
  single use, 10 minutes, bound to its network, and answers a small HTML page (CSP `default-src 'none'`, no referrer).

Frame origins (`server/frames/frameServer.ts`): the request secret when set (no exemption), then the Host check: the
Host must be the frame origin of a project or brand that exists. `frameSite()` reads the kind and the label, the server
maps the label back to the id (a label it does not know rescans `projects/` or `brands/`, for a project or brand created
since) and checks it still exists; anything else gets 403 (`127.0.0.1`, plain `localhost`, another port, a deleted
project), which also stops DNS rebinding. Then GET/HEAD only, never `/api`, `/mcp`, `/index.html`,
`/__open-in-editor`. Each origin then reads only its own project or brand. A scene can navigate its own iframe to
another frame origin (the sandbox allows it, and `frame-ancestors` lets the editor embed any of them), so `frame.html`
answers only `?project=<id>` on that project's origin, `kit.html` only `?brand=<id>` on that brand's, and `/frame-api`
only the origin's own id: 403 otherwise. Every other request goes through `frameReach()` (`server/frames/vite.ts`)
before Vite: the file its path names and the file Vite resolves the URL to (the module graph's id, else `resolveId`,
which a plugin may point elsewhere; a `.map` counts as its module) must both be, by real path, in the origin's home (`homeOf()`: the project's folder and its brand's, or the brand's folder) or,
outside `projects/` and `brands/`, under `server.fs.allow` (app sources, packages, templates), and neither may be,
when it exists, anything but a regular file (Vite would answer a folder with a file it picks inside, and its read of a
pipe would wait for a writer) nor sit under more than 32 missing folders (`realPath()` stops there). `/@vite/client` and `/@vite/env` pass; a backslash, a NUL,
`__x00__` (Vite's NUL) or a dot segment gets 403. `fs.allow` stays as a second layer. Diagnostics, on the frame
origin and through the API, MCP and brand checks, compile only what the frame of that scene or brand could load: a code
frame would show the file. Every response carries `X-DNS-Prefetch-Control: off`, and a CSP, not only `frame.html` and `kit.html` (scene code could load any
other document of the origin in an iframe and send requests from there): `default-src 'self'; script-src
'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self';
media-src 'self' data: blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors <editor origins>`
(both `127.0.0.1` and `localhost` editor hosts), so scene code cannot fetch other origins and only the
editor may embed frames. HMR is off, and the Cadence plugin removes the Vite client's websocket dial (in middleware
mode it would target port 24678 and log an uncaught error on every page). `<meta name="cadence-editor-origin">` (space-separated list) drives postMessage origin checks.
Font files (`.woff2`, `.woff`, `.ttf`, `.otf`) on a brand's frame origin answer `Access-Control-Allow-Origin` to the
editor origins, and only them: the brand panel shows the brand fonts (see "Brand builds").
The editor origin also answers 404 to `/__open-in-editor` (any website could otherwise launch the user's editor).

Capture pages (`server/capture/capture.ts`, thumbnails, agent frames, seams, renders) are locked down beyond the CSP,
which WebRTC ignores and which does not stop navigations or popups: every request that is not for the page's frame origin (the
project's, or the brand's for the kit sheet) is aborted (`context.route('**')`), other connections go to a dead proxy
(`127.0.0.1:9`, that origin's host bypassed), WebRTC may
not use UDP (`--force-webrtc-ip-handling-policy=disable_non_proxied_udp`), service workers are blocked and popups are
closed. With a request secret they send it as `extraHTTPHeaders` (`openIsolatedPage()`), which only that frame origin
receives since every other request is aborted; reference captures (`screenshotUrl()`) never send it. Chromium also runs with `--blink-settings=imageAnimationPolicy=2` (animated GIF/WebP/SVG keep their first frame)
and `--disable-partial-raster`. Capture contexts use the locale `CADENCE_LOCALE` (default `fr-FR`, checked at start);
the editor preview uses the viewer's, so scenes pass an explicit locale to `Intl.*`.
Contact sheets (`sheet.ts`) lay the strip's PNG tiles out as data URLs in a context of their own, JavaScript off and
every request aborted: that page loads nothing and is on no frame origin.
Scene code runs in the capture page's main world, next to `window.__cadence`, so what a page logs, throws and returns
is untrusted in size too. Capture and render browsers therefore run in a child process: `browser-host.ts` forks
`chromium-server.mjs` (plain JavaScript, `execArgv: []`) with `process.execPath`, or the Node binary
`CADENCE_NODE_PATH` names. Under Electron (`process.versions.electron`) `CADENCE_NODE_PATH` is required and the launch
fails without it: Electron's binary runs as Node only while its RunAsNode fuse is on, a packaged app usually turns it
off, and the forked binary would then start the app instead, a failure only the packaged build would show. An
Electron host names a Node binary it ships, or starts the process itself with `browserServer` (see "Embedding
Cadence"). The child runs `serveChromium()` (`serve-chromium.mjs`, plain JavaScript and exported, the same entry a
host's own process runs): `chromium.launchServer()` on a Unix socket in a `mkdtemp` folder (0700, removed when the
child exits), and the child sends the endpoint over IPC; the server attaches with `chromium.connect('ws+unix:...')`.
Never a loopback port: Playwright's `/json` hands its endpoint path to any local process, which could then drive the
capture browser, read local files and reach the pages carrying the request secret. A socket path as `port` is
Playwright 1.63 behaviour, not documented: `serveChromium()` refuses any other endpoint and
`tests/server/browser-host.test.ts` checks that no TCP port is open; a socket path past 103 bytes (a long `TMPDIR`)
fails the launch before Chromium starts. Playwright reads Chromium's CDP pipe and output in that child:
a message larger than a string can hold (`console.log(big, big)` with 300 MB strings ended the 0.12.0 server with
`ERR_STRING_TOO_LONG`) ends the child, the pages and captures in flight fail with an error, and the next capture starts
a new child. Closing the browser (or losing it) disconnects the IPC channel, the child closes Chromium and exits;
`close()` waits for it (SIGKILL after 10 s). With `browserServer` the host's process takes the child's place: the same
300 MB page ends it, and its `exited` and `close()` do what the child's exit and the IPC channel do here. In Node, the
problems a page logs and the errors `seek()` returns keep 20 lines of 2,000 characters at most (`MAX_PROBLEMS`, `PROBLEM_CHARS`); what page code throws through
`page.evaluate` and the scene id `seek()` answers are cut to 2,000 characters too (`fromPage`). What remains: a message up to 256 MB (the
limit of Playwright's WebSocket client, past which the connection drops as in a crash) still reaches the server whole
before it is cut, so a hostile scene can make the server's memory spike for a moment (a local denial of service,
nothing leaves the machine). The doctor's one-off launch stays in process. Render frames cross the WebSocket in base64
with Playwright's fixed permessage-deflate (level 3, no option turns it off in 1.63): about +2 ms per frame at JPEG
quality 95 on photographic frames, up to +33 ms at quality 100 on noisy ones, inflated on the server's thread. Past
that, the render's screenshots would move into the child, which would write the JPEG files itself.

Reference captures (`screenshotUrl`) never let Chromium reach the network: their context goes through the dead proxy
with nothing bypassed (the Chromium server drops `PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK`, so the loopback
too), page WebSockets are closed before they open, and a route answers every request from `fetchPinned()`
(`server/capture/pinned.ts`) under the capture's `Policy` (`server/capture/policy.ts`). It resolves each host once per
capture, refuses a forbidden address before dialing, dials only the checked answer and follows redirects itself; a
resource's redirects stay on its origin. The page is fetched first, so its refusals and errors are the capture's (fixed
messages naming the URL asked for or a host, never the network's own words), then opened at its final URL. Only GET
requests are fetched, with the browser's User-Agent, Accept, Accept-Language, Referer and Origin; a cross-origin answer
reaches the page only with its own `Access-Control-Allow-Origin` (Playwright 1.63's fulfill would grant one). The
agent's captures (MCP `capture_reference`) open a page only from a host the person approved for the project
(`approved()`): `POST /api/projects/:id/capture-hosts` (`DELETE` to withdraw one) keeps them in `<root>/.cadence/capture-hosts.json`, outside the
project folder and its archives, where no agent turn may write, and deleting the project drops them. Any other host is
refused before a lookup, with a message telling the agent to try again in a later turn, and a `capture-host` event
lets the editor ask the person. The page's redirects and its main frame's navigations stay on approved hosts; its
resources do not. The host of the page asked for sets the addresses and ports of the whole capture: a name, public
addresses only, on ports 80 and 443 or its own, and so does a public address; `localhost` the loopback, and a local
address that address, on any port, which the editor tells the person before they allow it. The person's captures
(`POST /api/projects/:id/refs`) are `LOCAL`: loopback and private networks on any port as well, for local dev sites,
until a hop of the page is answered from a public address: from there the capture keeps the ports and loses the private
ranges. Neither reaches Cadence's own ports. HTTPS trusts Node's CAs and the system's, so a local CA that a dev tool
installed works; one in neither store needs `NODE_EXTRA_CA_CERTS`. A redirected resource keeps its first URL as its base.

Vite (`server/frames/vite.ts`): `root = <root>`, `appType: 'custom'`, `server.middlewareMode`, `server.hmr: false`,
`server.ws: false` (no HMR websocket, so several Cadence servers can run side by side),
`server.fs.allow` = `src/`, `projects/`, `brands/`, `templates/` (each also by its real path, the one Vite names a module
by), `node_modules/` (+ `CADENCE_VITE_CACHE_DIR`), so the
server code and root files are never served; `server.fs.deny` adds `**/.cadence/**`, `**/.git/**`, `.env*`. `CADENCE_VITE_CACHE_DIR`
gives a server its own dependency cache.
Aliases: `cadence` for `src/runtime/index.ts`, `@brands` for `brands/`. Plugins: `@vitejs/plugin-react`,
`@tailwindcss/vite` (its `transform` skips every file under projects/, brands/, templates/), and a Cadence plugin whose
`hotUpdate` returns `[]` for files under those dirs (Cadence reloads frames itself). Its `transform` compiles a
stylesheet under those dirs itself (`compileStylesheet()`, with `compile()` from `tailwindcss`), so Tailwind opens no
managed file on its own. The home of a stylesheet is its project, that project's brand and the templates (a brand's:
the brand and the templates). An `@import` or `@reference` by path or `@brands/` must lead to a file of the home, read
without following a link; a package name resolves as `src/runtime/index.ts` would and must stay in the core's
`node_modules/`; `@plugin` and `@config` load no module. A `url()` or `image-set()`, in the entry or an imported file,
must name a file of the home, checked as written, decoded, and without its query or fragment, relative to the file and
to the entry (Cadence rebases an imported file's `url()` on the entry, as Tailwind does). The output may keep no
`@import` (Tailwind leaves `url()` and remote ones to the browser) and no reference with `?inline`, which Vite would
inline through any link. Utilities come from the class names Cadence reads itself (oxide's `Scanner` over the files of
a readdir walk that follows no link and skips `.git`, `.cadence` and `node_modules`). A brand theme is compiled per
project (`theme.css?inline&project=<id>&g=<n>`) and scans that project and the templates, whatever `@source` it holds;
the frame origins answer 403 to a `project=` other than their own, and the build refuses one whose project does not use
the brand. Any other stylesheet scans its home. A file of another kind that a query would compile as CSS
(`?lang.css`) is refused. `resolve.preserveSymlinks` is on: Vite resolves a URL again after the frame handler checked
it, and would otherwise read where a link there leads by then. A module keeps the path its URL or import names, which
the load hooks read without following a link, so no link inside a project is served, even one to a file of that
project. These checks take a module under those dirs by its configured path or by its real path, compared without case or Unicode normalization: macOS reaches a folder under those names too, which then fail the no-follow reads. `css.modules` is off (postcss-modules would inline what `composes` and `@value`
name, wherever it is): a `.module.css` compiles as plain CSS. `css.postcss.map` is off (postcss would read the `.map` a
stylesheet names, even in a string, through any link, and wait forever on a pipe). `build.assetsInlineLimit` is 0. The plugin's `load`
hook, ordered last, reads a file under those dirs that no other plugin loads, without following a link, and returns it
without a map: Vite's own read would fill the map a `sourceMappingURL` comment names with the content of every file its
`sources` list. A second Cadence plugin loads `?raw`, `?inline` and `?url&inline` of those files the same way (an asset's `?inline` as
a `data:` URL, whatever the rest of its query holds), and answers an `.svg` with its URL, without the read Vite makes to
decide whether to inline it. It refuses a WebAssembly module of those files but for its `?url` and `?init` (Vite's wasm
plugin reads the module for its import and export names). Vite shows the lines around a postcss error from the file the
error names, read again through any link: for those files the first plugin drops that name, and Vite shows the compiled CSS.
A middleware placed before Vite's raw file one serves those files themselves (`/@fs/...` and
root-relative paths, with ranges), opened without following a link. `tsconfig` is the core's `tsconfig.json`: otherwise each file
compiles with the one found above it, and a project's may `extend` any JSON file, whose compiler options would show in
the code and the errors Vite gives back. Its `resolveId` resolves a bare or `#` import of a file under those dirs as
`src/runtime/index.ts` would, and refuses one the core lacks: Vite looks a package up from the importer's folder, and its
dependency optimizer bundles what a package imports with none of these checks. A plugin of `optimizeDeps.rolldownOptions`
refuses to read a file under those dirs, which an alias (`@brands/../`) or a link could still lead the optimizer to.

What the frame checks leave open: a hard link is the file itself to every path check; Vite still reads an `.svg` that a
compiled stylesheet's `url()` names, through any link, to decide whether to inline it (it never does), so a FIFO there,
or a link a process an agent turn leaves running swaps in after the check, can stall that compile and hold one of
libuv's four threads, which every file read of the server shares; `import.meta.glob` lists the file names its pattern matches; a scene's diagnostics tell whether a file
it imports exists; a project's origin reads the brand its `project.json` names, so editing that file changes the brand
it reads; a scene whose import leads the optimizer to a file under those dirs fails its run, and with it the packages
other frames were waiting for, which load at their next import. `optimizeDeps.entries = ['index.html', 'frame.html']`; `include` adds React,
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
theme.css          Tailwind v4 entry for frames: @import "tailwindcss" source(none); font imports (@fontsource... or
                   @font-face on ./fonts); @theme tokens (--color-primary, --color-surface..., --font-display,
                   --font-body, --font-mono, radii). Compiled per project, with the classes of that project and the
                   templates: an @source line changes nothing
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
  clone, its own brand folder and `src/shared/` (no other brand), Write and Edit on the brand folder only, MCP scope
  `brand`. The same scope binds a Codex build turn through its permission profile (see "Codex"). Then
  `checkBrand()`; problems left get one resumed fix turn, then the build fails. Each turn adds what it used to
  `BrandBuild.costUsd` (the fix turn: its session totals minus the first turn's) and to the usage log. Success
  removes the marker; failure and cancel remove the folder. `sweep()` at start removes folders whose marker names a dead process.
- **Checks** (`check.ts`): `brandProblems()` (brand.json, theme.css mirroring it, every named font loaded, SVG logos,
  notes) never runs the kit; the brand tests use it for the presets. `checkBrand()` adds the kit sheet: `kit.html`
  on the brand's frame origin renders logos, colors, fonts, every UI sample (`src/shared/kitSamples.tsx`) and extras, and
  reports what throws or does not load (`CaptureService.kitSheet`); Vite's compile error replaces the browser's
  when the kit does not load.
- **Brand panel** (editor top bar, `BrandPanel.tsx`): a kit is code the brand builder may have written, so the editor
  never imports it. `kit.html?view=panel` (a smaller sheet) and `kit.html?view=extra&name=<extra>` run in sandboxed
  iframes on the brand's frame origin and post `KitToEditor` messages (`src/shared/frameProtocol.ts`): their natural size,
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
is loaded, which is why the guide is appended to the system prompt. Verified with Claude Code 2.1.302 in a real turn
under the user's own HOME and login, from a cwd whose `CLAUDE.md`, `CLAUDE.local.md`, `.claude/CLAUDE.md` and parent
`CLAUDE.md` each held a canary: none of them and nothing of the user's global CLAUDE.md reached the model, no user hook
ran and no skill loaded.

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

### Codex

`CodexProvider.run(turn)` spawns the local `codex` (`codexArgs`, cwd = the turn's cwd, prompt on stdin, the MCP bearer
in `CADENCE_MCP_TOKEN`, the environment cut to what Codex needs by `codexEnv`, `PATH` kept to its absolute entries):

```
codex exec [resume <thread>] --json --skip-git-repo-check --ignore-user-config --ignore-rules
  -c mcp_servers.cadence.url="<mcpUrl>" -c mcp_servers.cadence.bearer_token_env_var="CADENCE_MCP_TOKEN"
  -c default_permissions="cadence"
  -c permissions.cadence.filesystem={":minimal"="read",":slash_tmp"="deny","<cwd>"="read","<addDir>"="read",...,
       "<Edit/Write target>"="write",...,"<Read deny target>"="deny",...}
  -c permissions.cadence.network.enabled=false
  -c project_doc_max_bytes=0 -c tools.web_search=false -c skills.include_instructions=false
  -c features.multi_agent=false -c features.multi_agent_v2.max_concurrent_threads_per_session=1
  -c approval_policy="never" -c shell_environment_policy.inherit="core" -c shell_environment_policy.include_only=["PATH","HOME","TMPDIR","LANG","LC_*"]
  [-c model_reasoning_effort="<effort>"] [-m <model>] -
```

An empty or relative `PATH` entry would look `codex` up in the turn's cwd, which the agent may write, and run a binary
it left there outside any sandbox; `claudeEnv` filters `PATH` the same way, and `loadConfig` resolves a relative
`CODEX_PATH` or `CLAUDE_PATH` against the folder Cadence starts in. `approval_policy="never"`: a model that asks for
escalated permissions (`require_escalated`) gets none.

The permission profile (`codexFilesystem`) is the Codex form of the turn's Claude rules, and it binds the shell
commands, `apply_patch` and `view_image` alike: reads only the cwd and `turn.addDirs` (plus `:minimal`, what a shell
needs to start: system binaries and libraries, not the home folder); writes only the targets of the turn's `Edit`/`Write`
rules, a trailing `/**` dropped (a project chat: `scenes`, `components`, `art-direction.md`; a scene chat:
`scenes/<id>.tsx`; a brand build: the brand folder), so `CLAUDE.md` and `project.json` stay read-only; the `Read` deny
rules (`accounts.json`, `elevenlabs.json`) are unreadable even inside a readable folder. `:minimal` opens `/tmp`
read-write, `":slash_tmp"="deny"` closes it; a more specific path still wins, so a project under `/tmp` keeps its access.
A path listed twice keeps its last access (TOML rejects duplicate keys). `run()` resolves the cwd, the addDirs and the
`Read` rule paths with `realpath` first (a path not created yet through its closest existing parent): the sandbox
compares real paths, and refuses a whole profile whose writable root goes through a symlink. A write target resolves
only its parent: a target that is itself a symlink (an earlier turn may have planted one), or that lands outside the
real cwd, refuses the turn before spawning, since resolving it would grant a write on whatever the link points to. A
writable folder not created yet (`components`) is created first, so the sandbox protects it as an existing root (no
`rmdir` or `mv` of it). Within a turn the agent can still replace a file it may write with a symlink to one it may not
read (`accounts.json`) or swap a folder on the way for a link, and a process it detaches with `setsid` keeps doing so
after the turn. So the server reads the agent-writable files it hands back or hashes (`art-direction.md`, scene files,
a brand's `brand.json` and `KIT.md`, every file `check_brand` reads, the code hash, the files of a version snapshot)
with `readFileNoFollow`, writes into a folder a turn can write (a restore, `copy_from_repo`, `add_google_font`, a scene
created, duplicated or deleted, the components a template copies) with `writeFileInside` and `removeFileInside`, lists
a brand's `assets/` with `listInside`, and removes the folder of a failed or dead brand build with `removeTreeInside`.
None follows a link below the real project or brand folder, even one that stays inside it, and none relies on a check by
path before or after, which a folder swapped for a link and back in between would pass. A deleted scene is copied to
the trash and then removed, since a rename by path would follow a swapped `scenes/`. An open (a read, a write's temp
file) is refused by the kernel itself: `O_NOFOLLOW_ANY` on macOS (ELOOP on a link anywhere in the path), on Linux a
walk that opens each folder with `O_NOFOLLOW` through the previous one's `/proc/self/fd/<fd>`. A read adds
`O_NONBLOCK`, so a FIFO is refused at once instead of holding a libuv thread. Node has no `mkdirat`, `renameat` or
`unlinkat`. On Linux they go through the opened folder's `/proc/self/fd/<fd>`, which the kernel resolves to that folder
wherever it is now; without `/proc` they fail, rather than find every name missing and report a removal as done. On
macOS `/.vol/<dev>/<ino>` is no substitute (it resolves back to a path and leaked under a swap race), so a `/bin/sh`
with an empty environment walks down with `cd -P`, checks after each step that `/bin/pwd -P` (getcwd: the shell's
builtin resolves the path string again) is exactly the expected folder, trailing newlines included, and runs `mkdir`,
`rm -f`, `/usr/bin/perl`'s plain `rename` or `/usr/bin/find` (a listing) by name from there (`mv` would move the file
into a folder found under the target name; without perl a write fails): a swap can move that folder, never redirect
it. A write's temp file and its rename land in the same folder, or the rename is refused; a failed write removes its
temp file where the walk still reaches it. `removeTreeInside` is `rm -rf`, whose fts checks that each folder it enters
is the one it listed. Only the Linux CI runs the Linux branch for real. A snapshot skips a `scenes` or `components`
entry that is not a real folder, and fails on a file refused this way instead of versioning what it points to. A
restore answers 409 when a folder on the way to one of its paths is a link, checking
every path before it records its "unsaved" snapshot and makes its first write. A Codex that
ignores the profile would run unconfined, so `run()` fails closed: no turn spawns unless `status()` (`codexStatus`) is
ok, which takes, in this order, Codex 0.161.0 or later (the first with `sandbox -P` and `[permissions.<name>]`
profiles; an older or unparsable version is reason `unconfined` without a probe), a probe that concludes confined,
then a login (`logged-out` otherwise). The probe runs, in an empty `CODEX_HOME` and `HOME`,
`codex sandbox -P cadence <the -c profile above, for an empty temp folder <inside>> -C <inside> /bin/cat probe <outside>/probe`
and must print the inside file and not the outside one; two more runs of the same profile, at the same time, must fail
to create a file beside it (`/bin/sh -c ': > "$1"'`) and to connect to a listener the probe opens on 127.0.0.1
(`/usr/bin/curl`; without curl that check sees nothing, the other two still run). Reason `unconfined` otherwise; a
probe that cannot run at all is reason `error`. A refused turn ends with one error event named after the reason, a `status()` that rejects
included; the agent picker and the Profile card say why Codex stays disabled. No network for commands; the Codex process
itself still reaches the model and the Cadence MCP server. `project_doc_max_bytes=0` also stops Codex from reading
`AGENTS.md` up to the git root, a read outside the profile that would fail the turn. `sandbox_mode` is not passed: with
`workspace-write` the whole cwd was writable, `CLAUDE.md` included, and every file readable. Verified with Codex 0.161.0
on macOS (Seatbelt): `codex sandbox -P` with this profile in an empty `CODEX_HOME`, then
`tests/server/codex-confinement.test.ts`, which runs the real `codex exec` against a local fake model (a
`model_providers` entry with a 127.0.0.1 `base_url`, no credentials) whose tool calls read outside (shell and `view_image`), read a
denied file inside a readable folder, write `CLAUDE.md` and outside (shell and `apply_patch`), print the environment and
open a connection: all refused, the environment holds no secret, while `scenes/`, `components/` (created during the
turn) and `art-direction.md` stay writable and the brand folder readable; a second turn, a scene chat whose project is
reached through a symlink, writes its own scene and is refused another one; a brand build writes its brand folder,
reads its clone and is refused a write to the clone, outside and a read of `accounts.json`. Each turn first runs the
provider's own probe against the installed binary. Skipped when `codex` is not installed.

What the same tests show of Codex 0.161.0 beyond the shell and `apply_patch`. A sub-agent (the v1 `multi_agent` tools,
and the v2 `collaboration` ones the gpt-6 models get from the catalogue) stays in the turn's sandbox, but its commands,
writes and tokens never reach `exec --json`, so the brand build's file list, the chat activity and the usage would miss
them: `features.multi_agent=false` removes v1, and the v2 tools, which no key removes, fail with "agent thread limit
reached" while the root is the only thread allowed. Each key alone leaves the other version working. Code mode
(`functions.exec`, the only tool mode of the gpt-6 models) stays on: its isolate has no `fetch`, `require`, `process` or
module imports, and its nested `exec_command` and `apply_patch` go through the same profile as direct calls (a nested
`exec_command` the sandbox refuses shows in no `command_execution` event). Codex refuses to create `.agents`,
`.codex` or `.git` at the top of a folder it may write; skills another writer puts in a cwd's `.agents/skills` or
`.codex/skills`, or in `$HOME/.agents/skills`, still reached fresh and resumed turns whatever `--ignore-user-config`
says, hence `skills.include_instructions=false`. A planted `.codex/config.toml` does not apply under
`--ignore-user-config`, and no `AGENTS.md`, `.codex/AGENTS.md` or `AGENTS.override.md` reaches the model.

A real turn (Codex 0.161.0, `gpt-6-luna`, the user's own login, `codexArgs` and `codexEnv` as `run()` passes them)
ran its four steps through code mode: reading `scenes/` worked; reading outside, writing `CLAUDE.md` from the shell and
deleting it with `apply_patch` were refused. The file stayed unchanged and the outside file's content is in neither the
events nor the session Codex records. Only the successful read showed as a `command_execution`.

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
| `check_motion` | own scene | any (every scene by default) | half-size PNG samples every 0.25 s (≤ 120 per scene, ≤ 600 per call, the step widens beyond), captured 12 at a time and diffed as they arrive (memory holds one batch, and `render_frames` can take the capture slot in between), odd samples one video frame late so a beat pulse is not sampled on its hits, consecutive samples diffed like `check_seams`; lists still stretches of about 2 s or more, measured between samples (under 0.01 % of pixels changing), an error when a scene of ≥ 2 s never moves; a render error stops that scene; a 240 s budget (`deadline` on `CaptureService.frames`) stops the scene in progress ("out of time") and the next ones ("not checked"); also an error when no scene could be checked |
| `set_scene_duration` | own scene | any | ms precision |
| `set_voice_over` | own scene | any | `text` or `lines` (`{ speaker, text, gesture? }`, exclusive) + `at` (kept when left out); speaks it, answers each line's start and end in scene seconds with its speaker; refuses a text over a scene written in lines |
| `list_voices` | no | yes | the voices of the project's engine (installed Piper voices, or the ElevenLabs catalogue of the account or the host app) with id, name, language; without an ElevenLabs key, the message saying where to add one |
| `set_speakers` | no | yes | replaces the project speakers through `ProjectStore.update` (its checks: voice per engine, at most 10, no removing a speaker a line uses) |
| `create_scene`, `duplicate_scene`, `delete_scene`, `move_scene`, `rename_scene` | no | yes | `create_scene` takes a template id or TSX code |
| `snap_cuts_to_music` | no | yes | beat / bar / phrase, `keepBars` for campaigns |
| `capture_reference` | no | yes | screenshot an http(s) page into assets/refs/, from a host the person approved for the project only |
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

## Project archives (`server/archive/`)

An archive moves projects to another installation: a gzip POSIX tar (ustar, a pax `path` header for long names),
written and read by `server/archive/tar.ts` with no dependency. Entries, in order:

- `manifest.json` (`ArchiveManifest`): `{ format: 1, createdWith: <package.json version>, projects: [ids], brands: [ids] }`;
- `projects/<id>/<path>` for each project;
- `brands/<id>/<path>` once per brand the projects use. Never `brands/cadence`: every installation has it.

What is left out, by `exportableProjectPath` and `exportableBrandPath` (the same rule decides what an import keeps):
`renders/` (videos are made again from the code), a project's `tsconfig.json` (its `extends` points into this
installation and breaks Vite on another one), `node_modules/` and `package.json` under any case (the frame server
refuses them above a stylesheet), dotfiles (`.building` included), and in `.cadence/`
everything but `chats/`, `versions/` and `voice-over/` (thumbnails, frames, seams, sounds, trash and publications are
cache or tied to this machine). Only regular files and folders are walked, from `lstat` types: a symlink is skipped,
never followed, and `writeTar` opens each file with `O_NOFOLLOW`.

Export is a GET (`<a download>`): the same-origin guard lets it through without the editor token, and the archive
streams to disk instead of sitting in the page's memory. Unknown projects (404), a project whose `project.json` cannot
be read (409 naming it, rather than an archive that leaves it out), and brands missing on this machine or whose folder
is a symlink (409) are checked before the first byte. A folder with no `project.json` (an import staged in `.import/`)
is not a project and stays out. A HEAD answers the headers and closes the archive unread; a read error later ends the
stream, so the file is truncated (and an import refuses it). No project lock is held while the archive streams, which
would block writes for the length of a download: an export taken while the agent writes may mix two states (accepted).

Import (`POST /api/import`, the raw gzip body, editor token, 2 GiB upload limit counted by the route as the body
arrives, with or without Content-Length) runs in this order:

1. Staging folders older than an hour (left by a crash) are removed from `projects/.import/` and `brands/.import/`,
   as they are when the server starts (`ProjectArchiver.sweep`). A younger one may be another process's import.
2. The archive is unpacked as it arrives into `projects/.import/<uuid>/<id>/` and `brands/.import/<uuid>/<id>/`, on
   the volume of their targets so each move is one rename. Caps: 4 GiB unpacked, 100 000 entries, 10 MiB for
   each file the server later reads whole (`.css`, `.json`, `.md`, scripts), so only media can be larger; an overrun
   answers 413. `manifest.json` must come first; a `format` above 1 asks for a newer Cadence. Only `projects/<id>/` and `brands/<id>/` of listed ids
   are accepted, and only the paths an export would write; `brands/cadence/` is skipped (reported as reused). Files are
   created with `wx`, so two entries never land on one path. Each `.css` file is scanned as it streams to the disk:
   one that holds `@plugin` or `@config`, comments removed as Tailwind removes them (a backslash in a comment escapes
   the next character), refuses the import. Other files are not scanned, so chats, history and notes may quote the
   directives: the frame build reads one only through a stylesheet that imports it by path, which step 3 refuses.
3. Checks, one import at a time from here on, before anything moves: the staging folders pass `cssCodeOffenders`, so
   nothing that would stop every frame compile moves in. It checks each `@import` and `@reference` of every `.css`
   file on its own, even one inside a string, read from where its folder lands (and looked up in the staging folders
   too). Only two kinds pass: a package name (`tailwindcss`, `@fontsource-variable/inter/standard.css`), and a path or
   `@brands/` import that names a `.css` file the scan reads, never a folder, a link to another kind of file, a file
   under `.git` or behind a linked folder that leads out of the managed dirs; `compileStylesheet` would read anything
   else as CSS or refuse it. It also refuses a `node_modules/` or `package.json` in a folder that holds a stylesheet at
   any depth (an export never writes them): a bare or `#` import resolves through them. Names are compared as a
   case-insensitive disk compares them (APFS opens `Node_Modules` for `node_modules` and `a.CSS` for `a.css`). Then
   a brand of the archive being built here (its folder holds `.building`) refuses the whole import (409), and so does a local folder of that id that
   holds no brand; a brand not installed here must pass `brandProblems`; each `project.json` must pass the
   store's schema (the rules `read()` applies, duplicate scene ids included), and its brand must be `cadence`, in the
   archive, or installed here and not being built. The empty folders a new project starts with (`components/`,
   `assets/refs/`) are made in the staging folder, so a file of that name refuses the import here.
4. Brands move first (`BrandStore.adopt`: an `mkdir` claim like a build's, then a rename onto that claim only; a
   brand already installed is reused as it is, even when its files differ or its folder is a link, and any other
   folder answers 409, since an empty one may be a build that has claimed it and not yet written its marker), then
   projects (`ProjectStore.adopt`: `<id>`, or `<id>-2`... when taken). Imports check and move one at a time, so of two
   imports of one archive the first installs a brand and the second reuses it. A brand moved in sends
   `brands-changed`; each project emits `list-changed`. Both staging folders are removed whatever happens.

Any refusal answers 400 (409 for a brand being built, 413 over a cap) naming the cause, and leaves `projects/` and
`brands/` as they were. Chats keep their session id when it is a UUID (any other value is dropped, since it reaches
the CLI's argv): a Claude Code session or a Codex thread missing on this machine starts again (the `session-lost`
retry; Codex reports it as the `session_lost` subtype, so the retry never reads Codex's text).

An archive is untrusted. Its scenes and kit components run in the frame like any scene (their own frame origin, CSP, no access
to the editor token); its text (`project.json`, notes, chats, `KIT.md`) reaches the agent like any project file,
under the agent's usual restrictions. The reader accepts only regular files under safe relative paths (no `..`, no
absolute path, no link, no duplicate under APFS case folding), and nothing outside the staging folders is written
before the checks pass. Accepted risks: a scene can still render anything a scene can (it is code the user chose to
import), a reused brand may differ from the one the projects were made with, a crash between two moves leaves the
projects and brands already moved in place (each one complete), a crash between a brand's claim and its rename leaves
an empty `brands/<id>/` that the next import of that brand refuses until it is removed, and a build that claims a
brand id between the checks and the moves makes the import answer 409 after earlier brands moved in. While an import
runs, its staging folders sit under the managed folders that the frame server's guard walks on every CSS compile, so a
staged stylesheet the guard refuses (one importing a `.png`, refused only at step 3, once the whole upload is read)
fails every frame CSS compile until the import ends; after a crash, until the folder is an hour old and the next start
or import removes it. The guard does not skip `.import/`: a scene could import a staged file by path.

The history in `.cadence/versions/` travels as the archive gives it, so a restore writes only the paths a snapshot
tracks (`project.json`, `art-direction.md`, `scenes/**`, `components/**`, no dot segment, no `node_modules` or
`package.json`), and a version id must look like `v0001` before it names a manifest file. Only the brands the projects
use now travel: a full restore of a version whose brand is not installed answers 400 naming it, before any write.

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
GET    /api/voices/elevenlabs/:voice/preview       the voice's MP3 sample, fetched without the key from its https URL,
                                                   public addresses on port 443 only through the captures' address
                                                   policy, each redirect checked, 8 MB at most; 409 without a key, 404
                                                   when the voice has no sample or its URL is refused, 502 when the
                                                   storage fails
PUT    /api/voices/elevenlabs/key                  { key }, checked against ElevenLabs before it is saved, answers
                                                   { configured: true }; 400 when ElevenLabs refuses it
DELETE /api/voices/elevenlabs/key                  answers { configured: false }; drops Settings.defaultVoice too
                                                   (new projects start with Piper again)
POST   /api/projects/:id/voice-over/sync           speaks what is missing, failures included, answers ProjectState
GET    /api/projects/:id/voice-over/audio          ?v=, the voice-over track as audio/wav
GET    /api/projects/:id/subtitles                 ?format=srt|vtt, the voice-over sentences as a `<id>.srt` / `<id>.vtt`
                                                   attachment; 409 while a scene is not spoken, 404 without any sentence
GET    /api/projects/:id/export                    the project and its brand as a `cadence-<id>-<YYYY-MM-DD>.tar.gz` attachment
                                                   (see "Project archives"); 404 unknown project, 409 unreadable project.json
                                                   or brand not on this machine
GET    /api/export                                 every project and their brands as `cadence-<YYYY-MM-DD>.tar.gz`, same errors
POST   /api/import                                 the raw .tar.gz body (up to 2 GiB), answers ImportReport; 400 refused archive,
                                                   409 a brand of it being built here, 413 over a cap
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
GET    /api/projects/:id/capture-hosts             { hosts }: the hosts approved for the agent's captures
POST   /api/projects/:id/capture-hosts             { host } as URL.host writes it (400 otherwise), answers { hosts }
DELETE /api/projects/:id/capture-hosts             { host }, answers { hosts } (a host not approved changes nothing)
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
answers `{ brand, brandId, brandUrl }`. Each answers only the id of the origin it is asked on, 403 otherwise.

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
  project (projects are versioned), and no agent turn can read either file: Claude Code turns are denied both
  (`--disallowedTools`), Codex turns read only their own folders and deny both in their permission profile. A Codex
  turn can still point a file it may write at one of them with a symlink; the server never follows it (`readFileNoFollow`,
  see "Codex"). One that no longer parses is a 500 that names the file without quoting it (`JSON.parse` would). With `startServer({ secrets })` the key goes through
  the host app's `SecretStore` under the name `elevenlabs` instead, and no file is written; a store that fails is a 500
  ("key not saved", or not read) that never quotes the store's error, and a failed save changes nothing. With a host
  app's client (`ElevenLabsApi.hosted`), the host brings the key: `GET /api/voices` answers
  `elevenLabs: { configured: true, hosted: true }` (`hosted` is absent otherwise, so the key form stays), both key
  routes answer 409, and the service reads neither the store nor the file. One
  `POST /v1/text-to-speech/<voice>/with-timestamps?output_format=pcm_24000` per sentence, in order (16-bit mono PCM at
  24 kHz on every plan, base64 in the JSON answer), wrapped by `writeWav`: the cache, the track, the ducking and the
  render do not know which engine spoke. The sentence's words (from the answer's character alignment, else shared out by character
  over its duration) and its mouth levels are written first, into `<hash>.json` beside the WAV (`sidecarFile`), so a WAV
  never stands without them; an answer with no readable sound is a 502. A refused key is a 400 (401 stays for Cadence's
  own tokens), a spent quota or a rate limit a 429 (a rate limit whose `retry-after` is 30 s or less is asked again
  once, after that wait), a 402 a 402, anything else a 502 carrying ElevenLabs' message, the key masked out of it and
  the message cut to 300 characters. Every request bills the person's account, so ElevenLabs never speaks on the
  automatic try below: only a sync does.
- Piper voices: `server/voiceover/voices.ts` lists the single-speaker French and English voices offered, with the license
  of their dataset (`commercial`, `credit` for CC-BY). Downloads come from the commit of the v1.0.0 tag of
  `rhasspy/piper-voices`, md5 checked before the file is renamed in, into `<root>/.cadence/voices/`.
- Sentences: `Intl.Segmenter` (line breaks end one too). Each sentence's WAV is cached in
  `projects/<id>/.cadence/voice-over/<hash>.wav`, the hash covering voice, speed and text (and, for ElevenLabs, the
  engine and the model; Piper's hash is the one it always was): a retouch speaks only the changed sentence, and
  restoring a version finds its sentences again. Piper splits in its voice's language, ElevenLabs in the video's.
  A scene with script `lines` speaks each line with its speaker's voice (and ElevenLabs model, else the project's),
  one engine call per voice and model; a scene without lines speaks its `text` with the project's voice. Each line has
  an `id`, unique in its scene and kept through its edits and moves, so the Voice tab acts on the line a click named
  even when an earlier change is not saved yet; the store keeps an id sent with a line when no other line of the scene
  has it, else gives one from the line's speaker and text (`set_voice_over` sends none). The sentence hash does not cover it. Piper gets the sentences
  without their audio tags, ElevenLabs as written. A WAV is what marks a sentence spoken: one without a valid
  `<hash>.json` (Piper's, or a cache from before word timings) gets one computed from its samples, words shared out by
  character, with no engine call. A sync never brings a deleted project back: the cache folder is made only under a
  project folder that still exists, the engines write only into it, and a project deleted mid-sync is a 404.
- `ProjectState` (`setVoiceOverProvider`): `voiceOver` (settings in use), `voiceOverLines` (generated sentences laid
  one after the other from `scene.start + at`, 0.2 s apart where the speaker changes and, between one speaker's
  sentences, with the silence they lack for 0.15 s (measured on their `level`: under 8 is silence), in video seconds, each with its
  `speaker`, its `words`, its mouth `level` at 25 Hz, the index of its script `line` and that line's `gesture`), `voiceOverPending` (scenes with a sentence not
  generated; they have no line at all), `voiceOverError` (why the engine last failed on the sentences still missing;
  null while a sync tries them again, once they change, or once spoken) and `voiceOverUrl` (the track, `?v=` changes
  with the lines). With Piper, computing it schedules one try of the missing sentences, 400 ms after the first read
  that finds a new set of them and never during a sync: the editor and the frames read the project at will, and a read
  neither postpones that try nor queues a second one. A failure goes to the editor (SSE `voice-over`, which then refetches the project); the
  same sentences are not tried again on their own, only by a sync: `POST .../voice-over/sync` (the **Generate** button
  of each pending scene in the Voice tab, a voice download), an export, or `set_voice_over`. A success sends
  `project-changed`.
- Track: `track.wav`, the sentences laid at their times over silence, one per project, rebuilt when its lines change.
  Each sentence fades in and out over 8 ms (raised cosine), so one cut on a sound does not click. Sentences that overlap (one running into the next scene's voice-over) are summed; where the sum would pass full
  scale, the shared stretch is lowered just enough (one gain for the stretch, 20 ms linear ramps on each side) instead
  of being clipped. The track takes the highest sample rate of its sentences (ElevenLabs speaks at 24 kHz, Piper at
  its voice's rate) and resamples the others linearly; without overlap, the samples are otherwise the sentences'
  own, faded.
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
  `useStore`, `useT` and `openNewBrand` (and the `Pages` type) and nothing else; an export is added when a host needs it. `Profile` is
  the core's `@profil` page, for a host page that wraps it rather than replacing it.
- `pages`: `<App pages={{ '@compte': Account }} />` adds the host's screens to the editor's hash router. A page id
  starts with `@`, which no project id can, so a page never shadows a project; `#/@compte` opens it in place of the
  home (closing the open project), a reload keeps it, and an id that neither the host nor the core provides goes home
  with the hash reset to `#/`. A host page wins over a core page of the same id, so a host may replace `@profil`; every
  replaced page is a screen the host maintains against each core release, so replacements stay rare. Host pages keep
  their own fr and en strings and read the language with `useStore((s) => s.language)`. `tests/editor/routing.test.ts`
  checks the hash parsing and the resolution, `tests/server/editor-root.test.ts` a host page in Chromium.
- `profile`: `<App profile={false} />` takes the Profile entry off the top bar, for a host that keeps the person on one
  of its pages for now (a sign-in first). It only hides the entry: `#/@profil` still opens, so a host that must keep
  the person out gates the hash itself. The default (`true`) changes nothing. `tests/server/editor-root.test.ts` checks
  it in Chromium.
- `newBrand`: `<App newBrand="@marque" />` points the "New brand" card of the new project window at a host page: the
  card closes the window and opens `#/@marque`, which the host provides through `pages`. The id starts with `@` (its
  type says so), since a hash without it names a project. Building chips in the top bar and the new project window
  still open the core's progress window. Without the prop, the card opens the core's repository window as before.
  `newBrandHint` replaces the card's line under its title ("From a GitHub repository") to say what that page builds a
  brand from; the host passes it in the interface language. `tests/server/editor-root.test.ts` checks both in Chromium.
- `openNewBrand(buildId?)`: a host page opens the core's "New brand" window itself, the repository picker without an
  argument, the progress of that build with one (a build started with `api.startBrandBuild({ source, ref, name })`,
  say). The progress of a build that has a `source` offers no "Start over", since its `ref` never reaches the editor;
  a repository build still does. `tests/server/editor-root.test.ts` checks both in Chromium.
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
- `secrets`: `startServer({ secrets: { get(name), set(name, value) } })` (`SecretStore` in `server/contracts.ts`) keeps
  the person's keys in a store of the host app's choosing (its OS keychain, say) instead of files under
  `<root>/.cadence/`. `get` resolves to the secret or `null`, `set(name, null)` removes it. The only name in use is
  `elevenlabs`: `PUT /api/voices/elevenlabs/key` still checks the key with ElevenLabs before `set`. Without the option,
  nothing changes. `tests/server/voice-over.test.ts` and `tests/server/api.test.ts` check both, and that the key never
  shows in `GET /api/state`, `GET /api/voices` or a project folder.
- `elevenLabs`: `startServer({ elevenLabs: new ElevenLabsClient({ baseUrl, key }) })` speaks through a host app's
  gateway with the host's own key (a string, or a function read at each request). The client is then `hosted`:
  `GET /api/voices` says so, the key routes answer 409, and the person's key, if any, is neither read nor sent. `baseUrl`
  must be `https:` (plain `http:` only on `localhost` or `127.0.0.1`), else the client refuses to be built. A key
  function that throws or rejects is a 502 whose message never carries what it threw; the gateway's 401, 402 and 403
  reach the person with its own message, the key masked. `tests/server/elevenlabs.test.ts` checks it.
- `hostBrandSources`: `startServer({ hostBrandSources: { site } })` adds a host app's ways to start a brand next to
  GitHub and GitLab (`HostBrandSource` in `server/contracts.ts`). A key is a lowercase slug (`/^[a-z][a-z0-9-]*$/`)
  other than `github` and `gitlab`: `startServer()` rejects any other. `POST /api/brand-builds` then takes
  `{ source, ref, name }` (`ref` up to 2048 characters, an unknown `source` is a 404) next to `{ repo, name }`.
  `describe(ref)` runs before anything is created and gives the label shown as `BrandBuild.repo`; an `HttpError` it
  throws keeps its status, and no build, brand folder or source folder is left. `fill(ref, dest, signal, progress)`
  takes the place of the clone: it creates and fills `dest` (`.cadence/brand-sources/<build>/`), its `progress` texts
  become the build's activity, its signal aborts on cancel, and it resolves to the paragraph the brand guide shows in
  place of the repository's (English, `{{SOURCE}}` in `server/agent/brand-guide.md`). Symbolic links are removed, the
  turns, checks and cleanup are the repository's, and `BrandBuild.source` holds the key. The core keeps `ref` in memory
  and never writes it to the build record or the logs, but an error `describe` or `fill` throws reaches the editor
  with its message (`fill`'s becomes `BrandBuild.error`, another error than an `HttpError` from `describe` is also
  logged), so a host keeps `ref` out of its messages and its `progress` texts. Host sources are not Git hosts:
  `GET /api/brand-sources/:host` and the Profile's Git accounts never list them. Without the option, nothing changes.
  `tests/server/brand-builds.test.ts` checks a build, a failed `fill` and two cancels, `tests/server/host-api.test.ts`
  the keys, the route and the refused `ref`.
- `features`: `startServer({ features: { gitSources: false } })` hides editor sections. `Features` and
  `DEFAULT_FEATURES` (every flag `true`) live in `src/shared/types.ts`; a missing key stays on, and the merged object
  reaches the editor in `GET /api/state` (`AppState.features`). `agentPicker` hides the agent cards and usage of the
  Profile and the agent choice of the new project and new brand dialogs, and turns the agent's name into "our AI" in
  the editor's and the server's texts (`agentName()` in `src/shared/types.ts`; the providers get it at construction for
  their turn errors, and a refused login then names no CLI command to run; Codex's own stderr, failed-turn message and
  error notes are then left out, since they name it), `gitSources` the Profile's Git accounts,
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
  strip around it drags as well; a project, even while it loads, keeps the full-width bar. A host sets
  `--titlebar-max-width` on `:root` (`none`) to keep the box the window's width less its 24 px sides, so it does not move
  as the window widens. A host whose window buttons sit at the top left places them for the bar it shows.
  `tests/editor/ui.test.ts` checks both in Chromium.
- Controls and chrome: a desktop host can make the editor feel native with two more `:root` variables, CSS as well.
  `--control-cursor` (default `pointer`) is the cursor of buttons, `[role='button']`, `label[for]`, `summary` and the
  few other clickable surfaces (scrubbers, the project list, the render preview); a host sets `default`.
  `--chrome-select` (default `auto`) is the `user-select` of `body`; a host sets `none` so labels and buttons do not
  select like a page, while chat messages, command blocks and error texts carry `select-text` and stay copyable. The
  defaults sit in the editor stylesheet's base layer, so an unlayered host `:root` rule wins over them.
  `tests/editor/ui.test.ts` checks the web defaults and the opt-in in Chromium.
- Reduced motion: under `prefers-reduced-motion: reduce` the editor stylesheet brings every transition and animation to
  near zero, spinners (`animate-spin`) excepted. Frames and renders do not load that stylesheet and are unchanged.
- `requestSecret`: `startServer({ requestSecret })` (32 characters or more, else `startServer()` throws) makes both
  servers answer 403 to any request without `X-Cadence-Secret` equal to it, compared in constant time over SHA-256
  digests (`hasRequestSecret()` in `server/http.ts`), before any other guard. `GET /oauth/<network>/callback` and `/mcp`
  keep their own guards instead. A plain browser cannot send the header, so a host app sets it on every request of its
  own window (the editor origin and every frame origin: a host matches `*.localhost:<framePort>`, or the hosts
  `frameSite()` in `src/shared/frameOrigin.ts` accepts); Cadence's capture and render pages add it themselves. Without the option,
  nothing changes. The editor opens two kinds of editor-origin URL in a new tab, outside that window: a network's
  connection page (`Profile.tsx`, `window.open`), which ends on `/oauth/<network>/callback`, and the captured
  references of the Media panel (`/api/projects/:id/assets/file`, `target="_blank"`). A host opens the first wherever it
  likes, since the callback is exempt; with the secret, the callback page drops its link back to the editor, which that
  tab could not load, so the person just closes the tab. A host opens the second in a window of its own session: the system
  browser gets a 403. `tests/server/http.test.ts` checks the editor origin, `tests/server/frame-secret.test.ts` the
  frame origin, `tests/e2e/frames.test.ts` a capture through it and a reference capture that never carries it.
- `browserServer`: `startServer({ browserServer })` (`BrowserServer` and `ChromiumOptions` in `server/contracts.ts`)
  lets a host app start the Chromium process itself, for a host whose binary cannot run as Node (an Electron app with
  its RunAsNode fuse off, where forking would start a second app). The core calls it at every launch: the captures'
  browser and each relaunch after it is lost, each render, and `launchChromium(hook)` (`server/capture/capture.ts`) for
  a host's own pages. It receives the core's launch options (arguments, sandbox, signal handling: JSON) and forwards
  them as is to `serveChromium(options)` from `server/capture/serve-chromium.mjs` (typed by `serve-chromium.d.mts`),
  run in a process of the host's own. That process ignores SIGINT, SIGTERM and SIGHUP, so Cadence closes Chromium
  itself; since no signal ends it, the host ends it when the process that called `startServer()` ends, as the core's
  fork follows its IPC channel. The hook must settle (it may reject: the person then reads
  "Chromium does not start" with the host's message); the core does not time it out, since a launch it gave up on
  would leave a process nobody closes. It resolves to `{ wsEndpoint, exited, close() }`: `wsEndpoint` is the one
  `serveChromium()` returned, a Unix socket in a 0700 folder (`ws+unix:`); the core refuses any other endpoint, and
  calls `close()`, since a loopback TCP endpoint would let any local process drive the browser. `exited` settles
  (resolves or rejects) once that process has ended, and the captures in flight then fail and the next capture calls
  the hook again. `close()` ends the process and removes the socket folder (`dir` of `serveChromium()`), even after a
  fatal end, since the process may die without running its exit handlers (a page logging 300 MB); it settles within
  10 s, killing the process if it must. The core calls it once, when the browser is closed or lost, when a launch
  fails after the hook resolved, and when the server closes; it waits 11 s at most, and past that the process and its
  folder are the host's to end. Without the option, the core forks `chromium-server.mjs`.
  `tests/server/browser-host.test.ts` checks the calls, `exited` (resolved and rejected), `close()`, the refused
  endpoint, a failed connection, the server's close, a refused launch, a render and the 300 MB page through a host's
  process.
- `--dev` (`dev: true`) is reserved to work on the core itself: `startServer()` refuses it together with `editorRoot`.
- The frame origins never serve `editorRoot`: its Vite server keeps the core as its root and its `fs.allow` list.
- `projectsDir` and `brandsDir` (and `templatesDir`) may live anywhere, e.g. in the host's user data. Scenes and brand
  kits there import the core's packages and nothing else: the Cadence plugin of the frames Vite server resolves them as
  the runtime would, never from the importer's folder, and `resolve.dedupe` lists the core's `dependencies` (its
  `package.json`, read at start) so a package's own imports of them load the same copy. Vite's watcher gets them too, so edits made outside the editor still reload. `tests/server/outside-root.test.ts`
  checks both, and that the `CLAUDE.md` written there names no core path.

## Tests

`node:test` via `npm test` (tsx loader). Unit tests never need the network. E2E tests (`tests/e2e`) start a real
server on free ports with projects under `projects/e2e-*` (gitignored, cleaned up) and their state in a temp folder,
need Chromium (`npm run setup`) and ffmpeg, and use a fake `AgentProvider` (no real Claude calls).
`tests/editor/ui.test.ts` drives the editor in Chromium the same way. Assertions that depend on the capture locale
read it from `captureLocale()`, so `CADENCE_LOCALE` and the shell's language never fail a run.
