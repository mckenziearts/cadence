import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { CodexProvider, CodexStreamParser, codexArgs, codexModels } from '../../server/agent/codex';
import type { AgentEvent, AgentTurn, CadenceConfig } from '../../server/contracts';

const THREAD = '01a1023a-4aeb-7122-ae60-0ceebfe54ad1';

// Shapes recorded from `codex exec --json` (0.159.2), plus a reasoning note, a shell call, an MCP call and a file change.
const STREAM = [
  { type: 'thread.started', thread_id: THREAD },
  { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'item_0', type: 'reasoning', text: 'Je regarde la scène.' } },
  { type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: 'ls scenes' } },
  {
    type: 'item.completed',
    item: {
      id: 'item_1',
      type: 'command_execution',
      command: 'ls scenes',
      status: 'completed',
      exit_code: 0,
      aggregated_output: 'intro.tsx',
    },
  },
  { type: 'item.started', item: { id: 'item_2', type: 'mcp_tool_call', server: 'cadence', tool: 'render_frames' } },
  {
    type: 'item.completed',
    item: {
      id: 'item_2',
      type: 'mcp_tool_call',
      server: 'cadence',
      tool: 'render_frames',
      status: 'completed',
      result: 'Rendered 2 frames',
    },
  },
  {
    type: 'item.completed',
    item: { id: 'item_3', type: 'file_change', changes: [{ path: 'scenes/intro.tsx', kind: 'update' }] },
  },
  { type: 'item.completed', item: { id: 'item_4', type: 'agent_message', text: 'Titre agrandi.' } },
  {
    type: 'turn.completed',
    usage: {
      input_tokens: 25527,
      cached_input_tokens: 12288,
      cache_write_input_tokens: 0,
      output_tokens: 5,
      reasoning_output_tokens: 0,
    },
  },
].map((line) => JSON.stringify(line));

const EVENTS: AgentEvent[] = [
  { type: 'init', sessionId: THREAD },
  { type: 'note', text: 'Je regarde la scène.' },
  { type: 'tool-start', id: 'item_1', name: 'shell', input: { command: 'ls scenes' } },
  { type: 'tool-end', id: 'item_1', isError: false, output: 'intro.tsx' },
  { type: 'tool-start', id: 'item_2', name: 'mcp__cadence__render_frames', input: {} },
  { type: 'tool-end', id: 'item_2', isError: false, output: 'Rendered 2 frames' },
  { type: 'tool-start', id: 'item_3:scenes/intro.tsx', name: 'Edit', input: { file_path: 'scenes/intro.tsx' } },
  { type: 'tool-end', id: 'item_3:scenes/intro.tsx', isError: false, output: '' },
  { type: 'text', text: 'Titre agrandi.' },
  {
    type: 'done',
    text: 'Titre agrandi.',
    isError: false,
    durationMs: 0,
    tokens: { input: 25527, output: 5, cacheRead: 12288, cacheWrite: 0 },
    subtype: 'success',
  },
];

function parse(lines: string[]): AgentEvent[] {
  const events: AgentEvent[] = [];
  const parser = new CodexStreamParser((e) => events.push(e));
  for (const line of lines) parser.line(line);
  return events;
}

function turn(overrides: Partial<AgentTurn> = {}): AgentTurn {
  return {
    cwd: os.tmpdir(),
    prompt: 'Agrandis le titre',
    systemPrompt: '# Cadence guide',
    model: 'claude-opus-5-5',
    effort: 'high',
    tools: ['Read', 'Edit', 'Write', 'Glob', 'Grep'],
    allow: [],
    deny: [],
    addDirs: [],
    mcpServers: { cadence: { type: 'http', url: 'http://127.0.0.1:5299/mcp', headers: { Authorization: 'Bearer sk-cdx-9f' } } },
    sessionId: THREAD,
    resume: false,
    signal: new AbortController().signal,
    ...overrides,
  };
}

const config = (overrides: Partial<CadenceConfig> = {}) =>
  ({ codexPath: 'codex', mcpUrl: 'http://127.0.0.1:5299/mcp', agentLog: null, ...overrides }) as CadenceConfig;

describe('CodexStreamParser', () => {
  test('maps a real stream onto agent events', () => {
    assert.deepEqual(parse(STREAM), EVENTS);
  });

  test('ignores blank and malformed lines', () => {
    assert.deepEqual(parse(['', 'not json', '42', 'null']), []);
  });

  test('streams partial agent messages as deltas, then does not repeat them', () => {
    const events = parse([
      JSON.stringify({ type: 'item.updated', item: { id: 'm', type: 'agent_message', text: 'Titre ' } }),
      JSON.stringify({ type: 'item.updated', item: { id: 'm', type: 'agent_message', text: 'Titre agrandi.' } }),
      JSON.stringify({ type: 'item.completed', item: { id: 'm', type: 'agent_message', text: 'Titre agrandi.' } }),
    ]);
    assert.deepEqual(events, [
      { type: 'text-delta', text: 'Titre ' },
      { type: 'text-delta', text: 'agrandi.' },
    ]);
  });

  test('turn.failed becomes an error done event', () => {
    assert.deepEqual(parse([JSON.stringify({ type: 'turn.failed', error: { message: 'stream error' } })]), [
      { type: 'done', text: 'stream error', isError: true, durationMs: 0, tokens: undefined, subtype: 'error' },
    ]);
  });
});

describe('codexArgs', () => {
  test('fresh turn: json, sandbox, injected MCP, effort; prompt and token stay off the command line', () => {
    const args = codexArgs(turn(), config(), null);
    assert.equal(args[0], 'exec');
    for (const flag of ['--json', '--skip-git-repo-check', '--ignore-user-config']) assert.ok(args.includes(flag), flag);
    assert.ok(args.includes('mcp_servers.cadence.url="http://127.0.0.1:5299/mcp"'));
    assert.ok(args.includes('mcp_servers.cadence.bearer_token_env_var="CADENCE_MCP_TOKEN"'));
    assert.ok(args.includes('sandbox_mode="workspace-write"'));
    assert.ok(args.includes('project_doc_max_bytes=0'));
    assert.ok(args.includes('model_reasoning_effort="high"'));
    assert.equal(args.at(-1), '-');
    assert.ok(!args.includes('Agrandis le titre'), 'the prompt goes through stdin');
    assert.ok(!args.some((a) => a === '-m'), 'no model when none resolved');
    assert.ok(
      !args.some((a) => a.includes('Bearer') || a.includes('sk-cdx-9f')),
      'the MCP token never appears on the command line',
    );
  });

  test('passes the effort through unchanged (xhigh/max/ultra are native); none when the turn has none', () => {
    assert.ok(codexArgs(turn({ effort: 'xhigh' }), config(), null).includes('model_reasoning_effort="xhigh"'));
    assert.ok(codexArgs(turn({ effort: 'max' }), config(), null).includes('model_reasoning_effort="max"'));
    assert.ok(!codexArgs(turn({ effort: null }), config(), null).some((a) => a.startsWith('model_reasoning_effort')));
  });

  test('passes a resolved model with -m', () => {
    const args = codexArgs(turn(), config(), 'gpt-6-sol');
    assert.equal(args[args.indexOf('-m') + 1], 'gpt-6-sol');
  });

  test('resume continues the thread by id', () => {
    const args = codexArgs(turn({ resume: true }), config(), null);
    assert.deepEqual(args.slice(0, 3), ['exec', 'resume', THREAD]);
    assert.ok(args.includes('--json'));
    assert.equal(args.at(-1), '-');
  });
});

describe('CodexProvider (fake codex binary)', () => {
  let dir: string;
  let bin: string;

  const script = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
if (args[0] === 'debug' && args[1] === 'models') {
  process.stdout.write(JSON.stringify([
    { slug: 'gpt-6-sol', display_name: 'GPT-6-Sol', description: 'Workhorse.', visibility: 'list', supported_in_api: true, default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }, { effort: 'ultra' }] },
    { slug: 'gpt-hidden', display_name: 'Hidden', visibility: 'hide', supported_in_api: true, supported_reasoning_levels: [] },
  ]));
  process.exit(0);
}
let stdin = '';
process.stdin.on('data', (d) => (stdin += d));
process.stdin.on('end', () => {
  fs.writeFileSync(path.join(__dirname, 'call.json'), JSON.stringify({ args, stdin, cwd: process.cwd(), token: process.env.CADENCE_MCP_TOKEN }));
  if (stdin.includes('HANG')) return setInterval(() => {}, 1000);
  if (stdin.includes('CRASH')) { process.stderr.write('boom: something broke\\n'); process.exit(3); }
  process.stdout.write(fs.readFileSync(path.join(__dirname, 'stream.jsonl'), 'utf8'));
});
`;

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cadence-codex-'));
    bin = path.join(dir, 'codex');
    await fs.writeFile(bin, script, { mode: 0o755 });
    await fs.writeFile(path.join(dir, 'stream.jsonl'), `${STREAM.join('\n')}\n`);
  });
  after(() => fs.rm(dir, { recursive: true, force: true }));

  const provider = (overrides: Partial<CadenceConfig> = {}) => new CodexProvider(config({ codexPath: bin, ...overrides }));

  async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
    const out: AgentEvent[] = [];
    for await (const e of events) out.push(e);
    return out;
  }

  test('codexModels: only the listed models, with their efforts and default', async () => {
    assert.deepEqual(await codexModels(config({ codexPath: bin })), [
      {
        id: 'gpt-6-sol',
        label: 'GPT-6-Sol',
        supportsEffort: true,
        hint: { fr: 'Workhorse.', en: 'Workhorse.' },
        efforts: ['low', 'high', 'ultra'],
        defaultEffort: 'medium',
      },
    ]);
  });

  test('runs a turn: guide then prompt on stdin, cwd, token in env, resolved model, events', async () => {
    const events = await collect(provider().run(turn({ cwd: dir, model: 'gpt-6-sol' })));
    const done = events.at(-1) as Extract<AgentEvent, { type: 'done' }>;
    assert.deepEqual(
      [...events.slice(0, -1), { ...done, durationMs: 0 }],
      [...EVENTS.slice(0, -1), { ...EVENTS.at(-1), sessionId: THREAD }],
    );
    const call = JSON.parse(await fs.readFile(path.join(dir, 'call.json'), 'utf8'));
    assert.equal(call.stdin, '# Cadence guide\n\nAgrandis le titre');
    assert.equal(call.token, 'sk-cdx-9f');
    assert.equal(await fs.realpath(call.cwd), await fs.realpath(dir));
    assert.equal(call.args[call.args.indexOf('-m') + 1], 'gpt-6-sol');
    assert.deepEqual(call.args, codexArgs(turn({ cwd: dir, model: 'gpt-6-sol' }), config({ codexPath: bin }), 'gpt-6-sol'));
  });

  test('resume sends the prompt alone (the guide already lives in the thread)', async () => {
    await collect(provider().run(turn({ cwd: dir, resume: true, prompt: 'Encore' })));
    const call = JSON.parse(await fs.readFile(path.join(dir, 'call.json'), 'utf8'));
    assert.equal(call.stdin, 'Encore');
  });

  test('stop: SIGINT ends the turn as aborted', async () => {
    const abort = new AbortController();
    const running = collect(provider().run(turn({ cwd: dir, prompt: 'HANG', signal: abort.signal })));
    setTimeout(() => abort.abort(), 300);
    const events = await running;
    assert.equal(events.length, 1);
    assert.deepEqual(
      { ...events[0], durationMs: 0 },
      { type: 'done', text: 'Arrêté.', isError: false, durationMs: 0, subtype: 'aborted', sessionId: undefined },
    );
  });

  test('a crash without a turn result reports the end of stderr in French', async () => {
    const [done] = await collect(provider().run(turn({ cwd: dir, prompt: 'CRASH' })));
    assert.ok(done.type === 'done' && done.isError && done.subtype === 'crashed');
    assert.match((done as { text: string }).text, /s’est arrêté de façon inattendue \(code 3\) :\nboom: something broke/);
  });

  test('a missing binary ends the turn with a French error', async () => {
    const events = await collect(provider({ codexPath: path.join(dir, 'nope') }).run(turn({ cwd: dir })));
    assert.equal(events.length, 1);
    assert.ok(events[0].type === 'done' && events[0].isError);
    assert.match((events[0] as { text: string }).text, /Impossible de lancer Codex.*Installez Codex ou réglez CODEX_PATH\./);
  });
});
