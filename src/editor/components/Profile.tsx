// The Profile page (#/@profil): the accounts Cadence uses on this computer. What Cadence asked the agent (the usage log),
// Git hosts through their CLI, the voice-over engines (Piper's voices, the ElevenLabs key and the voice new projects
// start with), networks through the developer app the team created on each one (keys in a dialog), connected in a new
// tab, refreshed on `accounts-changed`.
import { AlertTriangle, AudioLines, Check, CircleAlert, CircleCheck, Copy, KeyRound, RefreshCw } from 'lucide-react';
import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import {
  DEFAULT_FEATURES,
  type AgentId,
  type AgentStatus,
  type GitAccount,
  type GitHost,
  type NetworkAccount,
  type UsageSummary,
  type UsageTotals,
  type VoicesState,
} from '../../shared/types';
import { ApiError, api, ignore } from '../api';
import { useT } from '../i18n';
import { External } from '../i18n/links';
import { bytes, day, tokenCount, usd } from '../lib/format';
import { NONE, set, useStore } from '../store';
import { setAgent } from '../store/project';
import { copyText, toast } from '../store/ui';
import { AGENTS, type AgentSpec } from './agents';
import { AGENT_LOGOS, ElevenLabsLogo, GIT_LOGOS, NETWORK_LOGOS } from './logos';
import { ElevenLabsVoiceSelect, PIPER_INSTALL } from './voiceOver';
import { Button, ConfirmButton, Field, IconButton, Modal, inputClass, Spinner } from './ui';

const GIT_HOSTS: { id: GitHost; name: string; cli: string }[] = [
  { id: 'github', name: 'GitHub', cli: 'gh' },
  { id: 'gitlab', name: 'GitLab', cli: 'glab' },
];
/** The home's card grid: a few cards side by side, never a wide strip. */
const GRID = 'mt-4 grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-6';

export function Profile() {
  const t = useT();
  const networks = useStore((s) => s.app?.networks ?? NONE);
  const selected = useStore((s) => s.app?.settings.agent ?? 'claude-code');
  const features = useStore((s) => s.app?.features ?? DEFAULT_FEATURES);
  const [git, setGit] = useState<Record<GitHost, GitAccount> | null>(null);
  const [agents, setAgents] = useState<Record<AgentId, AgentStatus> | null>(null);
  const [checking, setChecking] = useState(false);
  const check = async () => {
    setChecking(true);
    const agentError = (e: unknown): AgentStatus => ({ ok: false, label: '', reason: 'error', detail: (e as Error).message });
    await Promise.all([
      api.gitAccounts().then(setGit, (e: Error) => {
        const failed: GitAccount = { available: false, reason: 'error', detail: e.message };
        setGit({ github: failed, gitlab: failed });
      }),
      api
        .agentAccounts()
        .then(setAgents, (e) =>
          setAgents(Object.fromEntries(AGENTS.map((a) => [a.id, agentError(e)])) as Record<AgentId, AgentStatus>),
        ),
    ]);
    setChecking(false);
  };
  useEffect(() => void check(), []);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-grid-fade">
      <div className="mx-auto max-w-[92rem] px-6 py-10">
        <h1 className="display-caps text-5xl/none text-ink">{t.profile.title}</h1>
        <p className="mt-2 text-[13px] text-ink-3">{t.profile.subtitle}</p>

        {features.agentPicker && (
          <>
            <section className="mt-10" aria-labelledby="profile-agents">
              <div className="flex items-center gap-3">
                <h2 id="profile-agents" className="display-caps text-[22px]/7 text-ink">
                  {t.profile.agents.title}
                </h2>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<RefreshCw className="size-3.5" />}
                  loading={checking}
                  onClick={() => void check()}
                >
                  {t.common.check}
                </Button>
              </div>
              <p className="mt-1 text-[13px] text-ink-3">{t.profile.agents.hint}</p>
              <ul className={GRID}>
                {AGENTS.map((agent) => (
                  <AgentCard key={agent.id} agent={agent} status={agents?.[agent.id]} selected={selected === agent.id} />
                ))}
              </ul>
            </section>

            <AgentUsage agent={selected} />
          </>
        )}

        {features.gitSources && (
          <section className="mt-12" aria-labelledby="profile-git">
            <div className="flex items-center gap-3">
              <h2 id="profile-git" className="display-caps text-[22px]/7 text-ink">
                {t.profile.git}
              </h2>
              <Button
                variant="ghost"
                size="sm"
                icon={<RefreshCw className="size-3.5" />}
                loading={checking}
                onClick={() => void check()}
              >
                {t.common.check}
              </Button>
            </div>
            <p className="mt-1 text-[13px] text-ink-3">{t.profile.gitHint}</p>
            <ul className={GRID}>
              {GIT_HOSTS.map((host) => (
                <GitCard key={host.id} host={host} account={git?.[host.id]} />
              ))}
            </ul>
          </section>
        )}

        <VoiceSection />

        <section className="mt-12" aria-labelledby="profile-networks">
          <h2 id="profile-networks" className="display-caps text-[22px]/7 text-ink">
            {t.profile.networks}
          </h2>
          <p className="mt-1 text-[13px] text-ink-3">{t.profile.networksHint}</p>
          <ul className={GRID}>
            {networks.map((network) => (
              <NetworkCard key={network.id} network={network} />
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}

/** The selected agent's chats and brand builds as the usage log counted them; refreshed when the agent changes. */
function AgentUsage({ agent }: { agent: AgentId }) {
  const t = useT();
  const u = t.profile.usage;
  const name = AGENTS.find((a) => a.id === agent)?.name ?? agent;
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const { costs } = useStore((s) => s.app?.features ?? DEFAULT_FEATURES);
  // Codex and the others run on a subscription with no per-turn cost: only Claude Code reports dollars.
  const showCost = costs && agent === 'claude-code';
  useEffect(() => {
    setUsage(null);
    void api.usage(agent).then(setUsage, () => undefined);
  }, [agent]);
  const columns = [u.runs, u.read, u.written, ...(showCost ? [u.cost] : [])];

  return (
    <section className="mt-10" aria-labelledby="profile-usage">
      <h2 id="profile-usage" className="display-caps text-[22px]/7 text-ink">
        {u.title(name)}
      </h2>
      {(showCost || agent !== 'claude-code') && (
        <p className="mt-1 text-[13px] text-ink-3">{showCost ? u.hintCost : u.hintTokens}</p>
      )}
      {usage && (
        <>
          <div className="mt-4 max-w-3xl overflow-x-auto border-2 border-ink bg-white shadow-hard">
            <table className="w-full text-[13px]">
              <thead className="border-b-2 border-ink bg-paper text-[10px] text-ink-3">
                <tr>
                  <th scope="col" className="label-caps px-4 py-2 text-left">
                    {u.source}
                  </th>
                  {columns.map((label) => (
                    <th key={label} scope="col" className="label-caps px-4 py-2 text-right">
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <UsageRow label={u.chats} totals={usage.chats} showCost={showCost} />
                <UsageRow label={u.brands} totals={usage.brands} showCost={showCost} />
              </tbody>
              <tfoot className="border-t-2 border-ink">
                <UsageRow label={u.total} totals={sum(usage.chats, usage.brands)} showCost={showCost} total />
              </tfoot>
            </table>
          </div>
          <p className="mt-3 text-[12px] text-ink-3">{usage.since ? u.since(day(usage.since)) : u.empty}</p>
        </>
      )}
    </section>
  );
}

function UsageRow({
  label,
  totals,
  showCost,
  total = false,
}: {
  label: string;
  totals: UsageTotals;
  showCost: boolean;
  total?: boolean;
}) {
  const { tokens } = totals;
  const cell = 'px-4 py-2.5 text-right';
  return (
    <tr className="border-t border-rule first:border-t-0">
      <th scope="row" className={`px-4 py-2.5 text-left text-ink ${total ? 'font-semibold' : 'font-medium'}`}>
        {label}
      </th>
      <td className={`${cell} text-ink-2`}>{totals.runs}</td>
      <td className={`${cell} text-ink-2`}>{tokenCount(tokens.input + tokens.cacheRead + tokens.cacheWrite)}</td>
      <td className={`${cell} text-ink-2`}>{tokenCount(tokens.output)}</td>
      {showCost && <td className={`${cell} font-semibold text-ink`}>{usd(totals.costUsd)}</td>}
    </tr>
  );
}

function sum(a: UsageTotals, b: UsageTotals): UsageTotals {
  return {
    runs: a.runs + b.runs,
    costUsd: a.costUsd + b.costUsd,
    tokens: {
      input: a.tokens.input + b.tokens.input,
      output: a.tokens.output + b.tokens.output,
      cacheRead: a.tokens.cacheRead + b.tokens.cacheRead,
      cacheWrite: a.tokens.cacheWrite + b.tokens.cacheWrite,
    },
  };
}

/**
 * Logo, name and status on top, what to do at the bottom: the cards of a row line up. A card with nothing to do keeps
 * its name centered when a neighbour makes the row taller.
 */
function Card(props: { logo: ReactNode; title: string; badge?: ReactNode; status: ReactNode; children?: ReactNode }) {
  return (
    <li className="flex flex-col justify-center gap-4 border-2 border-ink bg-white p-5 shadow-hard" aria-label={props.title}>
      <div className="flex items-center gap-3">
        <span className="grid size-12 shrink-0 place-items-center border-2 border-ink bg-white text-ink">{props.logo}</span>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="display-caps text-[20px]/6 text-ink">{props.title}</h3>
            {props.badge}
          </div>
          <div className="mt-0.5 text-[13px]">{props.status}</div>
        </div>
      </div>
      {props.children && <div className="mt-auto space-y-2 text-[13px] text-ink-2">{props.children}</div>}
    </li>
  );
}

function Status({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <p className={ok ? 'flex items-center gap-1.5 text-ok' : 'flex items-center gap-1.5 text-ink-3'}>
      {ok ? <CircleCheck className="size-3.5 shrink-0" aria-hidden /> : <CircleAlert className="size-3.5 shrink-0" aria-hidden />}
      <span className="min-w-0 truncate">{children}</span>
    </p>
  );
}

/** A command to run in a terminal, with its copy button. */
function Command({ text }: { text: string }) {
  const t = useT();
  return (
    <div className="flex items-center gap-2 border-2 border-ink bg-paper pl-3">
      <code className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-ink">{text}</code>
      <IconButton
        label={t.common.copyCommand(text)}
        size="sm"
        icon={<Copy className="size-3.5" />}
        onClick={() => void copyText(text, t.common.commandCopied)}
      />
    </div>
  );
}

function GitCard({ host, account }: { host: (typeof GIT_HOSTS)[number]; account: GitAccount | undefined }) {
  const t = useT();
  const Logo = GIT_LOGOS[host.id];
  const { cli } = host;
  const status = !account ? (
    <span className="flex items-center gap-1.5 text-ink-3">
      <Spinner className="size-3.5" /> {t.profile.checking}
    </span>
  ) : account.available ? (
    <Status ok>{t.profile.via(account.account, cli)}</Status>
  ) : (
    <Status ok={false}>
      {account.reason === 'missing'
        ? t.profile.missing(cli)
        : account.reason === 'logged-out'
          ? t.profile.loggedOut(cli)
          : t.profile.failing(cli)}
    </Status>
  );
  return (
    <Card logo={<Logo className="size-7" />} title={host.name} status={status}>
      {account?.available === false &&
        (account.reason === 'error' ? (
          <p className="text-ink-3">{account.detail}</p>
        ) : (
          <>
            {account.reason === 'missing' && <Command text={`brew install ${cli}`} />}
            <Command text={`${cli} auth login`} />
          </>
        ))}
    </Card>
  );
}

/** Piper and ElevenLabs: what each needs on this computer, and the voice new projects start with. */
function VoiceSection() {
  const t = useT();
  const [voices, setVoices] = useState<VoicesState | null>(null);
  const load = () => void api.voices().then(setVoices, ignore);
  useEffect(load, []);
  return (
    <section className="mt-12" aria-labelledby="profile-voice">
      <h2 id="profile-voice" className="display-caps text-[22px]/7 text-ink">
        {t.profile.voice.title}
      </h2>
      <p className="mt-1 text-[13px] text-ink-3">{t.profile.voice.hint}</p>
      <ul className={GRID}>
        <PiperCard voices={voices} />
        <ElevenLabsCard configured={voices?.elevenLabs.configured} onChange={load} />
      </ul>
    </section>
  );
}

function Checking() {
  const t = useT();
  return (
    <span className="flex items-center gap-1.5 text-ink-3">
      <Spinner className="size-3.5" /> {t.profile.checking}
    </span>
  );
}

function PiperCard({ voices }: { voices: VoicesState | null }) {
  const p = useT().profile.voice.piper;
  const installed = voices?.voices.filter((v) => v.installed) ?? NONE;
  const status = !voices ? <Checking /> : <Status ok={voices.piper.ok}>{voices.piper.ok ? p.ready : p.missing}</Status>;
  // Piper has no mark of its own to show: a neutral glyph.
  return (
    <Card logo={<AudioLines className="size-7" aria-hidden />} title="Piper" status={status}>
      {voices && !voices.piper.ok && (
        <>
          <p>{p.install}</p>
          <Command text={PIPER_INSTALL} />
        </>
      )}
      {voices && (
        <div className="space-y-1">
          <p className="label-caps text-[10px] text-ink-3">{p.voices}</p>
          {installed.length ? (
            <ul className="space-y-0.5">
              {installed.map((v) => (
                <li key={v.id} className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 truncate text-ink">
                    {v.name} <span className="text-ink-3">{v.locale}</span>
                  </span>
                  <span className="shrink-0 text-ink-3">{bytes(v.size)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-ink-3">{p.none}</p>
          )}
        </div>
      )}
    </Card>
  );
}

function ElevenLabsCard({ configured, onChange }: { configured: boolean | undefined; onChange: () => void }) {
  const e = useT().profile.voice.elevenLabs;
  const defaultVoice = useStore((s) => s.app?.settings.defaultVoice ?? null);
  const status = configured === undefined ? <Checking /> : <Status ok={configured}>{configured ? e.configured : e.noKey}</Status>;
  const pick = (next: { voice: string; model: string } | null) =>
    void api
      .saveSettings({ defaultVoice: next && { engine: 'elevenlabs', ...next } })
      .then((settings) => set((s) => ({ app: s.app && { ...s.app, settings } })), ignore);
  const remove = async () => {
    await api.removeElevenLabsKey();
    // The server set new projects back on Piper with the key.
    set((s) => ({ app: s.app && { ...s.app, settings: { ...s.app.settings, defaultVoice: null } } }));
    onChange();
  };
  return (
    <Card logo={<ElevenLabsLogo className="size-7" />} title="ElevenLabs" status={status}>
      {configured === false && <ElevenLabsKeyForm onSaved={onChange} />}
      {configured && (
        <>
          <p className="label-caps text-[10px] text-ink-3">{e.newProjects}</p>
          <ElevenLabsVoiceSelect value={defaultVoice} onChange={pick} label={e.defaultLabel} none={e.piper} noneSelectable />
          <p className="text-xs text-ink-3">{e.defaultHint}</p>
          <ConfirmButton variant="secondary" label={e.removeKey} confirmLabel={e.removeKeyConfirm} onConfirm={remove} />
        </>
      )}
    </Card>
  );
}

/** Sent once to the server, which keeps it in its state directory: the field empties and the key is never shown back. */
function ElevenLabsKeyForm({ onSaved }: { onSaved: () => void }) {
  const e = useT().profile.voice.elevenLabs;
  const id = useId();
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api.saveElevenLabsKey(key.trim());
      setKey('');
      onSaved();
    } catch (failure) {
      setError((failure as ApiError).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-2">
      <Field label={e.key} htmlFor={`${id}-key`} hint={e.keyHint}>
        <input
          id={`${id}-key`}
          type="password"
          value={key}
          onChange={(event) => setKey(event.target.value)}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          className={inputClass}
        />
      </Field>
      {error && (
        <p id={`${id}-error`} className="flex items-start gap-1.5 text-xs text-alert">
          <AlertTriangle className="mt-px size-3 shrink-0" aria-hidden /> {error}
        </p>
      )}
      <p className="text-xs text-ink-2">{e.billing}</p>
      <Button type="submit" size="sm" variant="secondary" loading={saving} disabled={!key.trim()}>
        {e.saveKey}
      </Button>
    </form>
  );
}

function AgentCard({ agent, status, selected }: { agent: AgentSpec; status: AgentStatus | undefined; selected: boolean }) {
  const t = useT();
  const [help, setHelp] = useState(false);
  const { cli, name } = agent;
  const Logo = AGENT_LOGOS[agent.id];
  const a = t.profile.agents;

  const statusEl = !status ? (
    <span className="flex items-center gap-1.5 text-ink-3">
      <Spinner className="size-3.5" /> {t.profile.checking}
    </span>
  ) : status.ok ? (
    <Status ok>{status.version ? `${a.ready} · ${status.version}` : a.ready}</Status>
  ) : (
    <Status ok={false}>
      {status.reason === 'missing'
        ? t.profile.missing(cli)
        : status.reason === 'logged-out'
          ? t.profile.loggedOut(cli)
          : (status.detail ?? t.profile.failing(cli))}
    </Status>
  );

  const badge = agent.soon ? (
    <span className="label-caps border-2 border-ink bg-now px-1.5 py-0.5 text-[10px] text-ink">{a.soon}</span>
  ) : undefined;

  return (
    <Card logo={<Logo className="size-7" />} title={name} badge={badge} status={statusEl}>
      <div className="flex items-center gap-2">
        {agent.soon ? null : selected ? (
          <Button variant="primary" disabled icon={<Check className="size-4" />}>
            {a.inUse}
          </Button>
        ) : (
          // Only a connected agent can be chosen: picking one Cadence cannot reach would break every turn.
          <Button variant="secondary" disabled={!status?.ok} onClick={() => void setAgent(agent.id)}>
            {a.use}
          </Button>
        )}
        {(agent.soon || (status && !status.ok && status.reason !== 'error')) && (
          <Button variant="ghost" onClick={() => setHelp(true)}>
            {a.setup}
          </Button>
        )}
      </div>
      {help && <AgentHelp agent={agent} reason={status?.reason} onClose={() => setHelp(false)} />}
    </Card>
  );
}

function AgentHelp({ agent, reason, onClose }: { agent: AgentSpec; reason: AgentStatus['reason']; onClose: () => void }) {
  const t = useT();
  const h = t.profile.agents.help;
  return (
    <Modal
      title={h.title(agent.name)}
      onClose={onClose}
      width="max-w-lg"
      footer={
        <>
          <span className="mr-auto" />
          <Button variant="ghost" onClick={onClose}>
            {t.common.close}
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-[13px] text-ink-2">
        {reason === 'logged-out' ? (
          <>
            <p>{h.loginIntro(agent.name)}</p>
            <Command text={agent.loginCmd} />
          </>
        ) : (
          <>
            <p>{h.installIntro(agent.name)}</p>
            <div className="space-y-1">
              <p className="label-caps text-[10px] text-ink-3">{h.install}</p>
              <Command text={agent.installCmd} />
            </div>
            <div className="space-y-1">
              <p className="label-caps text-[10px] text-ink-3">{h.login}</p>
              <Command text={agent.loginCmd} />
            </div>
          </>
        )}
        <p>
          <External href={agent.docs}>{h.docs}</External>
        </p>
      </div>
    </Modal>
  );
}

function NetworkCard({ network }: { network: NetworkAccount }) {
  const t = useT();
  const texts = t[network.id];
  const [keys, setKeys] = useState(false);
  const Logo = NETWORK_LOGOS[network.id];
  const { account } = network;
  const configured = network.clientId !== null;
  const { networkApps } = useStore((s) => s.app?.features ?? DEFAULT_FEATURES);

  const connect = async () => {
    // Opened in the click itself: a tab opened after a request may count as a popup and be blocked.
    const tab = window.open('', '_blank');
    if (tab) tab.opener = null;
    try {
      const { url } = await api.connectNetwork(network.id);
      if (tab) tab.location.href = url;
      else location.assign(url);
    } catch {
      tab?.close();
    }
  };

  const status = account ? (
    <Status ok>
      <a href={account.url} target="_blank" rel="noreferrer" className="focus-ring underline-offset-2 hover:underline">
        {account.name}
      </a>
    </Status>
  ) : (
    <Status ok={false}>{configured ? texts.notConnected : t.profile.notConfigured}</Status>
  );

  return (
    <Card logo={<Logo className="size-8" />} title={network.label} status={status}>
      <div className="flex items-center gap-2">
        {!configured ? (
          networkApps && (
            <Button variant="secondary" icon={<KeyRound className="size-4" />} onClick={() => setKeys(true)}>
              {t.profile.setUp}
            </Button>
          )
        ) : (
          <>
            {account ? (
              <ConfirmButton
                variant="secondary"
                size="md"
                label={t.profile.disconnect}
                confirmLabel={t.profile.disconnectConfirm}
                onConfirm={async () => {
                  await api.disconnectNetwork(network.id);
                  toast(t.profile.disconnected(network.label), 'info');
                }}
              />
            ) : (
              <Button variant="primary" onClick={() => void connect()}>
                {texts.connect}
              </Button>
            )}
            {networkApps && (
              <Button variant="ghost" icon={<KeyRound className="size-3.5" />} onClick={() => setKeys(true)}>
                {t.profile.keys}
              </Button>
            )}
          </>
        )}
      </div>
      {keys && <AppKeys network={network} onClose={() => setKeys(false)} />}
    </Card>
  );
}

function AppKeys({ network, onClose }: { network: NetworkAccount; onClose: () => void }) {
  const t = useT();
  const texts = t[network.id];
  const [clientId, setClientId] = useState(network.clientId ?? '');
  const [clientSecret, setClientSecret] = useState('');
  const [saving, setSaving] = useState(false);
  const ready = Boolean(clientId.trim() && clientSecret.trim());
  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!ready) return;
    setSaving(true);
    try {
      await api.saveNetworkApp(network.id, { clientId: clientId.trim(), clientSecret: clientSecret.trim() });
      toast(t.profile.keysSaved(network.label), 'success');
      onClose();
    } catch {
      setSaving(false);
    }
  };
  return (
    <Modal
      title={t.profile.keysTitle(network.label)}
      subtitle={texts.keysSubtitle}
      onClose={onClose}
      width="max-w-xl"
      footer={
        <>
          <span className="mr-auto" />
          <Button variant="ghost" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button variant="primary" loading={saving} disabled={!ready} onClick={() => void save()}>
            {t.common.save}
          </Button>
        </>
      }
    >
      <form className="space-y-4 text-[13px] text-ink-2" onSubmit={(e) => void save(e)}>
        <ol className="list-decimal space-y-1 pl-5 text-pretty">
          {texts.steps.map((step, i) => (
            <li key={i}>{step}</li>
          ))}
        </ol>
        <Field label={texts.clientId} htmlFor={`${network.id}-client-id`}>
          <input
            id={`${network.id}-client-id`}
            className={inputClass}
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
        <Field label={texts.clientSecret} htmlFor={`${network.id}-client-secret`}>
          <input
            id={`${network.id}-client-secret`}
            type="password"
            className={inputClass}
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            autoComplete="off"
            placeholder={network.clientId ? t.profile.secretAgain : undefined}
          />
        </Field>
        <p className="text-xs text-ink-3">{texts.note}</p>
        <Field label={t.profile.redirect} hint={texts.redirectHint}>
          <Command text={network.redirectUri} />
        </Field>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
