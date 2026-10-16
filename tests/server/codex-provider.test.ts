import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { CodexProvider, CodexStreamParser, codexArgs, codexEnv, codexModels } from '../../server/agent/codex';
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

  test('a turn.failed for a missing thread is session_lost, whatever text the agent name allows', () => {
    const line = JSON.stringify({
      type: 'turn.failed',
      error: { message: 'thread/resume failed: no rollout found for thread id x' },
    });
    const hidden: AgentEvent[] = [];
    new CodexStreamParser((e) => hidden.push(e), null).line(line);
    for (const done of [...parse([line]), ...hidden]) assert.equal(done.type === 'done' && done.subtype, 'session_lost');
  });

  test('only a missing rollout is session_lost: other failures keep the turn an error, not a fresh restart', () => {
    const subtype = (message: string) => {
      const done = parse([JSON.stringify({ type: 'turn.failed', error: { message } })]).at(-1);
      return done?.type === 'done' ? done.subtype : 'no done event';
    };
    assert.equal(subtype('No rollout found for conversation id 0199'), 'session_lost');
    for (const message of [
      'thread abc not found in the model reply',
      'failed to resume the stream: 503',
      'Session not found: tool',
    ])
      assert.equal(subtype(message), 'error', message);
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
  test('fresh turn: json, permission profile, injected MCP, effort; prompt and token stay off the command line', () => {
    const args = codexArgs(turn(), config(), null);
    assert.equal(args[0], 'exec');
    for (const flag of ['--json', '--skip-git-repo-check', '--ignore-user-config']) assert.ok(args.includes(flag), flag);
    assert.ok(args.includes('mcp_servers.cadence.url="http://127.0.0.1:5299/mcp"'));
    assert.ok(args.includes('mcp_servers.cadence.bearer_token_env_var="CADENCE_MCP_TOKEN"'));
    assert.ok(args.includes('default_permissions="cadence"'));
    assert.ok(args.includes('permissions.cadence.network.enabled=false'));
    assert.ok(!args.some((a) => a.startsWith('sandbox_mode')), 'workspace-write would make the whole cwd writable');
    assert.ok(args.includes('project_doc_max_bytes=0'));
    assert.ok(args.includes('approval_policy="never"'), 'a request for escalated permissions is never granted');
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

  test('the profile reads the cwd and addDirs, writes what the Edit and Write rules allow, and denies the deny rules', () => {
    const project = '/r/projects/p1';
    const args = codexArgs(
      turn({
        cwd: project,
        addDirs: ['/r/brands/acme', '/r/templates'],
        allow: [
          `Read(/${project}/**)`,
          'Glob',
          `Edit(/${project}/scenes/**)`,
          `Write(/${project}/scenes/**)`,
          `Edit(/${project}/art-direction.md)`,
          `Write(/${project}/art-direction.md)`,
          'mcp__cadence__render_frames',
        ],
        deny: ['Read(//r/.cadence/accounts.json)', 'Read(//r/.cadence/elevenlabs.json)'],
      }),
      config(),
      null,
    );
    assert.equal(
      args.find((a) => a.startsWith('permissions.cadence.filesystem')),
      'permissions.cadence.filesystem={":minimal"="read",":slash_tmp"="deny","/r/projects/p1"="read",' +
        '"/r/brands/acme"="read","/r/templates"="read","/r/projects/p1/scenes"="write",' +
        '"/r/projects/p1/art-direction.md"="write","/r/.cadence/accounts.json"="deny","/r/.cadence/elevenlabs.json"="deny"}',
    );
  });

  test('a brand build lists its folder once, writable, although it is also the cwd and an addDir', () => {
    const brand = '/r/brands/acme';
    const args = codexArgs(
      turn({ cwd: brand, addDirs: ['/r/.cadence/repos/acme', brand], allow: [`Edit(/${brand}/**)`, `Write(/${brand}/**)`] }),
      config(),
      null,
    );
    assert.equal(
      args.find((a) => a.startsWith('permissions.cadence.filesystem')),
      'permissions.cadence.filesystem={":minimal"="read",":slash_tmp"="deny","/r/brands/acme"="write","/r/.cadence/repos/acme"="read"}',
    );
  });

  test('a resumed turn keeps the same profile', () => {
    const profile = (resume: boolean) => codexArgs(turn({ resume }), config(), null).filter((a) => a.includes('permissions'));
    assert.deepEqual(profile(true), profile(false));
    assert.equal(profile(true).length, 3);
  });

  test('fresh and resumed turns load no execpolicy rules and give shell commands only PATH, HOME, TMPDIR and the locale', () => {
    for (const resume of [false, true]) {
      const args = codexArgs(turn({ resume }), config(), null);
      assert.ok(args.includes('--ignore-rules'), `--ignore-rules (resume: ${resume})`);
      assert.ok(args.includes('shell_environment_policy.inherit="core"'));
      assert.ok(args.includes('shell_environment_policy.include_only=["PATH","HOME","TMPDIR","LANG","LC_*"]'));
      assert.ok(!args.includes('-s'), 'exec resume has no -s: settings go through -c');
    }
  });
});

describe('codexEnv', () => {
  test('keeps only what Codex needs to run and log in, plus the MCP token', () => {
    const env = codexEnv(
      {
        PATH: '/usr/bin',
        HOME: '/Users/a',
        TMPDIR: '/tmp/a',
        LANG: 'fr_FR.UTF-8',
        LC_ALL: 'fr_FR.UTF-8',
        LC_MESSAGES: 'fr_FR.UTF-8',
        CODEX_HOME: '/Users/a/.codex',
        OPENAI_API_KEY: 'sk-openai',
        CODEX_ACCESS_TOKEN: 'cat',
        HTTP_PROXY: 'http://proxy:1',
        HTTPS_PROXY: 'http://proxy:2',
        NO_PROXY: 'localhost',
        ALL_PROXY: 'socks5://proxy:3',
        http_proxy: 'http://proxy:4',
        https_proxy: 'http://proxy:5',
        no_proxy: '127.0.0.1',
        all_proxy: 'socks5://proxy:6',
        SSL_CERT_FILE: '/etc/ssl/cert.pem',
        SSL_CERT_DIR: '/etc/ssl/certs',
        CODEX_CA_CERTIFICATE: '/etc/corp-ca.pem',
        AWS_SECRET_ACCESS_KEY: 'aws',
        GITHUB_TOKEN: 'ghp',
        ANTHROPIC_API_KEY: 'sk-ant',
        SSH_AUTH_SOCK: '/tmp/ssh',
        SHELL: '/bin/zsh',
        CADENCE_EDITOR_TOKEN: 'editor',
        CADENCE_MCP_TOKEN: 'stale',
        HTTPS_PROXY_PASSWORD: 'hunter2',
        MY_HTTP_PROXY: 'http://other:1',
        npm_config_https_proxy: 'http://npm:1',
        XLC_ALL: 'x',
        LC_: 'x',
      },
      'sk-cdx-9f',
    );
    assert.deepEqual(env, {
      PATH: '/usr/bin',
      HOME: '/Users/a',
      TMPDIR: '/tmp/a',
      LANG: 'fr_FR.UTF-8',
      LC_ALL: 'fr_FR.UTF-8',
      LC_MESSAGES: 'fr_FR.UTF-8',
      CODEX_HOME: '/Users/a/.codex',
      OPENAI_API_KEY: 'sk-openai',
      CODEX_ACCESS_TOKEN: 'cat',
      HTTP_PROXY: 'http://proxy:1',
      HTTPS_PROXY: 'http://proxy:2',
      NO_PROXY: 'localhost',
      ALL_PROXY: 'socks5://proxy:3',
      http_proxy: 'http://proxy:4',
      https_proxy: 'http://proxy:5',
      no_proxy: '127.0.0.1',
      all_proxy: 'socks5://proxy:6',
      SSL_CERT_FILE: '/etc/ssl/cert.pem',
      SSL_CERT_DIR: '/etc/ssl/certs',
      CODEX_CA_CERTIFICATE: '/etc/corp-ca.pem',
      CADENCE_MCP_TOKEN: 'sk-cdx-9f',
    });
  });

  test('drops the empty and relative PATH entries a spawn would resolve inside the turn folder', () => {
    assert.equal(codexEnv({ PATH: ':/usr/bin:.:bin::/opt/bin:' }, 'tok').PATH, '/usr/bin:/opt/bin');
  });

  test('leaves no PATH at all when none of its entries is absolute', () => {
    for (const value of ['.', 'relative/bin', '']) assert.ok(!('PATH' in codexEnv({ PATH: value }, 'tok')), value);
  });

  test('leaves out what is not set', () => {
    assert.deepEqual(codexEnv({ PATH: '/usr/bin', OPENAI_API_KEY: undefined }, 'tok'), {
      PATH: '/usr/bin',
      CADENCE_MCP_TOKEN: 'tok',
    });
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
const name = path.basename(__filename);
if (args[0] === '--version') { process.stdout.write(name === 'codex-old' ? 'codex-cli 0.160.0\\n' : 'codex-cli 0.161.0\\n'); process.exit(0); }
if (args[0] === 'login') {
  if (name === 'codex-logged-out') { process.stdout.write('Not logged in\\n'); process.exit(1); }
  process.stdout.write('Logged in using ChatGPT\\n');
  process.exit(0);
}
// The probe reads a file inside the profile, then one outside: a CLI that ignores the profile prints both.
if (args[0] === 'sandbox') {
  const files = name === 'codex-unconfined' ? args.slice(-2) : args.slice(-2, -1);
  for (const file of files) process.stdout.write(fs.readFileSync(file));
  process.exit(1);
}
let stdin = '';
process.stdin.on('data', (d) => (stdin += d));
process.stdin.on('end', () => {
  fs.writeFileSync(path.join(__dirname, 'call.json'), JSON.stringify({ args, stdin, cwd: process.cwd(), token: process.env.CADENCE_MCP_TOKEN, env: process.env }));
  if (name === 'codex-lost-thread' && args[1] === 'resume') {
    process.stderr.write('Error: thread/resume: thread/resume failed: no rollout found for thread id ' + args[2] + ' (code -32600)\\n');
    process.exit(1);
  }
  if (stdin.includes('HANG')) return setInterval(() => {}, 1000);
  if (stdin.includes('CRASH')) { process.stderr.write('boom: something broke\\ncodex_core: ChatGPT request to OpenAI failed\\n'); process.exit(3); }
  if (stdin.includes('LOGGED_OUT')) { process.stderr.write('401 Unauthorized: run codex login with ChatGPT\\n'); process.exit(1); }
  if (stdin.includes('FAILED')) {
    process.stdout.write(JSON.stringify({ type: 'item.completed', item: { id: 'e', type: 'error', message: 'Codex could not reach ChatGPT' } }) + '\\n');
    process.stdout.write(JSON.stringify({ type: 'turn.failed', error: { message: 'Codex hit the OpenAI usage limit' } }) + '\\n');
    process.exit(1);
  }
  process.stdout.write(fs.readFileSync(path.join(__dirname, 'stream.jsonl'), 'utf8'));
});
`;

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cadence-codex-'));
    bin = path.join(dir, 'codex');
    await fs.writeFile(bin, script, { mode: 0o755 });
    for (const variant of ['codex-unconfined', 'codex-logged-out', 'codex-old', 'codex-lost-thread'])
      await fs.writeFile(path.join(dir, variant), script, { mode: 0o755 });
    await fs.writeFile(path.join(dir, 'stream.jsonl'), `${STREAM.join('\n')}\n`);
  });
  after(() => fs.rm(dir, { recursive: true, force: true }));

  const provider = (overrides: Partial<CadenceConfig> = {}, agent?: string | null) =>
    new CodexProvider(config({ codexPath: bin, ...overrides }), agent);

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
    // The profile gets real paths: on macOS the temp folder is reached through a symlink.
    const real = await fs.realpath(dir);
    assert.deepEqual(call.args, codexArgs(turn({ cwd: real, model: 'gpt-6-sol' }), config({ codexPath: bin }), 'gpt-6-sol'));
  });

  test('the child sees neither an unrelated variable nor a secret from the parent', async (t) => {
    t.after(() => {
      delete process.env.CADENCE_TEST_UNRELATED;
      delete process.env.CADENCE_TEST_SECRET_KEY;
    });
    process.env.CADENCE_TEST_UNRELATED = 'unrelated';
    process.env.CADENCE_TEST_SECRET_KEY = 'sk-fake-secret';
    await collect(provider().run(turn({ cwd: dir })));
    const { env } = JSON.parse(await fs.readFile(path.join(dir, 'call.json'), 'utf8'));
    assert.equal(env.CADENCE_TEST_UNRELATED, undefined);
    assert.equal(env.CADENCE_TEST_SECRET_KEY, undefined);
    assert.ok(!JSON.stringify(env).includes('sk-fake-secret'));
    assert.equal(env.CADENCE_MCP_TOKEN, 'sk-cdx-9f');
    assert.equal(env.PATH, process.env.PATH);
    // macOS adds __CF_USER_TEXT_ENCODING to every new process.
    const seen = Object.keys(env).filter((name) => name !== '__CF_USER_TEXT_ENCODING');
    assert.deepEqual(seen.sort(), Object.keys(codexEnv(process.env, 'sk-cdx-9f')).sort());
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
    assert.match((done as { text: string }).text, /^Codex s’est arrêté de façon inattendue \(code 3\) :\nboom: something broke/);
  });

  test('a crash says "Notre IA" when the host hides the agent, and never sends the person to a CLI login', async () => {
    const [crashed] = await collect(provider({}, null).run(turn({ cwd: dir, prompt: 'CRASH' })));
    assert.equal((crashed as { text: string }).text, 'Notre IA s’est arrêtée de façon inattendue (code 3).');
    const [refused] = await collect(provider({}, null).run(turn({ cwd: dir, prompt: 'LOGGED_OUT' })));
    assert.equal((refused as { text: string }).text, 'Notre IA a refusé la connexion : réessayez.');
  });

  /** The texts a turn shows: its notes, tool outputs and the done text. */
  const shown = (events: AgentEvent[]) =>
    JSON.stringify(events.map((e) => ('text' in e ? e.text : 'output' in e ? e.output : '')));
  const NAMES = /codex|chatgpt|openai/i;

  test('a spawn failure, a crash and a failed turn never name Codex when the host hides the agent', async () => {
    const missing = provider({ codexPath: path.join(dir, 'codex-gone') }, null);
    missing.status = () => Promise.resolve({ ok: true, label: 'Codex' });
    const spawned = await collect(missing.run(turn({ cwd: dir })));
    const done = spawned.at(-1);
    assert.equal(done?.type === 'done' ? done.subtype : undefined, 'spawn_error', JSON.stringify(spawned));
    assert.doesNotMatch(shown(spawned), NAMES);
    for (const prompt of ['CRASH', 'LOGGED_OUT', 'FAILED']) {
      const events = await collect(provider({}, null).run(turn({ cwd: dir, prompt })));
      assert.ok(events.at(-1)?.type === 'done' && (events.at(-1) as { isError: boolean }).isError, prompt);
      assert.doesNotMatch(shown(events), NAMES, prompt);
    }
    const [failed] = (await collect(provider({}, null).run(turn({ cwd: dir, prompt: 'FAILED' })))).slice(-1);
    assert.equal((failed as { text: string }).text, 'Notre IA s’est arrêtée sur une erreur.');
  });

  test("a named agent keeps the spawn error, the stderr tail and Codex's own message", async () => {
    const missing = provider({ codexPath: path.join(dir, 'codex-gone') });
    missing.status = () => Promise.resolve({ ok: true, label: 'Codex' });
    const [spawned] = await collect(missing.run(turn({ cwd: dir })));
    assert.match((spawned as { text: string }).text, /^Impossible de lancer Codex \(« .*codex-gone »\) : .*CODEX_PATH\.$/);
    const [crashed] = await collect(provider().run(turn({ cwd: dir, prompt: 'CRASH' })));
    assert.equal(
      (crashed as { text: string }).text,
      'Codex s’est arrêté de façon inattendue (code 3) :\nboom: something broke\ncodex_core: ChatGPT request to OpenAI failed',
    );
    const [loggedOut] = await collect(provider().run(turn({ cwd: dir, prompt: 'LOGGED_OUT' })));
    assert.equal(
      (loggedOut as { text: string }).text,
      'Codex n’est pas connecté : ouvrez un terminal, lancez « codex login », puis réessayez.\n\n' +
        '401 Unauthorized: run codex login with ChatGPT',
    );
    const failed = await collect(provider().run(turn({ cwd: dir, prompt: 'FAILED' })));
    assert.deepEqual(
      failed.map((e) => ('text' in e ? e.text : e.type)),
      ['Codex could not reach ChatGPT', 'Codex hit the OpenAI usage limit'],
    );
  });

  test('a turn gets real paths in its profile and cwd, a writable folder not created yet included', async (t) => {
    const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cadence-codex-real-')));
    t.after(() => fs.rm(tmp, { recursive: true, force: true }));
    const real = path.join(tmp, 'real');
    const linked = path.join(tmp, 'linked');
    await fs.mkdir(path.join(real, 'p1', 'scenes'), { recursive: true });
    await fs.symlink(real, linked);

    await collect(
      provider().run(
        turn({
          cwd: path.join(linked, 'p1'),
          allow: [`Read(/${linked}/p1/**)`, `Edit(/${linked}/p1/components/**)`, `Write(/${linked}/p1/scenes/**)`],
          deny: [`Read(/${linked}/.cadence/accounts.json)`],
          addDirs: [path.join(linked, 'brand')],
        }),
      ),
    );
    const call = JSON.parse(await fs.readFile(path.join(dir, 'call.json'), 'utf8'));
    assert.equal(call.cwd, path.join(real, 'p1'));
    assert.equal(
      call.args.find((a: string) => a.startsWith('permissions.cadence.filesystem')),
      `permissions.cadence.filesystem={":minimal"="read",":slash_tmp"="deny","${real}/p1"="read","${real}/brand"="read",` +
        `"${real}/p1/components"="write","${real}/p1/scenes"="write","${real}/.cadence/accounts.json"="deny"}`,
    );
    assert.ok((await fs.lstat(path.join(real, 'p1', 'components'))).isDirectory(), 'the sandbox keeps an existing root');
  });

  test('a write target an earlier turn replaced with a symlink refuses the turn before spawning', async (t) => {
    const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cadence-codex-link-')));
    t.after(() => fs.rm(tmp, { recursive: true, force: true }));
    const project = path.join(tmp, 'p1');
    const outside = path.join(tmp, 'outside');
    await fs.mkdir(outside, { recursive: true });
    await fs.mkdir(project);
    await fs.writeFile(path.join(outside, 'target.txt'), 'secret');
    await fs.symlink(path.join(outside, 'target.txt'), path.join(project, 'art-direction.md'));
    await fs.symlink(outside, path.join(project, 'scenes'));

    for (const target of ['art-direction.md', 'scenes/intro.tsx']) {
      await fs.rm(path.join(dir, 'call.json'), { force: true });
      const events = await collect(provider().run(turn({ cwd: project, allow: [`Write(/${project}/${target})`] })));
      assert.equal(events.length, 1);
      const [done] = events;
      assert.ok(done.type === 'done' && done.isError, target);
      assert.match(done.text, /lien symbolique/);
      assert.equal(await fs.stat(path.join(dir, 'call.json')).catch(() => null), null, `${target}: codex never started`);
    }
  });

  test('a bare codexPath never runs a codex planted in the turn folder, whatever PATH holds', async (t) => {
    const cwd = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cadence-codex-planted-')));
    const marker = path.join(cwd, 'planted-ran');
    const pathEnv = process.env.PATH;
    t.after(async () => {
      if (pathEnv === undefined) delete process.env.PATH;
      else process.env.PATH = pathEnv;
      await fs.rm(cwd, { recursive: true, force: true });
    });
    // What an earlier turn can write in its own folder; the empty first PATH entry is that folder for spawn.
    await fs.writeFile(path.join(cwd, 'codex'), `#!/bin/sh\necho ran > '${marker}'\n`, { mode: 0o755 });
    process.env.PATH = ['', dir, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter);
    await fs.rm(path.join(dir, 'call.json'), { force: true });

    const events = await collect(new CodexProvider(config({ codexPath: 'codex' })).run(turn({ cwd })));
    assert.ok(events.at(-1)?.type === 'done' && !(events.at(-1) as { isError: boolean }).isError, JSON.stringify(events.at(-1)));
    assert.equal(await fs.stat(marker).catch(() => null), null, 'the planted codex never ran');
    assert.equal(JSON.parse(await fs.readFile(path.join(dir, 'call.json'), 'utf8')).cwd, cwd, 'the codex from PATH ran the turn');
  });

  test('a codex that ignores the permission profile is refused before spawning', async () => {
    await fs.rm(path.join(dir, 'call.json'), { force: true });
    const events = await collect(provider({ codexPath: path.join(dir, 'codex-unconfined') }).run(turn({ cwd: dir })));
    assert.equal(events.length, 1);
    const [done] = events;
    assert.ok(done.type === 'done' && done.isError && done.subtype === 'unconfined');
    assert.match(done.text, /ne sait pas limiter ses accès/);
    assert.equal(await fs.stat(path.join(dir, 'call.json')).catch(() => null), null, 'codex never started');
  });

  /** Runs a turn that must end before Codex starts: one error event, and no call.json from the fake binary. */
  async function refused(events: AsyncIterable<AgentEvent>, subtype: string): Promise<string> {
    await fs.rm(path.join(dir, 'call.json'), { force: true });
    const all = await collect(events);
    assert.equal(all.length, 1, JSON.stringify(all));
    const [done] = all;
    assert.ok(done.type === 'done' && done.isError, JSON.stringify(done));
    assert.equal(done.subtype, subtype);
    assert.equal(await fs.stat(path.join(dir, 'call.json')).catch(() => null), null, 'codex never started');
    return done.text;
  }

  test('a missing binary refuses the turn with a French error, before spawning anything', async () => {
    const text = await refused(provider({ codexPath: path.join(dir, 'nope') }).run(turn({ cwd: dir })), 'missing');
    assert.match(text, /Codex est introuvable \(« .*nope »\) : installez-le et connectez-vous, ou réglez CODEX_PATH\./);
  });

  test('a logged-out codex is refused before spawning', async () => {
    const text = await refused(provider({ codexPath: path.join(dir, 'codex-logged-out') }).run(turn({ cwd: dir })), 'logged-out');
    assert.match(text, /Codex n’est pas connecté/);
  });

  test('a codex older than 0.161.0 is refused before spawning, its sandbox not even asked', async () => {
    const text = await refused(provider({ codexPath: path.join(dir, 'codex-old') }).run(turn({ cwd: dir })), 'unconfined');
    assert.match(text, /ne sait pas limiter ses accès/);
  });

  test('a resumed turn whose thread Codex no longer has ends as session_lost, the agent named or hidden', async () => {
    for (const agent of [undefined, null]) {
      const events = await collect(
        provider({ codexPath: path.join(dir, 'codex-lost-thread') }, agent).run(turn({ cwd: dir, resume: true })),
      );
      const done = events.at(-1);
      assert.ok(done?.type === 'done' && done.isError, JSON.stringify(events));
      assert.equal(done.subtype, 'session_lost', String(agent));
      if (agent === null) assert.doesNotMatch(done.text, NAMES);
    }
  });

  test('a logged-out or unconfined Codex refuses a hidden-agent turn without naming Codex', async () => {
    for (const [variant, subtype] of [
      ['codex-logged-out', 'logged-out'],
      ['codex-unconfined', 'unconfined'],
      ['codex-old', 'unconfined'],
    ]) {
      const text = await refused(provider({ codexPath: path.join(dir, variant) }, null).run(turn({ cwd: dir })), subtype);
      assert.doesNotMatch(text, NAMES, variant);
      assert.match(text, /^Notre IA/, variant);
    }
  });

  test('a status that rejects ends the turn with an error instead of leaving it open', { timeout: 10_000 }, async () => {
    const codex = provider();
    codex.status = () => Promise.reject(new Error('status broke'));
    assert.match(await refused(codex.run(turn({ cwd: dir })), 'error'), /status broke/);
  });

  test('a refusal never names Codex when the host hides the agent', { timeout: 10_000 }, async () => {
    const codex = provider({}, null);
    codex.status = () => Promise.reject(new Error('codex sandbox broke'));
    const failed = await refused(codex.run(turn({ cwd: dir })), 'error');
    const missing = await refused(provider({ codexPath: path.join(dir, 'codex-nope') }, null).run(turn({ cwd: dir })), 'missing');
    for (const text of [failed, missing]) assert.equal(text, 'Notre IA a refusé la connexion : réessayez.');
  });

  test('a probe that cannot run refuses the turn instead of crashing the server', { timeout: 10_000 }, async (t) => {
    const tmpdir = process.env.TMPDIR;
    t.after(() => {
      if (tmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = tmpdir;
    });
    process.env.TMPDIR = path.join(dir, 'no-such-tmp');
    assert.match(await refused(provider().run(turn({ cwd: dir })), 'error'), /no-such-tmp/);
  });

  test('a brand build runs in its brand folder, writable, beside a readable clone and shared folder', async (t) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cadence-codex-build-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const [brand, repo, shared] = ['brands/acme', '.cadence/repos/acme', 'shared'].map((rel) => path.join(root, rel));
    for (const folder of [brand, repo, shared]) await fs.mkdir(folder, { recursive: true });
    await fs.rm(path.join(dir, 'call.json'), { force: true });

    const events = await collect(
      provider().run(
        turn({
          cwd: brand,
          allow: [`Read(/${repo}/**)`, `Read(/${brand}/**)`, `Edit(/${brand}/**)`, `Write(/${brand}/**)`],
          deny: [`Read(/${root}/.cadence/accounts.json)`],
          addDirs: [repo, brand, shared],
        }),
      ),
    );
    const done = events.at(-1);
    assert.ok(done?.type === 'done' && !done.isError, JSON.stringify(done));
    const call = JSON.parse(await fs.readFile(path.join(dir, 'call.json'), 'utf8'));
    assert.equal(call.cwd, brand);
    assert.equal(
      call.args.find((a: string) => a.startsWith('permissions.cadence.filesystem')),
      `permissions.cadence.filesystem={":minimal"="read",":slash_tmp"="deny","${brand}"="write","${repo}"="read",` +
        `"${shared}"="read","${root}/.cadence/accounts.json"="deny"}`,
    );
  });
});
