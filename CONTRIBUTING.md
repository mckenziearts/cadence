# Contributing

Bug reports and pull requests are welcome. The architecture is described in [ARCHITECTURE.md](ARCHITECTURE.md), the
code conventions in [AGENTS.md](AGENTS.md).

## License of contributions

Cadence is released under the [MIT license](LICENSE). By opening a pull request, you agree that your contribution is
released under the same license. There is no CLA to sign and no sign-off to add.

## Code adapted from another project

Code taken or adapted from another project names its source: add a comment such as
`// Adapted from <owner>/<repo> (<license>)` at the top of the file, and list the file in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) with the project, its license and what changed. Code under the GPL,
the AGPL or a source-available license is refused.

## Before opening a pull request

```bash
npm ci --ignore-scripts
npm run format:check
npm run typecheck
npm run test:unit
```

The CI runs the same checks, plus a secret scan. The end-to-end tests (`npm run test:e2e`) need Chromium
(`npm run setup`) and ffmpeg: run them when you change the editor, the preview or the render.
