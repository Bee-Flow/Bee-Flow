import {
    AlertTriangle, ExternalLink, FileText, Loader2, RefreshCw, Sparkles, Workflow,
} from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';
import WebpageAppsPanel from './WebpageAppsPanel';
import { Card, Chip } from './WebpageDataCards';
import useAutomationApi from '../../hooks/useAutomationApi';
import useTranslation from '../../hooks/useTranslation';
import { API_BASE, authFetch } from '../../utils/helpers';

/**
 * "Laat gebeuren" — de kolom naast de datakaarten: wat zet deze pagina in gang?
 *
 * Zolang `bf-*` niet bestaat (W4) heeft die vraag maar twee eerlijke bronnen:
 * de brug-grants (welke routines en apps de pagina mág aanroepen — dat is
 * WebpageAppsPanel, hier gepromoveerd van IDE-zijpaneel naar de onderkant van
 * deze kolom) en de statische scan op wat de pagina BUITEN die grants om doet.
 *
 * ── VIER DINGEN DIE DIT SCHERM NIET MAG BEWEREN ─────────────────────
 *
 * 1. "DEZE PAGINA DOET NIETS." De scan (server: core/webpages/webpageBindings.js)
 *    is een leeshulp, geen beveiliging: hij ziet alleen een letterlijk
 *    uitgeschreven `fetch(` of `XMLHttpRequest` in de eigen bestanden van de
 *    pagina. Daarom kent dit scherm drie standen — niet te lezen, niets
 *    gevonden, en n oproepen die niet te herleiden waren — en staat de
 *    beperking er als vaste regel onder in plaats van in een tooltip.
 *
 * 2. "ER ZIJN GEEN FORMULIEREN." Formulier-elementen bestaan pas met `<bf-form>`
 *    (W4). Tot dan valt er niets te tellen, en dat is iets anders dan nul.
 *
 * 3. "HET AGENT-BLOK WERKT OVERAL." Het is INTERN-ONLY: `ai.ask` is bewust uit
 *    de anonieme bridge gehouden, dus op een publieke share draait het niet.
 *    De kaart zegt dat erbij — en de Openbaar-rij in "Wie ziet de pagina" hoort
 *    dat te herhalen zodra die rij bestaat.
 *
 * 4. "DEZE ROUTINE IS AF." Wat "Maak er een automation van" scaffoldt is een
 *    CONCEPT met één `http_request`-stap: het vaste deel van de URL, de methode
 *    als we die kenden, en `blockPrivateTargets` aan. Bouwde de pagina de rest
 *    van het adres ter plekke, dan zegt de beschrijving van de routine dat.
 */

const BINDINGS_URL = (id) => `${API_BASE}/api/webpages/${encodeURIComponent(id)}/bindings`;

async function readJson(res) {
    try { return await res.json(); } catch { return null; }
}

/** Waar de gescaffolde routine te vinden is. */
export function routineDeepLink(automationId) {
    return `studio/automations/${encodeURIComponent(automationId)}`;
}

/**
 * Het concept dat "Maak er een automation van" aanmaakt.
 *
 * Puur, en apart getest: dit is de enige plek waar een gescande oproep in een
 * opgeslagen definitie verandert. Twee regels staan er hard in — het adres komt
 * uit `urlPrefix` (nooit uit de weergavetekst met het beletselteken erin), en
 * `blockPrivateTargets` blijft aan, zodat een gescaffolde routine niet stilletjes
 * ruimer is dan wat de builder zelf zou maken.
 */
export function scaffoldHttpRoutine(call) {
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

function OwnCodeCard({ t, call, onNavigate }) {
    const api = useAutomationApi();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const [createdId, setCreatedId] = useState(null);

    const make = async () => {
        setBusy(true);
        setError(null);
        try {
            const { automation } = await api.createAutomation(scaffoldHttpRoutine(call));
            setCreatedId(automation.id);
            if (typeof onNavigate === 'function') onNavigate(routineDeepLink(automation.id));
        } catch (e) {
            const message = String(e?.message || e);
            setError(/403|forbidden|licen/i.test(message)
                ? t('webpages.actions.routine_not_licensed',
                    'Routines are not part of this plan, so one cannot be made here.')
                : message);
        } finally {
            setBusy(false);
        }
    };

    return (
        <Card tone="warning">
            <div className="flex items-center gap-2 flex-wrap">
                <AlertTriangle size={14} style={{ color: 'var(--warning)' }} />
                <span className="text-sm font-medium">{call.host}</span>
                <Chip label={t('webpages.actions.own_code', 'Does something in its own code')} tone="muted" dashed />
            </div>

            <p className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                {t('webpages.actions.own_code_body',
                    'This page calls {host} straight from its own code. That call does not show up in Runs and has no approval step.',
                    { host: call.host })}
            </p>

            <div className="text-[11px] font-mono break-all" style={{ color: 'var(--text-secondary)' }}>
                {call.url}
            </div>
            <div className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                {`${call.source}:${call.line} · ${call.kind === 'xhr' ? 'XMLHttpRequest' : 'fetch()'}`}
                {call.method ? ` · ${call.method}` : ''}
                {call.occurrences > 1
                    ? ` · ${t('webpages.actions.occurrences', '{count} times', { count: call.occurrences })}`
                    : ''}
            </div>
            {call.dynamic && (
                <p className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                    {t('webpages.actions.own_code_dynamic',
                        'The page builds the rest of this address while it runs, so only the part shown here is certain.')}
                </p>
            )}

            <div className="flex items-center gap-2 flex-wrap">
                <button
                    type="button"
                    onClick={make}
                    disabled={busy}
                    className="self-start inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md border border-dashed disabled:opacity-50"
                    style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}
                >
                    <Workflow size={13} aria-hidden="true" />
                    {busy
                        ? t('webpages.actions.making_routine', 'Making it…')
                        : t('webpages.actions.make_routine', 'Turn it into a routine')}
                </button>
                {/* Zonder in-app navigator alsnog een echte link: een knop die
                    nergens heen gaat is erger dan een volledige paginalading. */}
                {createdId && typeof onNavigate !== 'function' && (
                    <a
                        className="text-[11px] underline inline-flex items-center gap-1"
                        href={`/app/${routineDeepLink(createdId)}`}
                    >
                        <ExternalLink size={11} /> {t('webpages.actions.open_routine', 'Open the routine')}
                    </a>
                )}
            </div>
            {error && (
                <p role="alert" className="text-[11px]" style={{ color: 'var(--warning)' }}>{error}</p>
            )}
        </Card>
    );
}

// ── de drie standen van de scan ───────────────────────────────────────

function OwnCodeSection({ t, code, onNavigate, onRetry }) {
    if (!code.scanned) {
        return (
            <Card tone="warning">
                <div className="flex items-center gap-2">
                    <AlertTriangle size={14} style={{ color: 'var(--warning)' }} />
                    <span className="text-sm font-medium">
                        {t('webpages.actions.code_unreadable', 'This page\'s own code could not be read')}
                    </span>
                </div>
                <p className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
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
                        <Workflow size={14} style={{ color: 'var(--text-secondary)' }} />
                        <span className="text-sm font-medium">
                            {t('webpages.actions.no_own_calls', 'No calls to other services found in this page\'s code')}
                        </span>
                    </div>
                </Card>
            )}

            {code.externalCount > calls.length && (
                <p className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                    {t(code.externalCount - calls.length === 1
                        ? 'webpages.actions.more_calls' : 'webpages.actions.more_calls_plural',
                    code.externalCount - calls.length === 1
                        ? 'and {count} more address not shown' : 'and {count} more addresses not shown',
                    { count: code.externalCount - calls.length })}
                </p>
            )}

            {code.unresolved > 0 && (
                <p className="text-[11px]" style={{ color: 'var(--warning)' }}>
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

/**
 * De routines die dit paneel LAAT GEBEUREN — uit de elementen op de pagina.
 *
 * Deze kaart zei letterlijk "form blocks are not part of this page's building
 * blocks yet, so none can be listed here", terwijl de server al
 * `forms.supported: true` teruggaf en de Code-tab ernaast een `<bf-form>` met
 * bestand en regel tekende. Twee panelen in dezelfde tab spraken elkaar tegen,
 * en de kaart las de gegevens die het antwoord bevatten niet eens.
 *
 * De drie standen van de rest van dit paneel gelden hier ook: niet gekeken,
 * gekeken en niets gevonden, gekeken en dit gevonden.
 */
function FormsCard({ t, forms, uses, elements, onNavigate }) {
    const scanned = forms?.scanned !== false && elements?.scanned !== false;
    const targets = (uses && uses.targets && Array.isArray(uses.targets.automation))
        ? uses.targets.automation : [];
    // De TAGS komen uit de markeringen, niet uit een lijst hier: de server mag
    // geen tagnaam opschrijven (dat is de drift die W4 uitroeit), dus de client
    // groepeert zelf op wat er in `elements.marks` staat.
    const marks = (elements && Array.isArray(elements.marks)) ? elements.marks : [];
    const byId = new Map(targets.map(x => [x.id, x]));
    return (
        <Card>
            <div className="flex items-center gap-2">
                <FileText size={14} style={{ color: 'var(--kind-kb)' }} />
                <span className="text-sm font-medium">{t('webpages.actions.forms', 'Forms and buttons')}</span>
            </div>
            {!scanned ? (
                <p className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                    {t('webpages.actions.forms_unchecked',
                        'The page\'s own files could not be read, so its forms and buttons could not be listed.')}
                </p>
            ) : !marks.length ? (
                <p className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                    {t('webpages.actions.forms_none',
                        'This page has no blocks that start a routine.')}
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
                                        onClick={() => onNavigate(routineDeepLink(target.id))}
                                    >
                                        {target.id}
                                    </button>
                                ) : (
                                    // Geen knop zonder bestemming: een knop die
                                    // niets doet leest als een kapotte knop.
                                    <span className="font-mono">{target.id}</span>
                                )}
                                <span style={{ color: 'var(--text-secondary)' }}>
                                    {t('webpages.actions.forms_use_count', 'used {count}x on this page',
                                        { count: target.count })}
                                </span>
                            </li>
                        ))}
                    </ul>
                    <p className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                        {t('webpages.actions.forms_inert_when_published',
                            'These blocks only work for signed-in readers. In the published copy of the page they '
                            + 'are shown as switched off.')}
                    </p>
                </>
            )}
        </Card>
    );
}

function AgentCard({ t, agent }) {
    const known = agent?.known !== false;
    return (
        <Card>
            <div className="flex items-center gap-2 flex-wrap">
                <Sparkles size={14} style={{ color: 'var(--type-ai, #8b5cf6)' }} />
                <span className="text-sm font-medium">{t('webpages.actions.agent', 'Agent on this page')}</span>
                <Chip label={t('webpages.actions.agent_internal_only', 'Signed-in readers only')} tone="muted" />
            </div>
            <p className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                {!known
                    ? t('webpages.actions.agent_unknown', 'Whether an agent is linked to this page could not be checked.')
                    : agent.agentId
                        ? t('webpages.actions.agent_linked', 'One agent is linked to this page.')
                        : t('webpages.actions.agent_none', 'No chat block on this page.')}
            </p>
            <p className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                {t('webpages.actions.agent_internal_only_body',
                    'An agent block only answers readers who are signed in. A public share never runs it, so the Public row says so too.')}
            </p>
        </Card>
    );
}

/**
 * @param {object} props
 * @param {string} props.webpageId
 * @param {boolean} [props.readOnly]   niet-eigenaar: /bindings is eigenaar-only
 * @param {function} [props.onNavigate] in-app navigatie voor de deeplinks
 */
export default function WebpageActionsPanel({ webpageId, readOnly = false, onNavigate = null }) {
    const { t } = useTranslation();
    const [state, setState] = useState({ loading: true, error: null, data: null });

    const load = useCallback(async () => {
        setState(s => ({ ...s, loading: true, error: null }));
        try {
            const res = await authFetch(BINDINGS_URL(webpageId));
            const body = await readJson(res);
            if (!res.ok) throw new Error((body && body.error) || `HTTP ${res.status}`);
            setState({ loading: false, error: null, data: body });
        } catch (e) {
            setState({ loading: false, error: e.message || 'failed', data: null });
        }
    }, [webpageId]);

    useEffect(() => { if (webpageId && !readOnly) load(); }, [webpageId, readOnly, load]);

    // Een niet-eigenaar krijgt op /bindings een 404 — hier hetzelfde antwoord
    // als het grants-paneel geeft, in plaats van een lege kolom die leest als
    // "deze pagina doet niets".
    if (readOnly) {
        return (
            <div className="p-4 text-sm" style={{ color: 'var(--text-secondary)' }}>
                {t('webpages.actions.owner_only', 'Only the page owner can see what this page sets off.')}
            </div>
        );
    }

    return (
        <div className="p-3 flex flex-col gap-3">
            <p className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                {t('webpages.actions.subtitle', 'What this page sets off — through Studio, and on its own.')}
            </p>

            {state.loading && (
                <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
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

            {/* De grens van de scan hoort in beeld te staan, niet in een tooltip. */}
            <p className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                {t('webpages.actions.scan_disclaimer',
                    'This check reads the page\'s own files and only sees a fetch() or XMLHttpRequest written out in full. It is a reading aid, not a security check.')}
            </p>

            {/* De grants-lijst, gepromoveerd: wat de pagina via Studio mag aanroepen. */}
            <div className="pt-2 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
                <h3 className="text-[11px] font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--text-secondary)' }}>
                    {t('webpages.actions.through_studio', 'Through Studio')}
                </h3>
                <WebpageAppsPanel webpageId={webpageId} readOnly={readOnly} />
            </div>
        </div>
    );
}
