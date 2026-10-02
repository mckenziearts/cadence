# Third-party notices

## saeedvaziry/caleb-video-editor

Cadence adapts code from [saeedvaziry/caleb-video-editor](https://github.com/saeedvaziry/caleb-video-editor), Saeed
Vaziry's MIT-licensed reconstruction of Caleb Porzio's Storyboard editor: its music analyzer, and parts of its server,
preview frame, scene runtime and prompt card. Adapted files carry `// Adapted from saeedvaziry/caleb-video-editor (MIT)`
in their opening comments, or name the adapted parts there.

### Music analyzer

| Cadence file | Adapted from | Changes |
| --- | --- | --- |
| `server/music/decode.ts` | `server/music/decode.ts` | ffmpeg binary from the Cadence config, absolute input path, French errors |
| `server/music/fft.ts` | `server/music/fft.ts` | none |
| `server/music/features.ts` | `server/music/features.ts` | adds loudness-weighted low/mid attack envelopes |
| `server/music/beats.ts` | `server/music/beats.ts` | half-tempo check on loud mid-band attacks, double-tempo check, wider start margin, grid confidence |
| `server/music/structure.ts` | `server/music/structure.ts` | downbeat phase replaced by 3/4 vs 4/4 meter detection with snare-aware attack cues; ~1000-point waveform |
| `server/music/analyze.ts` | `server/music/analyze.ts` | analysis format version 2 (meter, confidence) |
| `server/music/cli.ts` | `server/music/cli.ts` | exported `runAnalyzeCli`, French output |
| `server/music/service.ts` | `server/musicContext.ts` (cut snapping, agent context) | rewritten around Cadence's music service contract |

Not taken: the ACE-Step generation engine (`engine.ts`, `engine-cli.ts`), the take library (`library.ts`) and the
generation service (`service.ts`).

### Other adapted files

- Agent: `server/agent/chat.ts`, `server/agent/claudeCode.ts`, `server/agent/guide.ts`, `server/agent/prompts.ts`.
- HTTP API and events: `server/api/index.ts`, `server/http.ts`, `server/hub.ts`.
- MCP: `server/mcp/server.ts`, `server/mcp/tools.ts`.
- Capture and render: `server/capture/capture.ts`, `server/capture/render.ts`, `server/capture/seams.ts`.
- Projects and setup checks: `server/store/projects.ts`, `server/doctor.ts`.
- Preview frame: `server/frames/vite.ts`, `src/frame/main.tsx`.
- Scene runtime: `src/runtime/animate.ts`, `src/runtime/easing.ts`, `src/runtime/music.ts`, `src/runtime/random.ts`.
- Parts of the scene runtime: the hex/rgb parsing and `rgba()` output in `src/runtime/color.ts`; `Fill`,
  `SceneContext`/`useScene` and `asset` in `src/runtime/scene.tsx`; `SplitText`, `typed` and the `SwapWords`
  choreography in `src/runtime/text.tsx`.
- Brand kit: `brands/cadence/extras/PromptCard.tsx`.

```
MIT License

Copyright (c) 2026 Saeed Vaziry

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Fonts and icons

The editor serves its own fonts from `src/editor/fonts`: Anton, Hanken Grotesk and Spline Sans Mono, latin and
latin-ext subsets from @fontsource 5.3.0, under the SIL Open Font License 1.1 (`src/editor/fonts/OFL.txt`, with each
font's copyright line).

The other fonts and the icon sets are npm dependencies (`@fontsource*`: SIL OFL 1.1; `@heroicons/react`,
`@tabler/icons-react`, `lucide-react`: MIT/ISC) and keep their own license files in `node_modules`.

Brands built in the app stay on each machine (`brands/` is gitignored except `cadence`): the fonts and logos they copy
keep their own licenses and terms.
