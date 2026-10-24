import {
    AlertTriangle, ExternalLink, FileText, Loader2, RefreshCw, Sparkles, Workflow,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import WebpageAppsPanel from './WebpageAppsPanel';
import { Card, Chip } from './WebpageDataCards';
import useAutomationApi from '../../hooks/useAutomationApi';
import useTranslation from '../../hooks/useTranslation';
import { API_BASE, authFetch } from '../../utils/helpers';
import type { TranslateParams } from '../../hooks/useTranslation';
import type { ScannedCall, CodeScan, BindingsPayload, NavigateFn, OwnCodeCardProps, OwnCodeSectionProps, FormsCardProps, AgentCardProps, WebpageActionsPanelProps } from './WebpageActionsPanel.types';

/**
 * "Lets things happen" — the column beside the data cards: what sets this page in motion?
 *
 * As long as `bf-*` does not exist (W4), that question has only two honest sources: the bridge grants (which automations and apps the page may call — that is WebpageAppsPanel, here promoted from the IDE side panel to the bottom of this column) and the static scan of what the page does OUTSIDE those grants.
 *
 * ── FOUR THINGS THIS SCREEN MAY NOT CLAIM ───────────────────────────
 *
 * 1. "THIS PAGE DOES NOTHING." The scan (server: core/webpages/webpageBindings.js) is a reading aid, not security: it only sees a literally written-out `fetch(` or `XMLHttpRequest` in the page's own files. That is why this screen has three states — unreadable, nothing found, and n calls that could not be traced back — and why the limitation stands as a fixed rule beneath it rather than in a tooltip.
 *
 * 2. "THERE ARE NO FORMS." Form elements only exist with `<bf-form>` (W4). Until then there is nothing to count, and that is something other than zero.
 *
 * 3. "THE AGENT BLOCK WORKS EVERYWHERE." It is INTERNAL-ONLY: `ai.ask` is deliberately kept out of the anonymous bridge, so on a public share it does not run. The card says so — and the Public row in "Who sees the page" should repeat that as soon as that row exists.
 *
 * 4. "THIS AUTOMATION IS FINISHED." What "Make an automation from this" scaffolds is a DRAFT with one `http_request` step: the fixed part of the URL, the method if we knew it, and `blockPrivateTargets` on. If the page built the rest of the address on the spot, the automation's description says so.
 */

const BINDINGS_URL = (id: string | number | boolean) => `${API_BASE}/api/webpages/${encodeURIComponent(id)}/bindings`;

async function readJson(res: Response) {
    try { return await res.json(); } catch { return null; }
}

/** Waar de gescaffolde automatisering te vinden is. */
export function automationDeepLink(automationId: string | number | boolean) {
    return `studio/automations/${encodeURIComponent(automationId)}`;
}

/**
 * The draft that "Make an automation from this" creates.
 *
 * Pure, and tested separately: this is the only place where a scanned call changes into a saved definition. Two rules are hard-coded here — the address comes from `urlPrefix` (never from the display text with the ellipsis in it), and `blockPrivateTargets` stays on, so that a scaffolded automation is not quietly broader than what the builder itself would make.
 */
export function scaffoldHttpAutomation(call: ScannedCall) {
    const host = call.host || 'a web service';
    const url = call.urlPrefix || call.url || '';
    const label = `Call ${host}`;
    return {
        title: label,
        description: call.dynamic
            ? 'Made from a web page that called this address from its own code. The page built the rest of the address while it ran, so finish the URL here.'
            : 'Made from a web page that called this address from its own code.',
        triggerType: 'manual',
        definition: {
            schemaVersion: 1,
            trigger: { id: 'trg', type: 'trigger', kind: 'manual', output: {} },
            steps: [{
                id: 'http_1',
                type: 'http_request',
                url,
                method: call.method || 'GET',
                headers: {},
                body: '',
                timeoutMs: 10000,
                blockPrivateTargets: true,
                label,
            }],
            edges: [{ from: 'trg', to: 'http_1' }],
            vars: {},
        },
    };
}

// ── de kaart per gevonden oproep ──────────────────────────────────────

function OwnCodeCard({ t, call, onNavigate }: OwnCodeCardProps) {
    const api = useAutomationApi();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [createdId, setCreatedId] = useState<string | number | boolean | null>(null);

    const make = async () => {
        setBusy(true);
        setError(null);
        try {
            const { automation } = await api.createAutomation<{ automation: { id: string | number } }>(scaffoldHttpAutomation(call));
            setCreatedId(automation.id);
            if (typeof onNavigate === 'function') onNavigate(automationDeepLink(automation.id));
        } catch (e) {
            const message = String((e as Error)?.message || e);
            setError(/403|forbidden|licen/i.test(message)
                ? t('webpages.actions.automation_not_licensed',
                    'Automations are not part of this plan, so one cannot be made here.')
                : message);
        } finally {
            setBusy(false);
        }
    };

    return (
        <Card tone="warning">
            <div className="flex items-center gap-2 flex-wrap">
                <AlertTriangle size={14} className="[color:var(--warning)]" />
                <span className="text-sm font-medium">{call.host}</span>
                <Chip label={t('webpages.actions.own_code', 'Does something in its own code')} tone="muted" dashed />
            </div>

            <p className="text-[11px] text-[var(--text-secondary)]">
                {t('webpages.actions.own_code_body',
                    'This page calls {host} straight from its own code. That call does not show up in Runs and has no approval step.',
                    { host: call.host })}
            </p>

            <div className="text-[11px] font-mono break-all text-[var(--text-secondary)]">
                {call.url}
            </div>
            <div className="text-[11px] text-[var(--text-secondary)]">
                {`${call.source}:${call.line} · ${call.kind === 'xhr' ? 'XMLHttpRequest' : 'fetch()'}`}
                {call.method ? ` · ${call.method}` : ''}
                {call.occurrences > 1
                    ? ` · ${t('webpages.actions.occurrences', '{count} times', { count: call.occurrences })}`
                    : ''}
            </div>
            {call.dynamic && (
                <p className="text-[11px] text-[var(--text-secondary)]">
                    {t('webpages.actions.own_code_dynamic',
                        'The page builds the rest of this address while it runs, so only the part shown here is certain.')}
                </p>
            )}

            <div className="flex items-center gap-2 flex-wrap">
                <button
                    type="button"
                    onClick={make}
                    disabled={busy}
                    className="self-start inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md border border-dashed disabled:opacity-50 border-[var(--border-subtle)] text-[var(--text-primary)]"
                >
                    <Workflow size={13} aria-hidden="true" />
                    {busy
                        ? t('webpages.actions.making_automation', 'Making it…')
                        : t('webpages.actions.make_automation', 'Turn it into an automation')}
                </button>
                {/* Without an in-app navigator, still a real link: a button that goes nowhere is
                    worse than a full page load. */}
                {createdId && typeof onNavigate !== 'function' && (
                    <a
                        className="text-[11px] underline inline-flex items-center gap-1"
                        href={`/app/${automationDeepLink(createdId)}`}
                    >
                        <ExternalLink size={11} /> {t('webpages.actions.open_automation', 'Open the automation')}
                    </a>
                )}
            </div>
            {error && (
                <p role="alert" className="text-[11px] text-[var(--warning)]">{error}</p>
            )}
        </Card>
    );
}

// ── de drie standen van de scan ───────────────────────────────────────

function OwnCodeSection({ t, code, onNavigate, onRetry }: OwnCodeSectionProps) {
    if (!code.scanned) {
        return (
            <Card tone="warning">
                <div className="flex items-center gap-2">
                    <AlertTriangle size={14} className="[color:var(--warning)]" />
                    <span className="text-sm font-medium">
                        {t('webpages.actions.code_unreadable', 'This page\'s own code could not be read')}
                    </span>
                </div>
                <p className="text-[11px] text-[var(--text-secondary)]">
                    {t('webpages.actions.code_unreadable_body',
                        'So what this page does on its own is unknown right now — which is not the same as nothing.')}
                </p>
                <button type="button" className="self-start text-xs underline inline-flex items-center gap-1" onClick={onRetry}>
                    <RefreshCw size={12} /> {t('webpages.retry', 'Try again')}
                </button>
            </Card>
        );
    }

    const calls = code.calls || [];
    return (
        <>
            {calls.map(call => (
                <OwnCodeCard key={`${call.kind}:${call.url}:${call.line}`} t={t} call={call} onNavigate={onNavigate} />
            ))}

            {calls.length === 0 && code.unresolved === 0 && (
                <Card>
                    <div className="flex items-center gap-2">
                        <Workflow size={14} className="text-[var(--text-secondary)]" />
                        <span className="text-sm font-medium">
                            {t('webpages.actions.no_own_calls', 'No calls to other services found in this page\'s code')}
                        </span>
                    </div>
                </Card>
            )}

            {code.externalCount > calls.length && (
                <p className="text-[11px] text-[var(--text-secondary)]">
                    {t(code.externalCount - calls.length === 1
                        ? 'webpages.actions.more_calls' : 'webpages.actions.more_calls_plural',
                    code.externalCount - calls.length === 1
                        ? 'and {count} more address not shown' : 'and {count} more addresses not shown',
                    { count: code.externalCount - calls.length })}
                </p>
            )}

            {code.unresolved > 0 && (
                <p className="text-[11px] text-[var(--warning)]">
                    {t(code.unresolved === 1 ? 'webpages.actions.unresolved' : 'webpages.actions.unresolved_plural',
                        code.unresolved === 1
                            ? '{count} call in this page\'s code could not be checked: its address is built while the page runs, or it sits in text this scan cannot read.'
                            : '{count} calls in this page\'s code could not be checked: their address is built while the page runs, or they sit in text this scan cannot read.',
                        { count: code.unresolved })}
                </p>
            )}
        </>
    );
}

function FormsCard({ t, forms, uses, elements, onNavigate }: FormsCardProps) {
    const scanned = forms?.scanned !== false && elements?.scanned !== false;
    const targets = (uses && uses.targets && Array.isArray(uses.targets.automation))
        ? uses.targets.automation : [];
    // The TAGS come from the markers, not from a list here: the server may not write
    // down a tag name (that is the drift that W4 eradicates), so the client groups
    // by itself on what is in `elements.marks`.
    const marks = (elements && Array.isArray(elements.marks)) ? elements.marks : [];
    const byId = new Map(targets.map(x => [x.id, x]));
    return (
        <Card>
            <div className="flex items-center gap-2">
                <FileText size={14} className="[color:var(--kind-kb)]" />
                <span className="text-sm font-medium">{t('webpages.actions.forms', 'Forms and buttons')}</span>
            </div>
            {!scanned ? (
                <p className="text-[11px] text-[var(--text-secondary)]">
                    {t('webpages.actions.forms_unchecked',
                        'The page\'s own files could not be read, so its forms and buttons could not be listed.')}
                </p>
            ) : !marks.length ? (
                <p className="text-[11px] text-[var(--text-secondary)]">
                    {t('webpages.actions.forms_none',
                        'This page has no blocks that start an automation.')}
                </p>
            ) : (
                <>
                    <ul className="flex flex-col gap-1">
                        {[...byId.values()].map(target => (
                            <li key={target.id} className="text-[11px] flex items-center gap-1.5 flex-wrap">
                                {typeof onNavigate === 'function' ? (
                                    <button
                                        type="button"
                                        className="underline"
                                        onClick={() => onNavigate(automationDeepLink(target.id))}
                                    >
                                        {target.id}
                                    </button>
                                ) : (
                                    // No button without a destination: a button that does nothing
                                    // reads like a broken button.
                                    <span className="font-mono">{target.id}</span>
                                )}
                                <span className="text-[var(--text-secondary)]">
                                    {t('webpages.actions.forms_use_count', 'used {count}x on this page',
                                        { count: target.count })}
                                </span>
                            </li>
                        ))}
                    </ul>
                    <p className="text-[11px] text-[var(--text-secondary)]">
                        {t('webpages.actions.forms_inert_when_published',
                            'These blocks only work for signed-in readers. In the published copy of the page they '
                            + 'are shown as switched off.')}
                    </p>
                </>
            )}
        </Card>
    );
}

function AgentCard({ t, agent }: AgentCardProps) {
    const known = agent?.known !== false;
    return (
        <Card>
            <div className="flex items-center gap-2 flex-wrap">
                <Sparkles size={14} className="[color:var(--type-ai,#8b5cf6)]" />
                <span className="text-sm font-medium">{t('webpages.actions.agent', 'Agent on this page')}</span>
                <Chip label={t('webpages.actions.agent_internal_only', 'Signed-in readers only')} tone="muted" />
            </div>
            <p className="text-[11px] text-[var(--text-secondary)]">
                {!known
                    ? t('webpages.actions.agent_unknown', 'Whether an agent is linked to this page could not be checked.')
                    : agent.agentId
                        ? t('webpages.actions.agent_linked', 'One agent is linked to this page.')
                        : t('webpages.actions.agent_none', 'No chat block on this page.')}
            </p>
            <p className="text-[11px] text-[var(--text-secondary)]">
                {t('webpages.actions.agent_internal_only_body',
                    'An agent block only answers readers who are signed in. A public share never runs it, so the Public row says so too.')}
            </p>
        </Card>
    );
}

export default function WebpageActionsPanel({ webpageId, readOnly = false, onNavigate = null }: WebpageActionsPanelProps) {
    const { t } = useTranslation();
    const [state, setState] = useState<{ loading: boolean; error: string | null; data: BindingsPayload | null }>({ loading: true, error: null, data: null });

    const load = useCallback(async () => {
        setState(s => ({ ...s, loading: true, error: null }));
        try {
            const res = await authFetch(BINDINGS_URL(webpageId));
            const body = await readJson(res);
            if (!res.ok) throw new Error((body && body.error) || `HTTP ${res.status}`);
            setState({ loading: false, error: null, data: body });
        } catch (e) {
            setState({ loading: false, error: (e as Error).message || 'failed', data: null });
        }
    }, [webpageId]);

    useEffect(() => { if (webpageId && !readOnly) load(); }, [webpageId, readOnly, load]);

    // A non-owner gets a 404 on /bindings — here the same answer as the grants
    // panel gives, instead of an empty column that reads as "this page does
    // nothing".
    if (readOnly) {
        return (
            <div className="p-4 text-sm text-[var(--text-secondary)]">
                {t('webpages.actions.owner_only', 'Only the page owner can see what this page sets off.')}
            </div>
        );
    }

    return (
        <div className="p-3 flex flex-col gap-3">
            <p className="text-[11px] text-[var(--text-secondary)]">
                {t('webpages.actions.subtitle', 'What this page sets off — through Studio, and on its own.')}
            </p>

            {state.loading && (
                <div className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
                    <Loader2 size={14} className="animate-spin" />
                    {t('webpages.actions.loading', 'Reading what this page does…')}
                </div>
            )}

            {!state.loading && state.error && (
                <Card tone="warning">
                    <p className="text-sm">
                        {t('webpages.actions.load_failed', 'Could not load what this page does.')}
                    </p>
                    <button type="button" className="self-start text-xs underline inline-flex items-center gap-1" onClick={load}>
                        <RefreshCw size={12} /> {t('webpages.retry', 'Try again')}
                    </button>
                </Card>
            )}

            {!state.loading && !state.error && state.data && (
                <>
                    <OwnCodeSection t={t} code={state.data.code || {}} onNavigate={onNavigate} onRetry={load} />
                    <FormsCard
                        t={t}
                        forms={state.data.forms}
                        uses={state.data.uses}
                        elements={state.data.elements}
                        onNavigate={onNavigate}
                    />
                    <AgentCard t={t} agent={state.data.agent} />
                </>
            )}

            {/* The boundary of the scan belongs on screen, not in a tooltip. */}
            <p className="text-[11px] text-[var(--text-secondary)]">
                {t('webpages.actions.scan_disclaimer',
                    'This check reads the page\'s own files and only sees a fetch() or XMLHttpRequest written out in full. It is a reading aid, not a security check.')}
            </p>

            {/* De grants-lijst, gepromoveerd: wat de pagina via Studio mag aanroepen. */}
            <div className="pt-2 border-t border-[var(--border-subtle)]">
                <h3 className="text-[11px] font-semibold uppercase tracking-wider mb-1 text-[var(--text-secondary)]">
                    {t('webpages.actions.through_studio', 'Through Studio')}
                </h3>
                <WebpageAppsPanel webpageId={webpageId} readOnly={readOnly} />
            </div>
        </div>
    );
}
