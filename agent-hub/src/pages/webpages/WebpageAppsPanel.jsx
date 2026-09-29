import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
    AppWindow, AlertTriangle, CheckCircle2, HelpCircle, Loader2, Lock,
    Plug, Plus, RefreshCw, Trash2, Workflow, X,
} from 'lucide-react';
import useAutomationApi from '../../hooks/useAutomationApi';
import useTranslation from '../../hooks/useTranslation';
import { API_BASE, authFetch } from '../../utils/helpers';

/**
 * WebpageAppsPanel — the "Apps & data" sidebar pane of the webpage IDE.
 *
 * Makes the bridge grants (server: integrations/webpageGrants.js, routes:
 * routes/webpagesGrants.js) visible and manageable WITHOUT going through the
 * AI chat — previously the only way to grant/revoke. Two jobs:
 *
 *   1. Show which integrations + routines this page may call (with a live
 *      status: connected / needs reconnect / unknown), and revoke them.
 *   2. Add new ones from the apps the author ALREADY has access to — the same
 *      strict catalog the automations builder uses (GET /api/automation/
 *      catalog). Apps the author hasn't connected are greyed out with a
 *      Connect deep link to Settings → Integrations (with a ?return= back
 *      here); the server also refuses such grants with 409
 *      connection_required, so a stale catalog can't produce a broken grant.
 *
 * Owner-only surface (the bridge runs acts-as-author): non-owners get a note,
 * matching the owner gate in WebpageIDE.
 */

const GRANTS_BASE = (id) => `${API_BASE}/api/webpages/${encodeURIComponent(id)}/grants`;

// How long a catalog/grants snapshot may be shown stale; a window-focus or a
// manual refresh re-fetches (the author may have just connected an app).
const FOCUS_REFETCH_MS = 5_000;

async function readJson(res) {
    try { return await res.json(); } catch { return null; }
}

function StatusPill({ available }) {
    const { t } = useTranslation();
    if (available === true) {
        return (
            <span className="inline-flex items-center gap-1 text-[10px]" style={{ color: '#10b981' }}>
                <CheckCircle2 size={11} /> {t('webpages.apps.status_connected', 'Connected')}
            </span>
        );
    }
    if (available === false) {
        return (
            <span className="inline-flex items-center gap-1 text-[10px]" style={{ color: '#d97706' }}>
                <AlertTriangle size={11} /> {t('webpages.apps.status_reconnect', 'Needs reconnect')}
            </span>
        );
    }
    return (
        <span className="inline-flex items-center gap-1 text-[10px]" style={{ color: 'var(--vsc-fg-muted)' }}>
            <HelpCircle size={11} /> {t('webpages.apps.status_unknown', 'Status unknown')}
        </span>
    );
}

/** Settings → Integrations deep link that lands the author back on this page. */
function connectHref(webpageId) {
    return `/app/settings/integrations?return=${encodeURIComponent(`/app/studio/webpages/${webpageId}`)}`;
}

function ConnectLink({ webpageId, children }) {
    const { t } = useTranslation();
    return (
        <a
            href={connectHref(webpageId)}
            className="underline underline-offset-2"
            style={{ color: 'var(--vsc-accent)' }}
        >
            {children || t('webpages.apps.connect_first', 'Connect it first')}
        </a>
    );
}

// ─── Add-an-app form ────────────────────────────────────────────────

function AddAppForm({ webpageId, catalog, onGranted, onError }) {
    const { t } = useTranslation();
    const [appId, setAppId] = useState('');
    const [tool, setTool] = useState('');
    const [label, setLabel] = useState('');
    const [fixedArgsText, setFixedArgsText] = useState('');
    const [fixedArgsError, setFixedArgsError] = useState(null);
    const [submitting, setSubmitting] = useState(false);
    const [needConnect, setNeedConnect] = useState(null); // provider id after a 409

    // Apps with at least one action; connectable ones first, then A–Z.
    const apps = useMemo(() => {
        const list = (catalog?.apps || []).filter(a => (a.actions || []).length > 0);
        return [...list].sort((a, b) => Number(b.available === true) - Number(a.available === true)
            || String(a.label || a.id).localeCompare(String(b.label || b.id)));
    }, [catalog]);

    const app = apps.find(a => a.id === appId) || null;
    const actions = app?.actions || [];

    const submit = async () => {
        setFixedArgsError(null);
        setNeedConnect(null);
        let fixedArgs;
        const raw = fixedArgsText.trim();
        if (raw) {
            try {
                const parsed = JSON.parse(raw);
                if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
                    setFixedArgsError(t('webpages.apps.err_json_object', 'Must be a JSON object, e.g. { "channel": "#general" }'));
                    return;
                }
                fixedArgs = parsed;
            } catch {
                setFixedArgsError(t('webpages.apps.err_json_invalid', 'Invalid JSON'));
                return;
            }
        }
        setSubmitting(true);
        try {
            const res = await authFetch(GRANTS_BASE(webpageId) + '/integrations', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tool, ...(fixedArgs ? { fixedArgs } : {}), ...(label.trim() ? { label: label.trim() } : {}) }),
            });
            const body = await readJson(res);
            if (!res.ok) {
                if (body?.code === 'connection_required') setNeedConnect(body.provider || app?.id || null);
                onError(body?.error || t('webpages.apps.err_add_app', 'Could not add the app ({status})', { status: res.status }));
                return;
            }
            setAppId(''); setTool(''); setLabel(''); setFixedArgsText('');
            onGranted();
        } catch (e) {
            onError(e.message || t('webpages.apps.err_network', 'Could not reach the server.'));
        } finally {
            setSubmitting(false);
        }
    };

    const selectCls = 'w-full px-2 py-1.5 rounded text-[12px] border outline-none';
    const selectStyle = { background: 'var(--vsc-editor-bg)', borderColor: 'var(--vsc-border)', color: 'var(--vsc-fg)' };

    return (
        <div className="flex flex-col gap-2 p-2 rounded border" style={{ borderColor: 'var(--vsc-border)', background: 'var(--vsc-editor-bg)' }}>
            <label className="flex flex-col gap-1">
                <span className="text-[11px]" style={{ color: 'var(--vsc-fg-muted)' }}>{t('webpages.apps.field_app', 'App')}</span>
                <select
                    className={selectCls}
                    style={selectStyle}
                    value={appId}
                    aria-label={t('webpages.apps.field_app', 'App')}
                    onChange={(e) => { setAppId(e.target.value); setTool(''); setNeedConnect(null); }}
                >
                    <option value="">{t('webpages.apps.choose_app', 'Choose an app…')}</option>
                    {/*
                      * DRIE standen, niet twee. `available === null` betekent
                      * "de statuscontrole is niet gelukt" — daar heeft dit
                      * paneel al een eigen banner voor (discovery_failed) en de
                      * pil hiernaast zegt "Status unknown". Zo'n app UITZETTEN
                      * en er "not connected" bij schrijven vertelt de auteur
                      * dat hij een koppeling moet gaan maken die er misschien
                      * gewoon is, en laat hem intussen niet kiezen.
                      */}
                    {apps.map(a => (
                        <option key={a.id} value={a.id} disabled={a.available === false}>
                            {a.available === true ? (a.label || a.id)
                                : a.available === false
                                    ? t('webpages.apps.option_not_connected', '{name} — not connected', { name: a.label || a.id })
                                    : t('webpages.apps.option_status_unknown', '{name} — status unknown', { name: a.label || a.id })}
                        </option>
                    ))}
                </select>
            </label>
            {app && app.available === false ? (
                <p className="text-[11px] flex items-start gap-1.5" style={{ color: '#d97706' }}>
                    <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                    <span>
                        {t('webpages.apps.app_not_connected', "{name} isn't connected to your account.", { name: app.label || app.id })}{' '}
                        <ConnectLink webpageId={webpageId}>{t('webpages.apps.connect_in_settings', 'Connect it in Settings → Integrations')}</ConnectLink>{' '}
                        {t('webpages.apps.come_back', 'and come back — this list updates when you return.')}
                    </span>
                </p>
            ) : app && app.available !== true ? (
                <p className="text-[11px] flex items-start gap-1.5" style={{ color: 'var(--vsc-fg-muted)' }} data-testid="app-status-unknown">
                    <HelpCircle size={12} className="mt-0.5 shrink-0" />
                    <span>
                        {t('webpages.apps.app_status_unknown',
                            "Bee Flow couldn't check whether {name} is connected. Adding it is fine; it will simply fail at run time if it isn't.",
                            { name: app.label || app.id })}
                    </span>
                </p>
            ) : null}
            <label className="flex flex-col gap-1">
                <span className="text-[11px]" style={{ color: 'var(--vsc-fg-muted)' }}>{t('webpages.apps.field_what', 'What it may do')}</span>
                <select
                    className={selectCls}
                    style={selectStyle}
                    value={tool}
                    aria-label={t('webpages.apps.field_action', 'Action')}
                    disabled={!app || app.available !== true}
                    onChange={(e) => setTool(e.target.value)}
                >
                    <option value="">{app
                        ? t('webpages.apps.choose_action', 'Choose an action…')
                        : t('webpages.apps.pick_app_first', 'Pick an app first')}</option>
                    {actions.map(x => (
                        <option key={x.name} value={x.name}>{x.label || x.name}</option>
                    ))}
                </select>
            </label>
            <label className="flex flex-col gap-1">
                <span className="text-[11px]" style={{ color: 'var(--vsc-fg-muted)' }}>{t('webpages.apps.field_label', 'Label (optional)')}</span>
                <input
                    className={selectCls}
                    style={selectStyle}
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    placeholder={t('webpages.apps.ph_label', 'e.g. Notify the team channel')}
                    spellCheck={false}
                />
            </label>
            <label className="flex flex-col gap-1">
                <span className="text-[11px] inline-flex items-center gap-1" style={{ color: 'var(--vsc-fg-muted)' }}>
                    <Lock size={11} /> {t('webpages.apps.field_pinned', 'Pinned arguments (optional JSON)')}
                </span>
                <textarea
                    className={`${selectCls} font-mono min-h-[3.5rem]`}
                    style={selectStyle}
                    value={fixedArgsText}
                    onChange={(e) => setFixedArgsText(e.target.value)}
                    placeholder={t('webpages.apps.ph_pinned', '{ "channel": "#general" }')}
                    spellCheck={false}
                />
                <span className="text-[10px]" style={{ color: 'var(--vsc-fg-muted)' }}>
                    {t('webpages.apps.pinned_hint', 'Pinned values always win over what the page sends — pin anything a visitor must not choose (recipient, channel, sheet id).')}
                </span>
                {fixedArgsError ? <span className="text-[10px]" style={{ color: '#ef4444' }}>{fixedArgsError}</span> : null}
            </label>
            {needConnect ? (
                <p className="text-[11px]" style={{ color: '#d97706' }}>
                    {t('webpages.apps.need_connect', "That app isn't connected (anymore).")} <ConnectLink webpageId={webpageId}>{t('webpages.apps.reconnect_it', 'Reconnect it')}</ConnectLink> {t('webpages.apps.and_try_again', 'and try again.')}
                </p>
            ) : null}
            <button
                type="button"
                onClick={submit}
                disabled={!tool || submitting}
                className="self-start inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-[12px] font-medium text-white disabled:opacity-50"
                style={{ background: 'var(--vsc-accent)' }}
            >
                {submitting ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
                {t('webpages.apps.add_to_page', 'Add to page')}
            </button>
        </div>
    );
}

// ─── Add-a-routine form ─────────────────────────────────────────────

function AddRoutineForm({ webpageId, automations, onGranted, onError }) {
    const { t } = useTranslation();
    const [automationId, setAutomationId] = useState('');
    const [submitting, setSubmitting] = useState(false);

    const submit = async () => {
        setSubmitting(true);
        try {
            const res = await authFetch(GRANTS_BASE(webpageId) + '/automations', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ automationId }),
            });
            const body = await readJson(res);
            if (!res.ok) { onError(body?.error || t('webpages.apps.err_add_routine', 'Could not add the routine ({status})', { status: res.status })); return; }
            setAutomationId('');
            onGranted();
        } catch (e) {
            onError(e.message || t('webpages.apps.err_network', 'Could not reach the server.'));
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div className="flex items-end gap-2">
            <label className="flex flex-col gap-1 flex-1">
                <span className="text-[11px]" style={{ color: 'var(--vsc-fg-muted)' }}>{t('webpages.apps.field_routine', 'Routine')}</span>
                <select
                    className="w-full px-2 py-1.5 rounded text-[12px] border outline-none"
                    style={{ background: 'var(--vsc-editor-bg)', borderColor: 'var(--vsc-border)', color: 'var(--vsc-fg)' }}
                    value={automationId}
                    aria-label={t('webpages.apps.field_routine', 'Routine')}
                    onChange={(e) => setAutomationId(e.target.value)}
                >
                    <option value="">{t('webpages.apps.choose_routine', 'Choose a routine…')}</option>
                    {automations.map(a => (
                        <option key={a.automationId || a.id} value={a.automationId || a.id}>
                            {a.title || a.automationId || a.id}
                        </option>
                    ))}
                </select>
            </label>
            <button
                type="button"
                onClick={submit}
                disabled={!automationId || submitting}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-[12px] font-medium text-white disabled:opacity-50"
                style={{ background: 'var(--vsc-accent)' }}
            >
                {submitting ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
                {t('common.add', 'Add')}
            </button>
        </div>
    );
}

// ─── The panel ──────────────────────────────────────────────────────

export default function WebpageAppsPanel({ webpageId, readOnly = false }) {
    // Keep the api in a ref: useAutomationApi is memoised in production, but
    // depending on it directly would re-fire load() whenever a consumer's mock
    // (or any future change) returns a fresh object per render — the exact
    // loop the hook's own useMemo warns about.
    const { t } = useTranslation();
    // Zelfde reden als apiRef hierboven: zonder TranslationProvider is t bij
    // elke render een nieuwe functie, en in de deps van load() zou dat het
    // laad-effect eindeloos opnieuw laten vuren.
    const tRef = React.useRef(t);
    tRef.current = t;
    const apiRef = React.useRef(null);
    apiRef.current = useAutomationApi();
    const [grants, setGrants] = useState(null);
    const [catalog, setCatalog] = useState(null);
    const [catalogFailed, setCatalogFailed] = useState(false);
    const [automations, setAutomations] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [adding, setAdding] = useState(null); // null | 'app' | 'routine'
    const lastFetchRef = React.useRef(0);

    const load = useCallback(async () => {
        if (!webpageId || readOnly) return;
        lastFetchRef.current = Date.now();
        setError(null);
        try {
            const res = await authFetch(GRANTS_BASE(webpageId));
            const body = await readJson(res);
            if (!res.ok) throw new Error(body?.error || tRef.current('webpages.apps.err_load', 'Could not load apps ({status})', { status: res.status }));
            setGrants(body);
        } catch (e) {
            setError(e.message);
        }
        // Catalog + routines are best-effort: grants stay manageable without them.
        try {
            const c = await apiRef.current.getCatalog();
            setCatalog(c);
            setCatalogFailed(false);
        } catch {
            setCatalog(null);
            setCatalogFailed(true);
        }
        try {
            const r = await apiRef.current.listAutomations();
            setAutomations(r.automations || []);
        } catch {
            setAutomations([]);
        }
        setLoading(false);
    }, [webpageId, readOnly]);

    useEffect(() => { setLoading(true); load(); }, [load]);

    // Refetch when the window regains focus (e.g. back from Settings →
    // Integrations), but not more often than FOCUS_REFETCH_MS.
    useEffect(() => {
        const onFocus = () => {
            if (Date.now() - lastFetchRef.current > FOCUS_REFETCH_MS) load();
        };
        window.addEventListener('focus', onFocus);
        return () => window.removeEventListener('focus', onFocus);
    }, [load]);

    const revoke = async (kind, key) => {
        setError(null);
        try {
            const res = await authFetch(`${GRANTS_BASE(webpageId)}/${kind}/${encodeURIComponent(key)}`, { method: 'DELETE' });
            const body = await readJson(res);
            if (!res.ok) throw new Error(body?.error || t('webpages.apps.err_remove', 'Could not remove ({status})', { status: res.status }));
            await load();
        } catch (e) {
            setError(e.message);
        }
    };

    if (readOnly) {
        return (
            <div className="p-3 text-[12px]" style={{ color: 'var(--vsc-fg-muted)' }}>
                {t('webpages.apps.owner_only', 'Only the page owner can manage the apps and routines this page may use.')}
            </div>
        );
    }

    const grantedIntegrations = grants?.integrations || [];
    const grantedAutomations = grants?.automations || [];

    return (
        <div className="flex flex-col h-full overflow-y-auto p-2 gap-3 text-[12px]" style={{ color: 'var(--vsc-fg)' }}>
            <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--vsc-fg-muted)' }}>
                    {t('webpages.apps.title', 'Apps & data')}
                </span>
                <button
                    type="button"
                    onClick={load}
                    title={t('webpages.refresh', 'Refresh')}
                    aria-label={t('webpages.apps.refresh_aria', 'Refresh apps and grants')}
                    className="p-1 rounded hover:bg-[var(--vsc-hover-bg)]"
                    style={{ color: 'var(--vsc-fg-muted)' }}
                >
                    <RefreshCw size={13} />
                </button>
            </div>

            <p className="text-[11px] -mt-1" style={{ color: 'var(--vsc-fg-muted)' }}>
                {t('webpages.apps.subtitle', 'What this page may call, running as you. Visitors never need their own accounts.')}
            </p>

            {error ? (
                <p role="alert" className="flex items-start gap-1.5 text-[11px]" style={{ color: '#ef4444' }}>
                    <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                    <span>{error}</span>
                </p>
            ) : null}

            {grants?.discoveryFailed ? (
                <p className="flex items-start gap-1.5 text-[11px]" style={{ color: '#d97706' }}>
                    <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                    <span>{t('webpages.apps.discovery_failed', "Couldn't verify your connected apps — statuses below may be stale.")}</span>
                </p>
            ) : null}

            {loading ? (
                <p className="inline-flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--vsc-fg-muted)' }}>
                    <Loader2 size={12} className="animate-spin" /> {t('webpages.sources.loading', 'Loading…')}
                </p>
            ) : (
                <>
                    {/* Granted integrations */}
                    <section className="flex flex-col gap-1">
                        <span className="text-[11px] font-medium" style={{ color: 'var(--vsc-fg-muted)' }}>{t('webpages.apps.section_apps', 'Apps')}</span>
                        {grantedIntegrations.length === 0 ? (
                            // `grants` blijft null als de lezing omviel, en dan
                            // is deze lijst leeg zonder dat er iets geteld is.
                            // "No apps yet" is een bewering; de auteur zou vijf
                            // verleende koppelingen niet zien en ze dus ook niet
                            // kunnen intrekken.
                            <p className="text-[11px]" style={{ color: grants ? 'var(--vsc-fg-muted)' : '#d97706' }} data-testid="apps-empty">
                                {grants
                                    ? t('webpages.apps.none_yet', 'No apps yet. Add one so the page can read or act in tools you already use.')
                                    : t('webpages.apps.grants_unreadable', 'The apps on this page could not be read, so this is not “no apps”. Try again before you add one.')}
                            </p>
                        ) : grantedIntegrations.map(g => (
                            <div
                                key={g.tool}
                                className="group flex items-center gap-2 px-2 py-1.5 rounded border"
                                style={{ borderColor: 'var(--vsc-border)', background: 'var(--vsc-editor-bg)' }}
                            >
                                <Plug size={13} className="shrink-0" style={{ color: 'var(--vsc-fg-muted)' }} />
                                <div className="min-w-0 flex-1">
                                    <div className="truncate" title={g.tool}>
                                        {g.label || (g.tool || '').replace(/_/g, ' ')}
                                        {g.integrationLabel ? (
                                            <span style={{ color: 'var(--vsc-fg-muted)' }}> · {g.integrationLabel}</span>
                                        ) : null}
                                        {g.hasFixedArgs ? (
                                            <Lock size={10} className="inline ml-1 -mt-0.5" aria-label={t('webpages.apps.has_pinned', 'Has pinned arguments')} />
                                        ) : null}
                                    </div>
                                    <StatusPill available={g.available} />
                                </div>
                                {g.available === false ? (
                                    <ConnectLink webpageId={webpageId}>{t('webpages.apps.reconnect', 'Reconnect')}</ConnectLink>
                                ) : null}
                                <button
                                    type="button"
                                    onClick={() => revoke('integrations', g.tool)}
                                    aria-label={t('webpages.build.remove_source', 'Remove {name}', { name: g.tool })}
                                    className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-[var(--vsc-hover-bg)]"
                                    style={{ color: '#ef4444' }}
                                >
                                    <Trash2 size={12} />
                                </button>
                            </div>
                        ))}
                        {adding === 'app' ? (
                            <div className="relative">
                                <button
                                    type="button"
                                    onClick={() => setAdding(null)}
                                    aria-label={t('common.close', 'Close')}
                                    className="absolute right-1 top-1 p-1 rounded hover:bg-[var(--vsc-hover-bg)]"
                                    style={{ color: 'var(--vsc-fg-muted)' }}
                                >
                                    <X size={12} />
                                </button>
                                <AddAppForm
                                    webpageId={webpageId}
                                    catalog={catalog}
                                    onGranted={() => { setAdding(null); load(); }}
                                    onError={setError}
                                />
                            </div>
                        ) : (
                            <button
                                type="button"
                                onClick={() => setAdding('app')}
                                disabled={catalogFailed && !catalog}
                                title={catalogFailed ? t('webpages.apps.catalog_failed_title', 'The app catalog could not be loaded') : undefined}
                                className="self-start inline-flex items-center gap-1.5 px-2 py-1.5 rounded border border-dashed text-[11px] disabled:opacity-50"
                                style={{ borderColor: 'var(--vsc-border)', color: 'var(--vsc-fg-muted)' }}
                            >
                                <AppWindow size={12} /> {t('webpages.apps.add_app', 'Add an app')}
                            </button>
                        )}
                        {catalogFailed ? (
                            <p className="text-[10px]" style={{ color: 'var(--vsc-fg-muted)' }}>
                                {t('webpages.apps.catalog_failed', "Your app catalog couldn't be loaded (automations may be off for your plan). Refresh to try again.")}
                            </p>
                        ) : null}
                    </section>

                    {/* Granted routines */}
                    <section className="flex flex-col gap-1">
                        <span className="text-[11px] font-medium" style={{ color: 'var(--vsc-fg-muted)' }}>{t('webpages.apps.section_routines', 'Routines')}</span>
                        {grantedAutomations.length === 0 ? (
                            <p className="text-[11px]" style={{ color: grants ? 'var(--vsc-fg-muted)' : '#d97706' }} data-testid="routines-empty">
                                {grants
                                    ? t('webpages.apps.no_routines', 'No routines yet. Let the page trigger one of your routines and use its result.')
                                    : t('webpages.apps.grants_unreadable', 'The apps on this page could not be read, so this is not “no apps”. Try again before you add one.')}
                            </p>
                        ) : grantedAutomations.map(g => (
                            <div
                                key={g.automationId}
                                className="group flex items-center gap-2 px-2 py-1.5 rounded border"
                                style={{ borderColor: 'var(--vsc-border)', background: 'var(--vsc-editor-bg)' }}
                            >
                                <Workflow size={13} className="shrink-0" style={{ color: 'var(--vsc-fg-muted)' }} />
                                <span className="min-w-0 flex-1 truncate" title={g.automationId}>
                                    {g.label || g.automationId}
                                </span>
                                <button
                                    type="button"
                                    onClick={() => revoke('automations', g.automationId)}
                                    aria-label={t('webpages.build.remove_source', 'Remove {name}', { name: g.label || g.automationId })}
                                    className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-[var(--vsc-hover-bg)]"
                                    style={{ color: '#ef4444' }}
                                >
                                    <Trash2 size={12} />
                                </button>
                            </div>
                        ))}
                        {adding === 'routine' ? (
                            <div className="relative">
                                <button
                                    type="button"
                                    onClick={() => setAdding(null)}
                                    aria-label={t('common.close', 'Close')}
                                    className="absolute right-1 -top-1 p-1 rounded hover:bg-[var(--vsc-hover-bg)] z-10"
                                    style={{ color: 'var(--vsc-fg-muted)' }}
                                >
                                    <X size={12} />
                                </button>
                                <AddRoutineForm
                                    webpageId={webpageId}
                                    automations={automations}
                                    onGranted={() => { setAdding(null); load(); }}
                                    onError={setError}
                                />
                            </div>
                        ) : (
                            <button
                                type="button"
                                onClick={() => setAdding('routine')}
                                className="self-start inline-flex items-center gap-1.5 px-2 py-1.5 rounded border border-dashed text-[11px]"
                                style={{ borderColor: 'var(--vsc-border)', color: 'var(--vsc-fg-muted)' }}
                            >
                                <Workflow size={12} /> {t('webpages.apps.add_routine', 'Add a routine')}
                            </button>
                        )}
                    </section>
                </>
            )}
        </div>
    );
}
