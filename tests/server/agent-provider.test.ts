import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { ClaudeCodeProvider, StreamJsonParser, claudeArgs, claudeEnv, writeTurnFiles } from '../../server/agent/claudeCode';
import type { AgentEvent, AgentTurn, CadenceConfig } from '../../server/contracts';

const SESSION = 'e4968699-bd4b-43fd-ae6f-4c9ec0e6fc41';

// Shapes recorded from `claude -p --output-format stream-json --verbose --include-partial-messages` (2.1.285),
// trimmed to the fields that matter, plus a tool round trip and a sub-agent line.
const STREAM = [
  { type: 'system', subtype: 'hook_started', hook_name: 'SessionStart:startup', session_id: SESSION },
  { type: 'system', subtype: 'init', cwd: '/tmp/p', session_id: SESSION, model: 'claude-opus-5-5', permissionMode: 'dontAsk' },
  { type: 'system', subtype: 'status', status: 'requesting', session_id: SESSION },
  {
    type: 'stream_event',
    event: { type: 'message_start', message: { id: 'msg_1', role: 'assistant', content: [] } },
    parent_tool_use_id: null,
  },
  {
    type: 'stream_event',
    event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    parent_tool_use_id: null,
  },
  {
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Le titre' } },
    parent_tool_use_id: null,
  },
  {
    type: 'assistant',
    message: { id: 'msg_1', content: [{ type: 'thinking', thinking: 'Le titre doit grossir.', signature: 'x' }] },
    parent_tool_use_id: null,
  },
  { type: 'stream_event', event: { type: 'content_block_stop', index: 0 }, parent_tool_use_id: null },
  {
    type: 'stream_event',
    event: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    parent_tool_use_id: null,
  },
  {
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Je regarde ' } },
    parent_tool_use_id: null,
  },
  {
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'la scène.' } },
    parent_tool_use_id: null,
  },
  {
    type: 'assistant',
    message: { id: 'msg_1', content: [{ type: 'text', text: 'Je regarde la scène.' }] },
    parent_tool_use_id: null,
  },
  {
    type: 'stream_event',
    event: { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'Edit', input: {} } },
    parent_tool_use_id: null,
  },
  {
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"file_path"' } },
    parent_tool_use_id: null,
  },
  {
    type: 'assistant',
    message: {
      id: 'msg_1',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'Edit', input: { file_path: '/tmp/p/scenes/intro.tsx' } }],
    },
    parent_tool_use_id: null,
  },
  {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'The file has been updated.', is_error: false }],
    },
    parent_tool_use_id: null,
  },
  // Sub-agent traffic is ignored.
  {
    type: 'assistant',
    message: { id: 'msg_sub', content: [{ type: 'text', text: 'sub-agent' }] },
    parent_tool_use_id: 'toolu_task',
  },
  { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_2' } }, parent_tool_use_id: null },
  {
    type: 'assistant',
    message: {
      id: 'msg_2',
      content: [{ type: 'tool_use', id: 'toolu_2', name: 'mcp__cadence__render_frames', input: { times: [0, 1.2] } }],
    },
    parent_tool_use_id: null,
  },
  {
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_2',
          is_error: false,
          content: [
            { type: 'text', text: 'Rendered 2 frames' },
            { type: 'image', source: { type: 'base64', data: 'AA==' } },
          ],
        },
      ],
    },
    parent_tool_use_id: null,
  },
  { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_3' } }, parent_tool_use_id: null },
  {
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Titre agrandi.' } },
    parent_tool_use_id: null,
  },
  { type: 'assistant', message: { id: 'msg_3', content: [{ type: 'text', text: 'Titre agrandi.' }] }, parent_tool_use_id: null },
  { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' }, session_id: SESSION },
  {
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 1179,
    result: 'Titre agrandi.',
    session_id: SESSION,
    total_cost_usd: 0.046667,
    modelUsage: {
      'claude-opus-5-5': {
        inputTokens: 12,
        outputTokens: 340,
        cacheReadInputTokens: 9000,
        cacheCreationInputTokens: 1500,
        webSearchRequests: 0,
        costUSD: 0.04,
      },
      'claude-haiku-4-5-20251001': {
        inputTokens: 3,
        outputTokens: 20,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 400,
        webSearchRequests: 0,
        costUSD: 0.006667,
      },
    },
  },
].map((line) => JSON.stringify(line));

const EXPECTED: AgentEvent[] = [
  { type: 'init', sessionId: SESSION, model: 'claude-opus-5-5' },
  { type: 'note', text: 'Le titre doit grossir.' },
  { type: 'text-delta', text: 'Je regarde ' },
  { type: 'text-delta', text: 'la scène.' },
  { type: 'tool-start', id: 'toolu_1', name: 'Edit', input: { file_path: '/tmp/p/scenes/intro.tsx' } },
  { type: 'tool-end', id: 'toolu_1', isError: false, output: 'The file has been updated.' },
  { type: 'tool-start', id: 'toolu_2', name: 'mcp__cadence__render_frames', input: { times: [0, 1.2] } },
  { type: 'tool-end', id: 'toolu_2', isError: false, output: 'Rendered 2 frames\n[image]' },
  { type: 'text-delta', text: 'Titre agrandi.' },
  {
    type: 'done',
    text: 'Titre agrandi.',
    isError: false,
    durationMs: 1179,
    costUsd: 0.046667,
    tokens: { input: 15, output: 360, cacheRead: 9000, cacheWrite: 1900 },
    sessionId: SESSION,
    subtype: 'success',
  },
];

function parse(lines: string[], agent?: string | null): AgentEvent[] {
  const events: AgentEvent[] = [];
  const parser = new StreamJsonParser((e) => events.push(e), agent);
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
    allow: ['Read(//p/**)', 'Glob', 'mcp__cadence__render_frames'],
    deny: ['Read(//s/**)'],
    addDirs: ['/brands/cadence', '/templates'],
    mcpServers: { cadence: { type: 'http', url: 'http://127.0.0.1:5299/mcp', headers: { Authorization: 'Bearer tok' } } },
    sessionId: SESSION,
    resume: false,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe('StreamJsonParser', () => {
  test('maps a real stream onto agent events', () => {
    assert.deepEqual(parse(STREAM), EXPECTED);
  });

  test('ignores blank and malformed lines', () => {
    assert.deepEqual(parse(['', 'not json', '42', 'null']), []);
  });

  test('explains login errors in French', () => {
    const [done] = parse([
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: true,
        result: 'Not logged in · Please run /login',
        duration_ms: 3,
      }),
    ]);
    assert.equal(done.type, 'done');
    assert.ok(done.type === 'done' && done.isError);
    assert.match(
      (done as { text: string }).text,
      /n’est pas connecté à votre compte Claude : ouvrez un terminal.*\/login, et réessayez\./s,
    );
    assert.match((done as { text: string }).text, /Not logged in/);
  });

  test('wraps other errors in French and keeps the subtype', () => {
    const [done] = parse([JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, duration_ms: 3 })]);
    assert.deepEqual(done, {
      type: 'done',
      text: 'Claude Code a renvoyé une erreur (error_max_turns).',
      isError: true,
      durationMs: 3,
      costUsd: undefined,
      tokens: undefined,
      sessionId: undefined,
      subtype: 'error_max_turns',
    });
  });

  test('says "Notre IA" when the host hides the agent, and never sends the person to a CLI login', () => {
    const [failed] = parse(
      [JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, result: 'balance 0' })],
      null,
    );
    assert.equal((failed as { text: string }).text, 'Notre IA a renvoyé une erreur (error_max_turns) : balance 0');
    const [refused] = parse(
      [JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'authentication_error: 401' })],
      null,
    );
    assert.equal((refused as { text: string }).text, 'Notre IA a refusé la connexion : réessayez.\n\nauthentication_error: 401');
  });
});

describe('claudeArgs', () => {
  const FILES = { systemPrompt: '/tmp/t/system-prompt.md', mcpConfig: '/tmp/t/mcp.json' };

  test('builds the documented command line', () => {
    const args = claudeArgs(turn(), FILES);
    assert.deepEqual(args.slice(0, 9), [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--model',
      'claude-opus-5-5',
      '--effort',
      'high',
    ]);
    for (const flag of ['--restricted', '--strict-mcp-config']) assert.ok(args.includes(flag), flag);
    assert.equal(args[args.indexOf('--tools') + 1], 'Read,Edit,Write,Glob,Grep');
    assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
    assert.equal(args[args.indexOf('--permission-prompts') + 1], 'none');
    // Variadic lists end at the next option.
    const allow = args.indexOf('--allowedTools');
    assert.deepEqual(args.slice(allow + 1, allow + 4), ['Read(//p/**)', 'Glob', 'mcp__cadence__render_frames']);
    assert.deepEqual(args.slice(allow + 4, allow + 6), ['--disallowedTools', 'Read(//s/**)']);
    assert.equal(args[allow + 6], '--add-dir');
    assert.deepEqual(args.slice(allow + 7, allow + 9), ['/brands/cadence', '/templates']);
    assert.equal(args[allow + 9], '--mcp-config');
    assert.equal(args[allow + 10], FILES.mcpConfig);
    assert.equal(args[args.indexOf('--append-system-prompt-file') + 1], FILES.systemPrompt);
    assert.deepEqual(args.slice(-2), ['--session-id', SESSION]);
    assert.ok(!args.includes('Agrandis le titre'), 'the prompt goes through stdin');
    assert.ok(!args.some((a) => a.includes('Bearer')), 'the MCP token never appears on the command line');
  });

  test('writes the guide and the MCP config to private files, removed by cleanup', () => {
    const { files, cleanup } = writeTurnFiles(turn());
    try {
      assert.equal(readFileSync(files.systemPrompt, 'utf8'), '# Cadence guide');
      assert.deepEqual(JSON.parse(readFileSync(files.mcpConfig, 'utf8')), { mcpServers: turn().mcpServers });
      assert.equal(statSync(files.mcpConfig).mode & 0o777, 0o600);
      assert.equal(statSync(path.dirname(files.mcpConfig)).mode & 0o777, 0o700);
    } finally {
      cleanup();
    }
    assert.ok(!existsSync(path.dirname(files.mcpConfig)));
  });

  test('omits --effort when the model does not support it, and resumes sessions', () => {
    const args = claudeArgs(turn({ effort: null, resume: true }), FILES);
    assert.ok(!args.includes('--effort'));
    assert.deepEqual(args.slice(-2), ['--resume', SESSION]);
  });
});

describe('claudeEnv', () => {
  const parent = {
    PATH: '/usr/bin',
    CLAUDECODE: '1',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_CODE_SESSION_ID: 'x',
    CLAUDE_CODE_SESSION_ATTENDED: '1',
    CLAUDE_CODE_CHILD_SESSION: '1',
    CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/s.sock',
    CLAUDE_EFFORT: 'max',
    CLAUDE_CODE_OAUTH_TOKEN: 'keep-me',
    ANTHROPIC_API_KEY: 'sk-test',
  };

  test('removes nested-session markers and the API key', () => {
    const env = claudeEnv(parent, false);
    assert.deepEqual(env, {
      PATH: '/usr/bin',
      CLAUDE_CODE_OAUTH_TOKEN: 'keep-me',
      MCP_TOOL_TIMEOUT: '300000',
      MAX_MCP_OUTPUT_TOKENS: '120000',
    });
    assert.equal(parent.CLAUDECODE, '1', 'the source is not modified');
  });

  test('keeps the API key when asked', () => {
    assert.equal(claudeEnv(parent, true).ANTHROPIC_API_KEY, 'sk-test');
  });
});

describe('ClaudeCodeProvider (fake claude binary)', () => {
  let dir: string;
  let bin: string;

  // Records its arguments, stdin and cwd, then prints the stream above (or hangs when the prompt says so).
  const script = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('9.9.9 (Claude Code)'); process.exit(0); }
if (args[0] === 'auth') { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' })); process.exit(0); }
let stdin = '';
process.stdin.on('data', (d) => (stdin += d));
process.stdin.on('end', () => {
  const after = (flag) => args[args.indexOf(flag) + 1];
  const mcp = fs.readFileSync(after('--mcp-config'), 'utf8');
  const guide = fs.readFileSync(after('--append-system-prompt-file'), 'utf8');
  fs.writeFileSync(path.join(__dirname, 'call.json'), JSON.stringify({ args, stdin, cwd: process.cwd(), mcp, guide }));
  if (stdin === 'HANG') return setInterval(() => {}, 1000);
  if (stdin === 'CRASH') { process.stderr.write('boom: something broke\\n'); process.exit(3); }
  if (stdin === 'LOGGED_OUT') { process.stderr.write('Not logged in\\n'); process.exit(1); }
  process.stdout.write(fs.readFileSync(path.join(__dirname, 'stream.jsonl'), 'utf8'));
});
`;

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cadence-claude-'));
    bin = path.join(dir, 'claude');
    await fs.writeFile(bin, script, { mode: 0o755 });
    await fs.writeFile(path.join(dir, 'stream.jsonl'), `${STREAM.join('\n')}\n`);
  });
  after(() => fs.rm(dir, { recursive: true, force: true }));

  const provider = (overrides: Partial<CadenceConfig> = {}, agent?: string | null) =>
    new ClaudeCodeProvider({ claudePath: bin, useApiKey: false, agentLog: null, ...overrides } as CadenceConfig, agent);

  async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
    const out: AgentEvent[] = [];
    for await (const e of events) out.push(e);
    return out;
  }

  test('runs a turn: prompt on stdin, cwd, events, raw log', async () => {
    const log = path.join(dir, 'agent.log');
    const events = await collect(provider({ agentLog: log }).run(turn({ cwd: dir })));
    assert.deepEqual(events, EXPECTED);
    const call = JSON.parse(await fs.readFile(path.join(dir, 'call.json'), 'utf8'));
    assert.equal(call.stdin, 'Agrandis le titre');
    assert.equal(await fs.realpath(call.cwd), await fs.realpath(dir));
    const mcpFile = call.args[call.args.indexOf('--mcp-config') + 1];
    const guideFile = call.args[call.args.indexOf('--append-system-prompt-file') + 1];
    assert.deepEqual(call.args, claudeArgs(turn({ cwd: dir }), { systemPrompt: guideFile, mcpConfig: mcpFile }));
    assert.deepEqual(JSON.parse(call.mcp), { mcpServers: turn().mcpServers });
    assert.equal(call.guide, '# Cadence guide');
    assert.ok(!existsSync(mcpFile), 'turn files are removed when the turn ends');
    assert.equal((await fs.readFile(log, 'utf8')).trim().split('\n').length, STREAM.length);
  });

  test('stop: SIGINT ends the turn as aborted', async () => {
    const abort = new AbortController();
    const running = collect(provider().run(turn({ cwd: dir, prompt: 'HANG', signal: abort.signal })));
    setTimeout(() => abort.abort(), 300);
    const events = await running;
    assert.equal(events.length, 1);
    assert.deepEqual(
      { ...events[0], durationMs: 0 },
      { type: 'done', text: 'Arrêté.', isError: false, durationMs: 0, subtype: 'aborted' },
    );
  });

  test('a crash without result reports the end of stderr in French', async () => {
    const [done] = await collect(provider().run(turn({ cwd: dir, prompt: 'CRASH' })));
    assert.ok(done.type === 'done' && done.isError && done.subtype === 'crashed');
    assert.match(
      (done as { text: string }).text,
      /^Claude Code s’est arrêté de façon inattendue \(code 3\) :\nboom: something broke/,
    );
  });

  test('a crash says "Notre IA" when the host hides the agent', async () => {
    const [crashed] = await collect(provider({}, null).run(turn({ cwd: dir, prompt: 'CRASH' })));
    assert.equal(
      (crashed as { text: string }).text,
      'Notre IA s’est arrêtée de façon inattendue (code 3) :\nboom: something broke',
    );
    const [refused] = await collect(provider({}, null).run(turn({ cwd: dir, prompt: 'LOGGED_OUT' })));
    assert.equal((refused as { text: string }).text, 'Notre IA a refusé la connexion : réessayez.\n\nNot logged in');
  });

  test('a missing binary ends the turn with a French error', async () => {
    const events = await collect(provider({ claudePath: path.join(dir, 'nope') }).run(turn({ cwd: dir })));
    assert.equal(events.length, 1);
    assert.ok(events[0].type === 'done' && events[0].isError);
    assert.match(
      (events[0] as { text: string }).text,
      /Impossible de lancer Claude Code.*Installez Claude Code ou réglez CLAUDE_PATH\./,
    );
  });

  test('status: version and login', async () => {
    assert.deepEqual(await provider().status(), {
      ok: true,
      label: 'Claude Code',
      version: '9.9.9',
      detail: 'Connecté (claude.ai, max)',
    });
    const missing = await provider({ claudePath: path.join(dir, 'nope') }).status();
    assert.equal(missing.ok, false);
    assert.match(missing.detail ?? '', /introuvable .*: installez-le et connectez-vous, ou réglez CLAUDE_PATH/);
  });
});
