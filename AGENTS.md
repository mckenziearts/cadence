# Cadence — notes for coding agents

This file is for AI coding agents working on the Cadence app itself. If you are editing a **video project** under
`projects/`, follow `projects/CLAUDE.md` instead (the app writes it at every start).

## Read first

`ARCHITECTURE.md` (the contract between modules), then the shared contracts: `src/shared/types.ts`,
`src/shared/brandKit.ts`, `src/shared/frameProtocol.ts`, `server/contracts.ts`, `server/util.ts`. The scene runtime
reference is `src/runtime/API.md` (it is also inlined into the in-app agent's system prompt: keep it accurate).

## Safety rules

- Install with `npm ci --ignore-scripts` only. Add a dependency only when asked, with
  `npm install --ignore-scripts --save-exact <pkg>@<version>`, and show the `package-lock.json` diff.
- Never commit, push or change branches unless the user explicitly asks for that step.
- Never stop processes you did not start: the user may have Cadence running. Use other ports
  (`npx tsx bin/cadence.ts start --port <p> --frame-port <p+1>`) and a private Vite cache
  (`CADENCE_VITE_CACHE_DIR=node_modules/.vite-<name>`) for your own servers.
- Never trigger real Claude turns from tests or scripts: inject a fake `AgentProvider` (`startServer({ provider })`).
- Keep the security model intact (ARCHITECTURE.md "Processes, origins and security"): two origins, editor token,
  MCP bearer tokens bound to scopes, restricted agent, frame CSP. New `/api` routes go through `server/http.ts` guards.

## Commands

```bash
npm run dev              # the editor from Vite's dev server (npm start serves a production build)
npm run typecheck        # tsc over src, server, bin, tests, brands, templates
npm test                 # everything (e2e needs Chromium: npm run setup, and ffmpeg)
npm run test:unit
npm run test:e2e
npm run format           # Prettier, width 130, single quotes
npm run doctor
```

## Conventions

- TypeScript strict ESM, run through tsx. User-facing strings (UI, API errors, chat labels, CLI) live in the French and
  English dictionaries (`src/editor/i18n/`, `server/i18n/`; `en/` is type-checked against `fr/`). English for code and
  comments. Sparse comments that explain why.
- Scenes, runtime components and brand kits are pure functions of their props: no state-driven animation, timers,
  `Date.now()`, `Math.random()`, CSS transitions/animations or network.
- Services depend on the interfaces in `server/contracts.ts`, wired in `server/index.ts`.
- Project files change on disk only through `ProjectStore` (locks + atomic writes); versions through `VersionStore`.
- Tests: `node:test` + `node:assert/strict`, deterministic and offline; e2e projects live under `projects/e2e-*`
  (gitignored) and are removed at the end, and servers started by tests get their own temp `stateDir`.
