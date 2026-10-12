import { CheckCircle2, Loader2, Package } from 'lucide-react';
import { useMemo, useState } from 'react';
import Modal from '../shared/Modal';
import { useInstallMcpServer, useProbeMcpServer } from '../../api/queries/mcpLibrary';
import type { CatalogEntry, InstalledServer, McpTool, ProbeInput } from '../../api/queries/mcpLibrary';
import { useTranslation } from '../../hooks/useTranslation';
import AccessPicker from './AccessPicker';
import type { AccessValue } from './AccessPicker';
import { ConnectStep, ReviewSummary } from './InstallSteps';
import type { ConnectDraft } from './InstallSteps';
import { nOf } from '../admin/Studio/KnowledgeStudio/plural';
import { accessSummary, errorText } from './libraryText';
import ToolPicker from './ToolPicker';
import { ALERT_ERROR, EYEBROW, PRIMARY_BTN, SECONDARY_BTN } from './ui';

interface InstallWizardProps {
    /** A library entry, or null for "connect another server" by address. */
    entry: CatalogEntry | null;
    groups: Array<{ id: string; name: string }>;
    onClose: () => void;
    /** After a successful install, to open the new server's details. */
    onOpenInstalled?: (server: InstalledServer) => void;
}

type Step = 1 | 2 | 3 | 4;

function draftFor(entry: CatalogEntry | null): ConnectDraft {
    return {
        name: '',
        url: entry && !entry.selfHosted ? entry.url : '',
        authStyle: entry ? entry.authStyle : 'none',
        header: '',
        credential: '',
        credentialMode: 'shared',
    };
}

/**
 * Add an MCP server in three steps: connect (and prove it answers), choose
 * the tools, choose who may use it. Nothing is stored until the final
 * Install; the connection check stores nothing either.
 */
export default function InstallWizard({ entry, groups, onClose, onOpenInstalled }: InstallWizardProps) {
    const { t } = useTranslation();
    const [step, setStep] = useState<Step>(1);
    const [draft, setDraft] = useState<ConnectDraft>(() => draftFor(entry));
    const [probe, setProbe] = useState<{ key: string; tools: McpTool[] } | null>(null);
    const [selected, setSelected] = useState<string[]>([]);
    const [access, setAccess] = useState<AccessValue>({ mode: 'everyone', groupIds: [] });
    const [installed, setInstalled] = useState<InstalledServer | null>(null);
    const probeMutation = useProbeMcpServer();
    const installMutation = useInstallMcpServer();

    const needsKey = entry ? entry.authStyle !== 'none' : draft.authStyle !== 'none';

    // What the connection check is about. Change any of it and the check
    // has to run again: a result for another address or key proves nothing.
    const request: ProbeInput = useMemo(() => {
        const r: ProbeInput = {};
        if (entry) r.catalogId = entry.id;
        if (!entry || entry.selfHosted) r.url = draft.url.trim();
        if (!entry) r.auth = draft.authStyle === 'header' ? { style: 'header', header: draft.header.trim() } : { style: draft.authStyle };
        if (needsKey && draft.credential.trim()) r.credential = draft.credential.trim();
        return r;
    }, [entry, draft.url, draft.authStyle, draft.header, draft.credential, needsKey]);
    const requestKey = JSON.stringify(request);
    const checked = probe && probe.key === requestKey ? probe.tools : null;

    let host: string | null = entry && !entry.selfHosted ? entry.host : null;
    if (!host && draft.url) { try { host = new URL(draft.url.trim()).hostname; } catch { host = null; } }
    const name = entry ? entry.name : (draft.name.trim() || host || t('mcp_library.wizard.unnamed', 'MCP server'));

    const runCheck = () => {
        probeMutation.reset();
        probeMutation.mutate(request, {
            onSuccess: (res) => {
                setProbe({ key: requestKey, tools: res.tools });
                // A tool the server itself calls destructive starts off; the
                // admin can still switch it on, knowingly.
                setSelected(res.tools.filter(tl => tl.destructive !== true).map(tl => tl.name));
            },
        });
    };

    const install = () => {
        installMutation.mutate({
            ...request,
            ...(entry ? {} : { name: draft.name.trim() || undefined }),
            credentialMode: draft.credentialMode,
            tools: selected,
            access: access.mode === 'groups' ? { mode: 'groups', groupIds: access.groupIds } : { mode: 'everyone' },
        }, { onSuccess: (server) => { setInstalled(server); setStep(4); } });
    };

    const accessReady = access.mode === 'everyone' || access.groupIds.length > 0;
    const canNext = step === 1 ? !!checked && checked.length > 0 : step === 2 ? selected.length > 0 : accessReady;
    const stepTitle = step === 1 ? t('mcp_library.wizard.step_connect', 'Connect')
        : step === 2 ? t('mcp_library.wizard.step_tools', 'Tools')
            : step === 3 ? t('mcp_library.wizard.step_access', 'Access')
                : t('mcp_library.wizard.step_done', 'Done');
    const busy = installMutation.isPending;

    const footer = step === 4 ? (
        <>
            <button type="button" className={SECONDARY_BTN} onClick={onClose}>{t('mcp_library.wizard.close', 'Close')}</button>
            {installed && onOpenInstalled && (
                <button type="button" className={PRIMARY_BTN} onClick={() => onOpenInstalled(installed)}>{t('mcp_library.wizard.open_server', 'Open server')}</button>
            )}
        </>
    ) : (
        <>
            <span className="mr-auto text-[11px] text-[var(--text-tertiary)]">
                {t('mcp_library.wizard.nothing_saved', 'Nothing is saved until you install.')}
            </span>
            {step > 1 && (
                <button type="button" className={SECONDARY_BTN} onClick={() => setStep((step - 1) as Step)} disabled={busy}>
                    {t('mcp_library.wizard.back', 'Back')}
                </button>
            )}
            {step < 3 ? (
                <button type="button" className={PRIMARY_BTN} onClick={() => setStep((step + 1) as Step)} disabled={!canNext}>
                    {t('mcp_library.wizard.next', 'Next')}
                </button>
            ) : (
                <button type="button" className={PRIMARY_BTN} onClick={install} disabled={!canNext || busy}>
                    {busy ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Package size={13} aria-hidden="true" />}
                    {busy ? t('mcp_library.wizard.installing', 'Installing…') : t('mcp_library.wizard.install', 'Install')}
                </button>
            )}
        </>
    );

    return (
        <Modal
            open
            onClose={onClose}
            size="lg"
            className="sm:max-w-[680px]"
            disableBackdropClose={busy}
            disableEscapeClose={busy}
            title={entry ? t('mcp_library.wizard.title_entry', 'Add {name}', { name: entry.name }) : t('mcp_library.wizard.title_custom', 'Connect a server')}
            description={step < 4 ? t('mcp_library.wizard.step_of', 'Step {step} of 3 · {title}', { step, title: stepTitle }) : stepTitle}
            footer={footer}
        >
            {step === 1 && (
                <ConnectStep
                    entry={entry}
                    draft={draft}
                    onDraft={patch => setDraft(d => ({ ...d, ...patch }))}
                    onCheck={runCheck}
                    checking={probeMutation.isPending}
                    checkError={probeMutation.isError ? errorText(t, probeMutation.error) : null}
                    checkedTools={checked}
                />
            )}
            {step === 2 && checked && (
                <div className="flex flex-col gap-3">
                    <p className="m-0 text-[12.5px] leading-snug text-[var(--text-secondary)]">
                        {t('mcp_library.wizard.tools_intro', 'Switch on only what your agents need. You can change this at any time.')}
                    </p>
                    <ToolPicker tools={checked} selected={selected} onChange={setSelected} />
                </div>
            )}
            {step === 3 && (
                <div className="flex flex-col gap-5">
                    <section className="flex flex-col gap-2">
                        <h3 className={EYEBROW}>{t('mcp_library.access.label', 'Who can use it')}</h3>
                        <AccessPicker value={access} onChange={setAccess} groups={groups} disabled={busy} />
                    </section>
                    <section className="flex flex-col gap-2">
                        <h3 className={EYEBROW}>{t('mcp_library.wizard.review', 'Review')}</h3>
                        <ReviewSummary
                            name={name}
                            host={host}
                            official={!!entry && !entry.selfHosted}
                            needsKey={needsKey}
                            credentialMode={draft.credentialMode}
                            selectedTools={selected.length}
                            accessLine={access.mode === 'groups'
                                ? groups.filter(g => access.groupIds.includes(g.id)).map(g => g.name).join(', ')
                                : accessSummary(t, { mode: 'everyone', groupIds: [] })}
                        />
                    </section>
                    {installMutation.isError && (
                        <div role="alert" className={ALERT_ERROR}>{errorText(t, installMutation.error)}</div>
                    )}
                </div>
            )}
            {step === 4 && installed && (
                <div className="flex flex-col items-center text-center gap-2 py-6">
                    <CheckCircle2 size={36} className="text-[var(--success)]" aria-hidden="true" />
                    <p className="m-0 text-[15px] font-semibold text-[var(--text-primary)]">
                        {t('mcp_library.wizard.done_title', '{name} is ready', { name: installed.name })}
                    </p>
                    <p className="m-0 max-w-md text-[12.5px] leading-snug text-[var(--text-secondary)]">
                        {installed.credentialMode === 'personal'
                            ? nOf(t, 'mcp_library.wizard.done_personal', installed.enabledToolCount,
                                '{count} tool is available to the people you chose, as soon as they add their own key under Settings → Connections.',
                                '{count} tools are available to the people you chose, as soon as they add their own key under Settings → Connections.')
                            : nOf(t, 'mcp_library.wizard.done_shared', installed.enabledToolCount,
                                '{count} tool is now available in the chats and agents of the people you chose.',
                                '{count} tools are now available in the chats and agents of the people you chose.')}
                    </p>
                </div>
            )}
        </Modal>
    );
}
