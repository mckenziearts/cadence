// The Profile page (#/@profil): the accounts Cadence uses on this computer. What Cadence asked Claude (the usage log),
// Git hosts through their CLI, networks through the developer app the team created on each one (keys in a dialog),
// connected in a new tab, refreshed on `accounts-changed`.
import { CircleAlert, CircleCheck, Copy, KeyRound, RefreshCw } from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { GitAccount, GitHost, NetworkAccount, UsageSummary, UsageTotals } from '../../shared/types';
import { api } from '../api';
import { useT } from '../i18n';
import { day, tokenCount, usd } from '../lib/format';
import { NONE, useStore } from '../store';
import { copyText, toast } from '../store/ui';
import { GIT_LOGOS, NETWORK_LOGOS } from './logos';
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
  const [git, setGit] = useState<Record<GitHost, GitAccount> | null>(null);
  const [checking, setChecking] = useState(false);
  const check = async () => {
    setChecking(true);
    try {
      setGit(await api.gitAccounts());
    } catch (e) {
      const failed: GitAccount = { available: false, reason: 'error', detail: (e as Error).message };
      setGit({ github: failed, gitlab: failed });
    } finally {
      setChecking(false);
    }
  };
  useEffect(() => void check(), []);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-grid-fade">
      <div className="mx-auto max-w-[92rem] px-6 py-10">
        <h1 className="display-caps text-5xl/none text-ink">{t.profile.title}</h1>
        <p className="mt-2 text-[13px] text-ink-3">{t.profile.subtitle}</p>

        <ClaudeUsage />

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

/** Chats and brand builds as the usage log counted them; read once per visit. */
function ClaudeUsage() {
  const t = useT();
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  useEffect(() => void api.usage().then(setUsage, () => undefined), []);
  const columns = [t.profile.usage.runs, t.profile.usage.read, t.profile.usage.written, t.profile.usage.cost];

  return (
    <section className="mt-10" aria-labelledby="profile-usage">
      <h2 id="profile-usage" className="display-caps text-[22px]/7 text-ink">
        {t.profile.usage.title}
      </h2>
      <p className="mt-1 text-[13px] text-ink-3">{t.profile.usage.hint}</p>
      {usage && (
        <>
          <div className="mt-4 max-w-3xl overflow-x-auto border-2 border-ink bg-white shadow-hard">
            <table className="w-full text-[13px]">
              <thead className="border-b-2 border-ink bg-paper text-[10px] text-ink-3">
                <tr>
                  <th scope="col" className="label-caps px-4 py-2 text-left">
                    {t.profile.usage.source}
                  </th>
                  {columns.map((label) => (
                    <th key={label} scope="col" className="label-caps px-4 py-2 text-right">
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <UsageRow label={t.profile.usage.chats} totals={usage.chats} />
                <UsageRow label={t.profile.usage.brands} totals={usage.brands} />
              </tbody>
              <tfoot className="border-t-2 border-ink">
                <UsageRow label={t.profile.usage.total} totals={sum(usage.chats, usage.brands)} total />
              </tfoot>
            </table>
          </div>
          <p className="mt-3 text-[12px] text-ink-3">
            {usage.since ? t.profile.usage.since(day(usage.since)) : t.profile.usage.empty}
          </p>
        </>
      )}
    </section>
  );
}

function UsageRow({ label, totals, total = false }: { label: string; totals: UsageTotals; total?: boolean }) {
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
      <td className={`${cell} font-semibold text-ink`}>{usd(totals.costUsd)}</td>
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
function Card(props: { logo: ReactNode; title: string; status: ReactNode; children?: ReactNode }) {
  return (
    <li className="flex flex-col justify-center gap-4 border-2 border-ink bg-white p-5 shadow-hard" aria-label={props.title}>
      <div className="flex items-center gap-3">
        <span className="grid size-12 shrink-0 place-items-center border-2 border-ink bg-white text-ink">{props.logo}</span>
        <div className="min-w-0">
          <h3 className="display-caps text-[20px]/6 text-ink">{props.title}</h3>
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

function NetworkCard({ network }: { network: NetworkAccount }) {
  const t = useT();
  const texts = t[network.id];
  const [keys, setKeys] = useState(false);
  const Logo = NETWORK_LOGOS[network.id];
  const { account } = network;
  const configured = network.clientId !== null;

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
          <Button variant="secondary" icon={<KeyRound className="size-4" />} onClick={() => setKeys(true)}>
            {t.profile.setUp}
          </Button>
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
            <Button variant="ghost" icon={<KeyRound className="size-3.5" />} onClick={() => setKeys(true)}>
              {t.profile.keys}
            </Button>
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
