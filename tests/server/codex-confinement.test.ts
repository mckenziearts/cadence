import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { allowRules, denyRules } from '../../server/agent/chat';
import { CodexProvider, codexModels } from '../../server/agent/codex';
import type { AgentEvent, AgentTurn, CadenceConfig } from '../../server/contracts';
import { readFileNoFollow } from '../../server/util';

function findCodex(): string | null {
  try {
    return execFileSync('/bin/sh', ['-c', 'command -v codex'], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

const codex = findCodex();

type Step = { cmd: string } | { patch: string } | { image: string };
type Json = Record<string, any>;

/**
 * A Responses API stand-in on 127.0.0.1: each request answers with the next scripted tool call (counted from the tool
 * outputs Codex sends back for this server's calls), then a final message. It records those outputs and every path it
 * is asked for. A resumed thread sends an earlier turn's calls back too: their ids name another server's port.
 */
async function fakeModel(steps: (port: number) => Step[]) {
  const outputs = new Map<string, string>();
  const paths: string[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      paths.push(req.url ?? '');
      if (req.method !== 'POST' || !req.url?.endsWith('/responses')) {
        res.writeHead(404).end();
        return;
      }
      const input = (JSON.parse(body).input ?? []) as Json[];
      const answered = input.filter(
        (item) => /_call_output$/.test(String(item.type)) && String(item.call_id).startsWith(`call_${port}_`),
      );
      for (const item of answered) outputs.set(String(item.call_id), JSON.stringify(item.output));
      const step = steps(port)[answered.length];
      const id = `call_${port}_${answered.length}`;
      const item = !step
        ? { type: 'message', role: 'assistant', id: 'msg', content: [{ type: 'output_text', text: 'done' }] }
        : 'patch' in step
          ? { type: 'custom_tool_call', name: 'apply_patch', input: step.patch, call_id: id }
          : 'image' in step
            ? { type: 'function_call', name: 'view_image', arguments: JSON.stringify({ path: step.image }), call_id: id }
            : { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: step.cmd }), call_id: id };
      const usage = {
        input_tokens: 1,
        input_tokens_details: null,
        output_tokens: 1,
        output_tokens_details: null,
        total_tokens: 2,
      };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const event of [
        { type: 'response.created', response: { id: `resp_${id}` } },
        { type: 'response.output_item.done', item },
        { type: 'response.completed', response: { id: `resp_${id}`, usage } },
      ])
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return { port, outputs, paths, close: () => new Promise((resolve) => server.close(resolve)) };
}

const addFile = (file: string) => `*** Begin Patch\n*** Add File: ${file}\n+pwned\n*** End Patch\n`;
const exists = (file: string) =>
  fs.stat(file).then(
    () => true,
    () => false,
  );

/** A disposable Cadence-like root: a project, the folders a turn reads, a folder outside them and a denied state file. */
async function confinedRoot(t: { after(fn: () => unknown): void }) {
  // realpath: on macOS the temp folder is a symlink; the provider resolves the turn's paths, the assertions use real ones.
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cadence-codex-confined-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'projects', 'p1');
  const dirs = {
    brand: path.join(root, 'brands', 'acme'),
    templates: path.join(root, 'templates'),
    runtime: path.join(root, 'runtime'),
  };
  const outside = path.join(root, 'outside');
  const state = path.join(root, '.cadence');
  for (const dir of [path.join(project, 'scenes'), dirs.brand, dirs.templates, dirs.runtime, outside, state])
    await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(outside, 'secret.txt'), 'outside-secret');
  await fs.writeFile(path.join(state, 'accounts.json'), 'TOPSECRET');
  await fs.writeFile(path.join(dirs.brand, 'kit.tsx'), 'brand-kit-source');
  await fs.writeFile(path.join(dirs.brand, 'denied.json'), 'denied-secret');
  return { root, project, dirs, outside, state };
}

/**
 * Runs the real CodexProvider against a fake model scripted with `steps`: a wrapper adds a fake provider without
 * credentials and an empty CODEX_HOME (codexEnv filters the environment and --ignore-user-config skips config.toml).
 * The provider's own confinement probe runs first, through the same wrapper, against the installed binary.
 * Plugins are off: their marketplace clone into CODEX_HOME outlives a fast turn and races the folder's removal.
 * `resume` continues an earlier turn's thread, which lives in that turn's `home`.
 */
async function confinedTurn(
  t: { after(fn: () => unknown): void },
  root: string,
  steps: (port: number) => Step[],
  turn: Pick<AgentTurn, 'cwd' | 'allow' | 'deny' | 'addDirs'>,
  { refused = false, home, resume }: { refused?: boolean; home?: string; resume?: string } = {},
) {
  const model = await fakeModel(steps);
  t.after(model.close);
  home ??= await fs.mkdtemp(path.join(root, 'codex-home-'));
  const wrapper = path.join(root, `codex-${model.port}`);
  const provider = `model_providers.fake={name="fake",base_url="http://127.0.0.1:${model.port}/v1",wire_api="responses"}`;
  await fs.writeFile(
    wrapper,
    `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
// No credentials anywhere: the fake model needs none, and Cadence refuses a turn while Codex reports no login.
if (args[0] === 'login') { console.log('Logged in using an API key'); process.exit(0); }
if (args[0] === 'exec') args.splice(-1, 0, '-c', 'features.plugins=false', '-c', 'model_provider="fake"', '-c', ${JSON.stringify(provider)});
const run = spawnSync(${JSON.stringify(codex)}, args, { stdio: 'inherit', env: { ...process.env, CODEX_HOME: ${JSON.stringify(home)} } });
process.exit(run.status ?? 1);
`,
    { mode: 0o755 },
  );

  const config = { codexPath: wrapper, mcpUrl: `http://127.0.0.1:${model.port}/mcp`, agentLog: null } as CadenceConfig;
  const [first] = await codexModels(config);
  assert.ok(first, 'the installed codex lists a model');
  const events: AgentEvent[] = [];
  for await (const event of new CodexProvider(config).run({
    ...turn,
    prompt: 'Go',
    systemPrompt: '# Guide',
    model: first.id,
    effort: null,
    tools: ['Read', 'Edit', 'Write', 'Glob', 'Grep'],
    mcpServers: { cadence: { type: 'http', url: config.mcpUrl, headers: { Authorization: 'Bearer sk-test-mcp' } } },
    sessionId: resume ?? 'unused',
    resume: resume !== undefined,
    signal: new AbortController().signal,
  }))
    events.push(event);

  const done = events.at(-1);
  assert.ok(done?.type === 'done' && done.isError === refused, JSON.stringify(done));
  assert.equal(model.outputs.size, refused ? 0 : steps(0).length, 'every scripted call was answered');
  return {
    done,
    home,
    sessionId: done?.type === 'done' ? done.sessionId : undefined,
    output: (index: number) => model.outputs.get(`call_${model.port}_${index}`) ?? '',
    paths: model.paths,
  };
}

test(
  'a real Codex turn is confined to the profile its turn gives it',
  { skip: !codex && 'codex is not installed', timeout: 120_000 },
  async (t) => {
    const { root, project, dirs, outside, state } = await confinedRoot(t);
    const steps = (port: number): Step[] => [
      { cmd: `cat ${outside}/secret.txt` },
      { cmd: `echo pwned > ${project}/CLAUDE.md` },
      { patch: addFile(`${project}/CLAUDE.md`) },
      { cmd: `echo pwned > ${outside}/written.txt` },
      { patch: addFile(`${outside}/patched.txt`) },
      { cmd: 'env' },
      { cmd: `curl -sS -m 3 http://127.0.0.1:${port}/from-the-sandbox` },
      { patch: addFile(`${project}/scenes/intro.tsx`) },
      { cmd: `cat ${dirs.brand}/kit.tsx` },
      { cmd: `cat ${dirs.brand}/denied.json` },
      { image: `${outside}/secret.txt` },
      { patch: addFile(`${project}/components/a.tsx`) },
      { patch: addFile(`${project}/art-direction.md`) },
      { cmd: `rm ${project}/art-direction.md && ln -s ${outside}/secret.txt ${project}/art-direction.md && echo swapped` },
    ];

    process.env.OPENAI_API_KEY = 'sk-test-openai';
    process.env.CADENCE_TEST_SECRET_KEY = 'sk-test-parent';
    t.after(() => {
      delete process.env.OPENAI_API_KEY;
      delete process.env.CADENCE_TEST_SECRET_KEY;
    });
    const scope = {
      cwd: project,
      allow: allowRules(project, null, dirs),
      deny: [...denyRules(state), `Read(/${dirs.brand}/denied.json)`],
      addDirs: [dirs.brand, dirs.templates, dirs.runtime],
    };
    const { output, paths } = await confinedTurn(t, root, steps, scope);

    assert.match(output(0), /Operation not permitted/);
    assert.ok(!output(0).includes('outside-secret'), 'a read outside the turn folders fails');
    assert.match(output(1), /not permitted/);
    assert.match(output(2), /rejected/);
    assert.equal(await exists(path.join(project, 'CLAUDE.md')), false, 'CLAUDE.md is not writable');
    assert.match(output(3), /not permitted/);
    assert.match(output(4), /rejected/);
    assert.equal(await exists(path.join(outside, 'written.txt')), false);
    assert.equal(await exists(path.join(outside, 'patched.txt')), false);

    for (const secret of ['sk-test-openai', 'sk-test-parent', 'sk-test-mcp', 'CODEX_HOME', 'CADENCE_MCP_TOKEN'])
      assert.ok(!output(5).includes(secret), `the shell environment has no ${secret}`);
    assert.match(output(5), /CODEX_SANDBOX_NETWORK_DISABLED=1/);

    assert.ok(!paths.includes('/from-the-sandbox'), 'the network is off inside the sandbox');
    assert.match(output(6), /exited with code [1-9]/);

    assert.equal(await fs.readFile(path.join(project, 'scenes', 'intro.tsx'), 'utf8'), 'pwned\n', 'scenes/ stays writable');
    assert.match(output(8), /brand-kit-source/, 'the brand folder stays readable');
    assert.ok(!output(9).includes('denied-secret'), 'a Read deny rule holds inside a readable folder');
    assert.match(output(9), /Operation not permitted/);
    assert.match(output(10), /Operation not permitted/, 'view_image is confined too');

    assert.equal(await fs.readFile(path.join(project, 'components', 'a.tsx'), 'utf8'), 'pwned\n', 'components/ can be created');
    assert.doesNotMatch(output(12), /rejected/);
    // The sandbox lets the agent swap a file it may write for a symlink to one outside: the server must not follow it,
    assert.match(output(13), /swapped/);
    await assert.rejects(readFileNoFollow(project, path.join(project, 'art-direction.md')), { code: 'ELOOP' });
    // and the next turn must not get the link's target as a writable path.
    const next = (): Step[] => [{ cmd: `head ${outside}/secret.txt` }, { cmd: `echo pwned >> ${outside}/secret.txt` }];
    const { done } = await confinedTurn(t, root, next, scope, { refused: true });
    assert.match(done?.type === 'done' ? done.text : '', /lien symbolique/);
    assert.equal(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8'), 'outside-secret');
  },
);

test(
  'a scene turn writes only its scene, through a project folder reached by a symlink',
  { skip: !codex && 'codex is not installed', timeout: 120_000 },
  async (t) => {
    const { root, project, dirs, state } = await confinedRoot(t);
    const linked = path.join(root, 'linked');
    await fs.symlink(path.dirname(project), linked);
    const cwd = path.join(linked, path.basename(project));
    const steps = (): Step[] => [{ patch: addFile('scenes/intro.tsx') }, { patch: addFile('scenes/other.tsx') }];

    const { output } = await confinedTurn(t, root, steps, {
      cwd,
      allow: allowRules(cwd, 'intro', dirs),
      deny: denyRules(state),
      addDirs: [dirs.brand, dirs.templates, dirs.runtime],
    });

    assert.doesNotMatch(output(0), /rejected/);
    assert.equal(await fs.readFile(path.join(project, 'scenes', 'intro.tsx'), 'utf8'), 'pwned\n');
    assert.match(output(1), /rejected/);
    assert.equal(await exists(path.join(project, 'scenes', 'other.tsx')), false, 'a scene turn writes no other scene');
  },
);

test(
  'a brand build writes its brand folder and nothing else, and reads its clone',
  { skip: !codex && 'codex is not installed', timeout: 120_000 },
  async (t) => {
    const { root, dirs, outside, state } = await confinedRoot(t);
    const brand = dirs.brand;
    const repo = path.join(state, 'repos', 'acme');
    await fs.mkdir(repo, { recursive: true });
    await fs.writeFile(path.join(repo, 'README.md'), 'repo-readme');
    const rule = (tool: string, target: string) => `${tool}(/${target})`;
    const steps = (): Step[] => [
      { patch: addFile(`${brand}/logo.svg`) },
      { cmd: `echo built > ${brand}/index.ts` },
      { cmd: `cat ${repo}/README.md` },
      { cmd: `echo pwned > ${repo}/README.md` },
      { patch: addFile(`${outside}/patched.txt`) },
      { cmd: `cat ${state}/accounts.json` },
      { cmd: `cat ${outside}/secret.txt` },
    ];

    const { output } = await confinedTurn(t, root, steps, {
      cwd: brand,
      allow: [
        rule('Read', `${repo}/**`),
        rule('Read', `${brand}/**`),
        rule('Read', `${dirs.runtime}/**`),
        'Glob',
        'Grep',
        rule('Edit', `${brand}/**`),
        rule('Write', `${brand}/**`),
      ],
      deny: denyRules(state),
      addDirs: [repo, brand, dirs.runtime],
    });

    assert.equal(await fs.readFile(path.join(brand, 'logo.svg'), 'utf8'), 'pwned\n', 'the brand folder is writable');
    assert.equal(await fs.readFile(path.join(brand, 'index.ts'), 'utf8'), 'built\n');
    assert.match(output(2), /repo-readme/, 'the clone is readable');
    assert.match(output(3), /not permitted/);
    assert.equal(await fs.readFile(path.join(repo, 'README.md'), 'utf8'), 'repo-readme', 'the clone is not writable');
    assert.match(output(4), /rejected/);
    assert.equal(await exists(path.join(outside, 'patched.txt')), false);
    assert.ok(!output(5).includes('TOPSECRET'), 'the state folder stays unreadable');
    assert.ok(!output(6).includes('outside-secret'));
    assert.match(output(6), /Operation not permitted/);
  },
);

test(
  'a resumed Codex turn is confined like a fresh one',
  { skip: !codex && 'codex is not installed', timeout: 120_000 },
  async (t) => {
    const { root, project, dirs, outside, state } = await confinedRoot(t);
    const scope = {
      cwd: project,
      allow: allowRules(project, null, dirs),
      deny: denyRules(state),
      addDirs: [dirs.brand, dirs.templates, dirs.runtime],
    };
    const first = await confinedTurn(t, root, () => [{ cmd: 'echo first' }], scope);
    assert.match(first.output(0), /first/);
    assert.ok(first.sessionId, 'the first turn reports its thread');

    const steps = (): Step[] => [
      { cmd: `cat ${outside}/secret.txt` },
      { cmd: `echo pwned > ${project}/CLAUDE.md` },
      { patch: addFile(`${project}/CLAUDE.md`) },
    ];
    const { output, sessionId } = await confinedTurn(t, root, steps, scope, { home: first.home, resume: first.sessionId });
    assert.equal(sessionId, first.sessionId, 'the second turn continues the same thread');

    assert.match(output(0), /Operation not permitted/);
    assert.ok(!output(0).includes('outside-secret'), 'a read outside the turn folders fails');
    assert.match(output(1), /not permitted/);
    assert.match(output(2), /rejected/);
    assert.equal(await exists(path.join(project, 'CLAUDE.md')), false, 'CLAUDE.md is not writable');
  },
);
