import { AlertTriangle, AppWindow, CheckCircle2, Database, Globe, Loader2, Mail, Plug, Plus, Trash2, Workflow } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';
import ActionParamsForm, { missingRequiredParams } from './ActionParamsForm';
import ConnectorChainEditor from './ConnectorChainEditor';
import ConnectorPicker from './ConnectorPicker';
import ConnectorSyncPanel from './ConnectorSyncPanel';
import useIntegrationCatalog from './useIntegrationCatalog';
import { getIntegrationIcon } from '../../../../../config/integrationIcons';
import useAutomationApi from '../../../../../hooks/useAutomationApi';
import useTranslation from '../../../../../hooks/useTranslation';
import { API_BASE, authFetch } from '../../../../../utils/helpers';
import ChoiceCards from '../../../../shared/ChoiceCards';
import Disclosure from '../../../../shared/Disclosure';
import { useEditorChrome } from '../editor/EditorChromeContext';
import AutomationPicker from '../inspector/AutomationPicker';

/**
 * App Studio BI — the owner's external-connectors editor.
 *
 * A connector is an owner-authored external data source (server contract in
 * server/appStudio/connectors.js + validated by dataModel.js). Three kinds:
 *   integration_tool — dispatch a platform tool with author-pinned fixedArgs
 *   automation       — trigger one of the owner's automations
 *   rest             — GET an https-only, allow-listed URL template
 *
 * ── ONE CONNECTOR = ONE ACTION ──────────────────────────────────────
 * That has always been the model, and it stays: it keeps one row shape per
 * connector, which is what makes a connector map cleanly onto one table and
 * leaves every existing contract (bindings, validation, the runtime, the publish
 * summary) untouched. What changed is the authoring cost — ConnectorPicker is
 * the same multi-select app menu as the agent editor, and ticking five Gmail
 * actions creates five connectors at once instead of five trips through a pair
 * of dropdowns. They are grouped by app in the list so it still reads as "Gmail,
 * five things".
 *
 * The right pane answers, in order, the questions an author actually has:
 *   what is it → what does the action NEED (ActionParamsForm, from the action's
 *   own JSON Schema) → does it need another action first (ConnectorChainEditor)
 *   → whose connection → should it fill a table (ConnectorSyncPanel) → does it
 *   work (TestPanel) → the raw escape hatches.
 *
 * This is a CONTROLLED component over `model.connectors[]`: it never saves —
 * the parent (TablesManager) owns the model and persists the whole thing through
 * the existing PUT /:id/schema save path, so connectors round-trip with the rest
 * of the data model. Credentials are NEVER entered here as raw values: the rest
 * editor only references the owner's credential store by provider id
 * (auth.credentialProvider) — the server resolves the secret.
 *
 * The endpoints it touches all resolve the connector from the LAST SAVED owner
 * model, so an unsaved draft 404s; that is said out loud rather than shown as a
 * mystery failure. All are rate-limited server-side and only ever fire on a click.
 *
 *   <ConnectorsManager connectors={model.connectors} onChange={next => …} />
 */

const kinds = (t) => [
    {
        value: 'mailbox',
        tag: t('studio_apps_bi.connectors.kind_mailbox_tag', 'Mailbox'),
        label: t('studio_apps_bi.connectors.kind_mailbox_label', 'My mailbox'),
        description: t('studio_apps_bi.connectors.kind_mailbox_desc', 'Reads mail into a table using the Google or Microsoft account you signed in to Bee Flow with. Your own inbox, or a shared one you have access to.'),
        Icon: Mail,
        badge: t('studio_apps_bi.connectors.kind_mailbox_badge', 'For inboxes'),
    },
    {
        value: 'integration_tool',
        tag: t('studio_apps_bi.connectors.kind_app_tag', 'App'),
        label: t('studio_apps_bi.connectors.kind_app_label', 'An app you already use'),
        description: t('studio_apps_bi.connectors.kind_app_desc', 'Gmail, Slack, Google Sheets… — pick the app, then what it should fetch.'),
        Icon: AppWindow,
        badge: t('studio_apps_bi.connectors.kind_app_badge', 'Easiest'),
    },
    {
        value: 'automation',
        tag: t('studio_apps_bi.connectors.kind_automation_tag', 'Automation'),
        label: t('studio_apps_bi.connectors.kind_automation_label', 'One of my Automations'),
        description: t('studio_apps_bi.connectors.kind_automation_desc', 'Run an automation you already built and show whatever it hands back.'),
        Icon: Workflow,
    },
    {
        value: 'rest',
        tag: t('studio_apps_bi.connectors.kind_rest_tag', 'Web address'),
        label: t('studio_apps_bi.connectors.kind_rest_label', 'Another system via its web address'),
        description: t('studio_apps_bi.connectors.kind_rest_desc', 'Advanced. For a system with no ready-made app — you need its web address and sign-in details from whoever runs it.'),
        Icon: Globe,
    },
];

const PARAM_TYPES = ['text', 'number', 'boolean'];

const INPUT = 'w-full rounded-md px-2 py-1.5 text-sm bg-[var(--bg-tertiary)] border border-[var(--border-default)] text-[var(--text-primary)]';
const LABEL = 'text-xs font-medium text-[var(--text-secondary)]';

function randHex(n) {
    let s = '';
    while (s.length < n) s += Math.floor(Math.random() * 16).toString(16);
    return s.slice(0, n);
}
function newConnectorId() { return `conn_${randHex(6)}`; }

function labelForKind(kind, t) {
    return kinds(t).find((k) => k.value === kind)?.tag || kind;
}

// connectorProblem is also called outside React (at save time), so `t` is
// optional: without it the English default is used, with placeholders filled.
function plainT(_key, english, params) {
    return english.replace(/\{(\w+)\}/g, (m, k) => (params && Object.hasOwn(params, k) ? String(params[k]) : m));
}

/**
 * What a connector is still missing before it can work — the per-kind required
 * field in server/appStudio/dataModel.js, plus (when we know the action's
 * schema) any REQUIRED parameter nothing supplies.
 *
 * That second half is what turns the old failure mode — pick `gmail_read`, get
 * an empty JSON box, press "Test it", read "Connector failed to run" — into a
 * sentence on screen before anything is attempted. `action` is optional so the
 * function still works when the catalog hasn't loaded (TablesManager calls it
 * for every connector at save time, catalog or no catalog).
 *
 * Returns null when the connector is complete.
 */
export function connectorProblem(connector, action = null, t = plainT) {
    if (!connector) return null;
    if (connector.kind === 'rest' && !connector.url) return t('studio_apps_bi.connectors.problem_rest_url', 'still needs the web address it reads from');
    if (connector.kind === 'integration_tool' && !connector.tool) return t('studio_apps_bi.connectors.problem_tool', 'still needs an app and an action');
    if (connector.kind === 'automation' && !connector.automationId) return t('studio_apps_bi.connectors.problem_automation', 'still needs the automation it runs');
    if (connector.kind === 'mailbox') {
        if (!connector.provider) return t('studio_apps_bi.connectors.problem_provider', 'still needs to know whether it reads Gmail or Outlook');
        if (connector.mode === 'shared' && !connector.address) return t('studio_apps_bi.connectors.problem_address', 'still needs the address of the shared mailbox');
        if (!connector.sync?.tableId) return t('studio_apps_bi.connectors.problem_table', 'still needs the table it writes messages into');
    }
    if (connector.kind === 'integration_tool' && action) {
        const missing = missingRequiredParams(action, connector);
        if (missing.length) {
            return t('studio_apps_bi.connectors.problem_params', 'still needs {params} — pin a value, ask the viewer, or get it from another action', { params: missing.join(` ${t('studio_apps_bi.filter.and', 'and')} `) });
        }
    }
    return null;
}

// A JSON object editor that keeps its own raw text and only commits VALID JSON
// objects upward — an invalid draft shows an inline hint without corrupting the
// model (parity with how the data model tolerates half-typed input).
function JsonObjectField({ label, value, onChange, disabled, placeholder }) {
    const { t } = useTranslation();
    const [text, setText] = useState(() => (value && Object.keys(value).length ? JSON.stringify(value, null, 2) : ''));
    const [error, setError] = useState(null);
    const commit = (raw) => {
        setText(raw);
        const trimmed = raw.trim();
        if (trimmed === '') { setError(null); onChange(undefined); return; }
        try {
            const parsed = JSON.parse(trimmed);
            if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) { setError(t('studio_apps_bi.connectors.json_must_be_object', 'Must be a JSON object')); return; }
            setError(null);
            onChange(parsed);
        } catch {
            setError(t('studio_apps_bi.params.invalid_json', 'Invalid JSON'));
        }
    };
    return (
        <label className="flex flex-col gap-1">
            <span className={LABEL}>{label}</span>
            <textarea
                className={`${INPUT} font-mono min-h-[4.5rem]`}
                value={text}
                onChange={(e) => commit(e.target.value)}
                placeholder={placeholder}
                disabled={disabled}
                spellCheck={false}
            />
            {error ? <span className="text-xs text-[var(--error)]">{error}</span> : null}
        </label>
    );
}

function ParamsEditor({ params, onChange, disabled }) {
    const { t } = useTranslation();
    const list = Array.isArray(params) ? params : [];
    const patch = (i, p) => onChange(list.map((x, j) => (j === i ? { ...x, ...p } : x)));
    const add = () => onChange([...list, { key: '', type: 'text', required: false }]);
    const remove = (i) => onChange(list.filter((_, j) => j !== i));
    return (
        <div className="flex flex-col gap-1.5">
            <span className={LABEL}>{t('studio_apps_bi.connectors.viewer_params', 'Viewer params')}</span>
            {list.length === 0 ? (
                <p className="text-xs text-[var(--text-tertiary)]">{t('studio_apps_bi.connectors.no_params', 'No params — the connector runs with only its pinned arguments.')}</p>
            ) : null}
            {list.map((p, i) => (
                <div key={i} className="flex items-center gap-1.5">
                    <input
                        className={`${INPUT} flex-1`}
                        value={p.key || ''}
                        onChange={(e) => patch(i, { key: e.target.value })}
                        placeholder={t('studio_apps_bi.connectors.param_key_placeholder', 'key')}
                        disabled={disabled}
                        aria-label={t('studio_apps_bi.connectors.param_key', 'Param {n} key', { n: i + 1 })}
                        spellCheck={false}
                    />
                    <select
                        className={`${INPUT} w-28`}
                        value={p.type || 'text'}
                        onChange={(e) => patch(i, { type: e.target.value })}
                        disabled={disabled}
                        aria-label={t('studio_apps_bi.connectors.param_type', 'Param {n} type', { n: i + 1 })}
                    >
                        {PARAM_TYPES.map((pt) => <option key={pt} value={pt}>{pt}</option>)}
                    </select>
                    <label className="inline-flex items-center gap-1 text-xs text-[var(--text-secondary)]">
                        <input
                            type="checkbox"
                            checked={!!p.required}
                            onChange={(e) => patch(i, { required: e.target.checked })}
                            disabled={disabled}
                            className="accent-[var(--accent-primary)]"
                        />
                        {t('studio_apps_bi.connectors.param_req', 'req')}
                    </label>
                    <button
                        type="button"
                        onClick={() => remove(i)}
                        disabled={disabled}
                        aria-label={t('studio_apps_bi.connectors.remove_param', 'Remove param {n}', { n: i + 1 })}
                        className="p-1 rounded hover:bg-[var(--bg-card-hover)]"
                        style={{ color: 'var(--error)' }}
                    >
                        <Trash2 className="h-3.5 w-3.5" />
                    </button>
                </div>
            ))}
            <button
                type="button"
                onClick={add}
                disabled={disabled}
                className="self-start inline-flex items-center gap-1 rounded-md border border-dashed px-2 py-1 text-xs"
                style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}
            >
                <Plus className="h-3 w-3" aria-hidden="true" /> {t('studio_apps_bi.connectors.add_param', 'Add param')}
            </button>
        </div>
    );
}

function TextField({ label, value, onChange, disabled, placeholder }) {
    return (
        <label className="flex flex-col gap-1">
            <span className={LABEL}>{label}</span>
            <input
                className={INPUT}
                value={value ?? ''}
                onChange={(e) => onChange(e.target.value)}
                placeholder={placeholder}
                disabled={disabled}
                spellCheck={false}
            />
        </label>
    );
}

/**
 * The kind question, asked before anything is created.
 *
 * "An app you already use" no longer creates an empty connector to configure —
 * it opens the picker, where ticking actions creates one connector each. The
 * other two kinds still create a single blank connector, because an automation or a
 * URL is genuinely one thing you then fill in.
 */
function KindChooser({ onCreate, onCancel, onPickApps, disabled }) {
    const { t } = useTranslation();
    const [kind, setKind] = useState('integration_tool');
    const pickingApps = kind === 'integration_tool';
    return (
        <div className="flex flex-col gap-3">
            <div>
                <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{t('studio_apps_bi.connectors.where_data', 'Where should this get its data?')}</p>
                <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{t('studio_apps_bi.connectors.change_later', 'You can change this later.')}</p>
            </div>
            <ChoiceCards
                value={kind}
                onChange={setKind}
                options={kinds(t)}
                columns={1}
                ariaLabel={t('studio_apps_bi.connectors.where_data', 'Where should this get its data?')}
                disabled={disabled}
            />
            <div className="flex items-center gap-2">
                <button
                    type="button"
                    onClick={() => (pickingApps ? onPickApps?.() : onCreate(kind))}
                    disabled={disabled}
                    className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                    style={{ background: 'var(--accent-primary)' }}
                >
                    {pickingApps ? <AppWindow className="h-3.5 w-3.5" aria-hidden="true" /> : null}
                    {pickingApps ? t('studio_apps_bi.connectors.choose_apps', 'Choose apps & actions') : t('studio_apps_bi.connectors.add_it', 'Add it')}
                </button>
                {onCancel ? (
                    <button
                        type="button"
                        onClick={onCancel}
                        className="rounded-md px-3 py-1.5 text-sm"
                        style={{ color: 'var(--text-secondary)' }}
                    >
                        {t('studio_apps_bi.common.cancel', 'Cancel')}
                    </button>
                ) : null}
            </div>
        </div>
    );
}

/**
 * The automation a connector runs, by name. The picker is the same one the
 * inspector uses; the id stays hand-editable one disclosure deeper for automations
 * the list can't reach (another owner's, or one built after this loaded).
 */
function AutomationField({ connector, onChangeId, disabled }) {
    const { t } = useTranslation();
    const api = useAutomationApi();
    const [open, setOpen] = useState(false);
    const [titles, setTitles] = useState({});
    const automationId = connector.automationId || '';
    const title = automationId ? titles[automationId] || null : null;

    useEffect(() => {
        if (!automationId) return undefined;
        let alive = true;
        api.listAutomations()
            .then((r) => {
                const found = (r.automations || []).find((a) => a.id === automationId)?.title || '';
                if (alive) setTitles((prev) => ({ ...prev, [automationId]: found }));
            })
            .catch(() => { /* the id stays on screen — it is still the truth */ });
        return () => { alive = false; };
    }, [automationId, api]);

    return (
        <div className="flex flex-col gap-1.5">
            <span className={LABEL}>{t('studio_apps_bi.connectors.kind_automation_tag', 'Automation')}</span>
            <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm" style={{ color: automationId ? 'var(--text-primary)' : 'var(--text-tertiary)' }}>
                    {title || automationId || t('studio_apps_bi.connectors.no_automation', 'No automation chosen yet')}
                </span>
                <button
                    type="button"
                    onClick={() => setOpen(true)}
                    disabled={disabled}
                    className="shrink-0 rounded-md border px-2.5 py-1.5 text-xs font-medium disabled:opacity-50"
                    style={{ borderColor: 'var(--border-default)', color: 'var(--text-primary)' }}
                >
                    {automationId ? t('studio_apps_bi.connectors.choose_another', 'Choose another') : t('studio_apps_bi.connectors.choose_automation', 'Choose an automation')}
                </button>
            </div>
            <Disclosure title={t('studio_apps_bi.connectors.type_id', 'Type the id myself')}>
                <TextField
                    label={t('studio_apps_bi.connectors.automation_id', 'Automation id')}
                    value={connector.automationId}
                    onChange={onChangeId}
                    disabled={disabled}
                    placeholder="auto-123"
                />
            </Disclosure>
            <AutomationPicker
                open={open}
                onClose={() => setOpen(false)}
                onPick={(automation) => {
                    setOpen(false);
                    if (automation?.id) setTitles((prev) => ({ ...prev, [automation.id]: automation.title || '' }));
                    onChangeId(automation?.id || '');
                }}
            />
        </div>
    );
}

function cellText(value) {
    if (value === null || value === undefined) return '';
    const s = typeof value === 'object' ? JSON.stringify(value) : String(value);
    return s.length > 60 ? `${s.slice(0, 60)}…` : s;
}

// The first rows as a small grid. Rows that aren't objects (a connector may
// return plain strings) collapse to one unnamed column rather than nothing.
function previewGrid(rows) {
    const sample = rows.slice(0, 3);
    const objects = sample.filter((r) => r && typeof r === 'object' && !Array.isArray(r));
    if (!sample.length || objects.length !== sample.length) {
        return { columns: ['value'], cells: sample.map((r) => ({ value: cellText(r) })) };
    }
    const columns = [...new Set(objects.flatMap((r) => Object.keys(r)))].slice(0, 4);
    return { columns, cells: objects.map((r) => Object.fromEntries(columns.map((c) => [c, cellText(r[c])]))) };
}

/** What the server's failure means for the person who pressed the button. */
function testFailureMessage(status, body, t) {
    if (status === 404) return t('studio_apps_bi.connectors.test_save_first', 'Save your changes first — a test always runs the last saved version of this connector.');
    if (body?.code === 'connection_required') {
        const app = body.provider || t('studio_apps_bi.sync.err_connect_that_app', 'that app');
        return t('studio_apps_bi.connectors.test_connect_first', 'Connect {app} to your account first (Settings → Integrations), then test again.', { app });
    }
    if (status === 429) return t('studio_apps_bi.connectors.test_rate_limited', 'That is a lot of tests in one minute. Wait a moment and try again.');
    return body?.error || t('studio_apps_bi.sync.err_failed', 'It did not work ({status}).', { status });
}

/**
 * Run the connector and show what came back. The route reads the SAVED model,
 * so this is also the only place that can tell the author their draft has never
 * reached the server (a 404 for an id that exists right here on screen).
 */
function TestPanel({ connector, appId, disabled, problem }) {
    const { t } = useTranslation();
    const [values, setValues] = useState({});
    const [result, setResult] = useState(null); // {status:'running'|'done'|'error', rows?, message?}
    const params = (Array.isArray(connector.params) ? connector.params : []).filter((p) => p && p.key);

    const run = async () => {
        setResult({ status: 'running' });
        try {
            const res = await authFetch(
                `${API_BASE}/api/studio-apps/${encodeURIComponent(appId)}/data/connectors/${encodeURIComponent(connector.id)}/run`,
                { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ params: values }) },
            );
            let body = null;
            try { body = await res.json(); } catch { body = null; }
            if (!res.ok) { setResult({ status: 'error', message: testFailureMessage(res.status, body, t) }); return; }
            setResult({ status: 'done', rows: Array.isArray(body?.rows) ? body.rows : [] });
        } catch (e) {
            setResult({ status: 'error', message: e.message || t('studio_apps_bi.sync.err_unreachable', 'Could not reach the server.') });
        }
    };

    const grid = result?.status === 'done' && result.rows.length ? previewGrid(result.rows) : null;

    return (
        <div className="flex flex-col gap-2 border-t pt-3" style={{ borderColor: 'var(--border-default)' }}>
            {params.length ? (
                <div className="flex flex-wrap items-end gap-2">
                    <span className={LABEL}>{t('studio_apps_bi.connectors.try_with', 'Try it with')}</span>
                    {params.map((p) => (
                        <input
                            key={p.key}
                            className={`${INPUT} w-40`}
                            value={values[p.key] ?? ''}
                            onChange={(e) => setValues({ ...values, [p.key]: e.target.value })}
                            placeholder={p.key}
                            aria-label={t('studio_apps_bi.connectors.test_value', 'Test value for {key}', { key: p.key })}
                            disabled={disabled}
                            spellCheck={false}
                        />
                    ))}
                </div>
            ) : null}
            <div className="flex items-center gap-2">
                <button
                    type="button"
                    onClick={run}
                    disabled={disabled || !appId || !!problem || result?.status === 'running'}
                    className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium disabled:opacity-50"
                    style={{ borderColor: 'var(--border-default)', color: 'var(--text-primary)' }}
                >
                    {result?.status === 'running'
                        ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                        : <Plug className="h-3.5 w-3.5" aria-hidden="true" />}
                    {t('studio_apps_bi.connectors.test_it', 'Test it')}
                </button>
                <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                    {!appId
                        ? t('studio_apps_bi.connectors.test_open_app', 'Open the app to test this.')
                        : problem
                            ? t('studio_apps_bi.connectors.test_finish_first', 'Finish the connector first.')
                            : t('studio_apps_bi.connectors.test_hint', 'Runs the last saved version and shows what comes back.')}
                </span>
            </div>

            {result?.status === 'error' ? (
                <p
                    role="alert"
                    className="flex items-start gap-1.5 rounded-md border px-2 py-1.5 text-xs"
                    style={{ borderColor: 'color-mix(in srgb, var(--error) 40%, transparent)', background: 'color-mix(in srgb, var(--error) 10%, transparent)', color: 'var(--error)' }}
                >
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    <span>{result.message}</span>
                </p>
            ) : null}

            {result?.status === 'done' ? (
                <div className="flex flex-col gap-1.5">
                    <p className="flex items-start gap-1.5 text-xs" style={{ color: result.rows.length ? '#10b981' : 'var(--text-secondary)' }}>
                        <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        <span>
                            {result.rows.length
                                ? (result.rows.length === 1
                                    ? t('studio_apps_bi.connectors.test_works_one', 'It works — 1 row came back.')
                                    : t('studio_apps_bi.connectors.test_works_many', 'It works — {n} rows came back.', { n: result.rows.length }))
                                : t('studio_apps_bi.connectors.test_works_empty', 'It works, but nothing came back. Check the pinned arguments or try other values.')}
                        </span>
                    </p>
                    {grid ? (
                        <div className="overflow-x-auto rounded-md border" style={{ borderColor: 'var(--border-default)' }}>
                            <table className="w-full text-left text-xs">
                                <thead>
                                    <tr>
                                        {grid.columns.map((c) => (
                                            <th key={c} className="px-2 py-1 font-medium" style={{ color: 'var(--text-secondary)' }}>{c}</th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody>
                                    {grid.cells.map((row, i) => (
                                        <tr key={i}>
                                            {grid.columns.map((c) => (
                                                <td key={c} className="px-2 py-1" style={{ color: 'var(--text-primary)' }}>{row[c]}</td>
                                            ))}
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
}

/**
 * Mailbox settings.
 *
 * The point this panel has to make, because it is the thing people ask about:
 * there is NO separate sign-in here. It reads mail with the Google or Microsoft
 * account you already used to sign in to Bee Flow.
 *
 * "Shared" means different things per provider and we say so out loud rather
 * than letting someone discover it at send time: Outlook can open a real shared
 * mailbox you have been given access to; the Gmail API cannot open anyone
 * else's mailbox at all, so there it means mail delivered to a team address
 * inside your own.
 */
function MailboxFields({ connector, setOpt, disabled, appId, saved }) {
    const { t } = useTranslation();
    const [verify, setVerify] = useState(null);
    const [verifying, setVerifying] = useState(false);
    const shared = connector.mode === 'shared';
    const isGmail = connector.provider === 'gmail';

    const runVerify = async () => {
        setVerifying(true);
        setVerify(null);
        try {
            const res = await authFetch(
                `${API_BASE}/api/studio-apps/${encodeURIComponent(appId)}/data/connectors/${encodeURIComponent(connector.id)}/verify`,
                { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
            );
            const body = await res.json().catch(() => null);
            setVerify(body || { ok: false, error: t('studio_apps_bi.connectors.check_failed', 'Check failed ({status})', { status: res.status }) });
        } catch (e) {
            setVerify({ ok: false, error: e.message });
        } finally {
            setVerifying(false);
        }
    };

    return (
        <div className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-2">
                <label className="flex flex-col gap-1">
                    <span className={LABEL}>{t('studio_apps_bi.connectors.mail_provider', 'Mail provider')}</span>
                    <select
                        className={INPUT}
                        value={connector.provider || ''}
                        onChange={(e) => setOpt('provider', e.target.value || undefined)}
                        disabled={disabled}
                        aria-label={t('studio_apps_bi.connectors.mail_provider', 'Mail provider')}
                    >
                        <option value="">{t('studio_apps_bi.connectors.choose', 'Choose…')}</option>
                        <option value="gmail">Gmail</option>
                        <option value="outlook">Outlook</option>
                    </select>
                </label>
                <label className="flex flex-col gap-1">
                    <span className={LABEL}>{t('studio_apps_bi.connectors.which_mailbox', 'Which mailbox')}</span>
                    <select
                        className={INPUT}
                        value={connector.mode || 'personal'}
                        onChange={(e) => setOpt('mode', e.target.value)}
                        disabled={disabled}
                        aria-label={t('studio_apps_bi.connectors.which_mailbox', 'Which mailbox')}
                    >
                        <option value="personal">{t('studio_apps_bi.connectors.mailbox_mine', 'Mine (the account I signed in with)')}</option>
                        <option value="shared">{t('studio_apps_bi.connectors.mailbox_shared', 'A shared mailbox')}</option>
                    </select>
                </label>
            </div>

            <p className="-mt-1 text-xs text-[var(--text-tertiary)]">
                {t('studio_apps_bi.connectors.mailbox_uses_account', 'Uses the {provider} account you signed in to Bee Flow with — there is no separate sign-in here.', { provider: isGmail ? 'Google' : connector.provider === 'outlook' ? 'Microsoft' : t('studio_apps_bi.connectors.google_or_microsoft', 'Google or Microsoft') })}
            </p>

            {shared ? (
                <>
                    <TextField
                        label={t('studio_apps_bi.connectors.shared_address', 'Shared mailbox address')}
                        value={connector.address}
                        onChange={(v) => setOpt('address', v)}
                        disabled={disabled}
                        placeholder="support@yourcompany.com"
                    />
                    <p className="-mt-1 text-xs text-[var(--text-tertiary)]">
                        {isGmail
                            ? t('studio_apps_bi.connectors.shared_gmail_note', 'Gmail cannot open someone else’s mailbox, so this must be a team address delivered to your own inbox and verified as a “send mail as” alias.')
                            : t('studio_apps_bi.connectors.shared_outlook_note', 'Your Microsoft admin must have given you access to this mailbox, and the connection needs the shared-mailbox permission (reconnect Microsoft in Settings → Integrations if it does not).')}
                    </p>
                </>
            ) : null}

            <div className="grid grid-cols-2 gap-2">
                <TextField
                    label={t('studio_apps_bi.connectors.folder_or_label', 'Folder or label')}
                    value={connector.folder}
                    onChange={(v) => setOpt('folder', v)}
                    disabled={disabled}
                    placeholder="inbox"
                />
                <TextField
                    label={t('studio_apps_bi.connectors.mail_matching', 'Only mail matching (optional)')}
                    value={connector.query}
                    onChange={(v) => setOpt('query', v)}
                    disabled={disabled}
                    placeholder="label:support"
                />
            </div>
            <p className="-mt-1 text-xs text-[var(--text-tertiary)]">
                {t('studio_apps_bi.connectors.mail_matching_hint', 'A search keeps the table to the mail you actually want. Leave it empty to take everything in the folder.')}
            </p>

            {saved ? (
                <div className="flex items-center gap-3">
                    <button
                        type="button"
                        onClick={runVerify}
                        disabled={disabled || verifying || !connector.provider}
                        className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border-default)] px-2.5 py-1.5 text-sm text-[var(--text-primary)] disabled:opacity-50"
                    >
                        {verifying ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />}
                        {t('studio_apps_bi.connectors.check_access', 'Check access')}
                    </button>
                    {verify ? (
                        <span className={`text-xs ${verify.ok ? 'text-[var(--text-secondary)]' : 'text-[var(--warning)]'}`}>
                            {verify.ok
                                ? t('studio_apps_bi.connectors.reachable', 'Reachable — {mailbox}.', { mailbox: verify.mailbox || t('studio_apps_bi.connectors.your_mailbox', 'your mailbox') })
                                : (verify.hint || verify.error || t('studio_apps_bi.connectors.mailbox_unreachable', 'Could not reach that mailbox.'))}
                        </span>
                    ) : (
                        <span className="text-xs text-[var(--text-tertiary)]">{t('studio_apps_bi.connectors.check_access_hint', 'Confirms the mailbox is reachable before you rely on it.')}</span>
                    )}
                </div>
            ) : null}
        </div>
    );
}

function ConnectorEditor({ connector, onChange, disabled, appId, tables, onCreateTable, saved, onSave, catalog }) {
    const { t } = useTranslation();
    // A patch value of `undefined` REMOVES the key rather than parking it as an
    // own property — a leftover `chain: undefined` reads as absent over the
    // wire but not to code that asks `'chain' in connector`.
    const set = (p) => {
        const next = { ...connector, ...p };
        for (const [k, v] of Object.entries(p)) if (v === undefined) delete next[k];
        onChange(next);
    };
    // Nullable text: '' clears the field (dropped from the object).
    const setOpt = (k, v) => { const next = { ...connector }; if (v === '' || v == null) delete next[k]; else next[k] = v; onChange(next); };
    // Patch several keys at once; `undefined`/'' removes a key rather than
    // storing an empty value (the model validator rejects empty optionals).
    const patch = (p) => { const next = { ...connector }; for (const [k, v] of Object.entries(p)) { if (v === '' || v == null) delete next[k]; else next[k] = v; } onChange(next); };

    const hit = connector.kind === 'integration_tool' && connector.tool ? catalog.lookup(connector.tool) : null;
    const action = hit?.action || null;
    const problem = connectorProblem(connector, action, t);

    // The row shape the chain editor binds against. /inspect fills this in when
    // the owner sets up a table; before that we fall back to the action's
    // declared output sample so bindings are still offered real field names.
    const [inspected, setInspected] = useState(null);
    const availableFields = useMemo(() => {
        if (inspected?.fields?.length) return inspected.fields;
        const sample = action?.outputSample;
        const first = Array.isArray(sample)
            ? sample.find((v) => v && typeof v === 'object')
            : (sample && typeof sample === 'object'
                ? Object.values(sample).find((v) => Array.isArray(v))?.find?.((v) => v && typeof v === 'object') || null
                : null);
        return first ? Object.keys(first).map((k) => ({ sourcePath: k, key: k })) : [];
    }, [inspected, action]);

    // Suggestions come from /inspect; until then, derive them client-side from
    // the catalog so the "gmail read needs a messageId" hint is there on first
    // sight rather than only after a run.
    const suggestions = useMemo(() => {
        if (inspected?.chainSuggestions?.length) return inspected.chainSuggestions;
        if (!action) return [];
        const required = (action.inputSchema?.required || []).filter((k) => {
            const pinned = connector.fixedArgs && Object.hasOwn(connector.fixedArgs, k);
            const asked = (connector.params || []).some((p) => p?.key === k);
            const chained = (connector.chain || []).some((s) => s?.argsFrom && Object.hasOwn(s.argsFrom, k));
            return !pinned && !asked && !chained;
        });
        if (!required.length) return [];
        const out = [];
        for (const param of required) {
            for (const sibling of catalog.siblingsOf(connector.tool)) {
                if (sibling.sideEffect) continue;
                const sample = sibling.outputSample;
                const rows = Array.isArray(sample) ? sample : Object.values(sample || {}).find((v) => Array.isArray(v));
                const first = Array.isArray(rows) ? rows.find((v) => v && typeof v === 'object') : null;
                if (!first) continue;
                const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
                const field = Object.keys(first).find((f) => norm(f) === norm(param)
                    || (norm(param).endsWith('id') && norm(f) === 'id'));
                if (!field) continue;
                out.push({
                    param,
                    tool: sibling.name,
                    label: sibling.label || sibling.name,
                    field,
                    why: t('studio_apps_bi.connectors.suggestion_why', '{action} needs {param} — {sibling} gives one as `{field}`', { action: action.label || action.name, param, sibling: sibling.label || sibling.name, field }),
                });
                break;
            }
        }
        return out;
    }, [inspected, action, catalog, connector, t]);

    return (
        <div className="flex flex-col gap-3">
            {problem ? (
                <p
                    className="flex items-start gap-1.5 rounded-md border px-2 py-1.5 text-xs"
                    style={{ borderColor: 'rgba(217, 119, 6, 0.4)', background: 'rgba(217, 119, 6, 0.1)', color: '#d97706' }}
                >
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    <span>{t('studio_apps_bi.connectors.this_connector', 'This connector {problem}.', { problem })}</span>
                </p>
            ) : null}
            <div className="grid grid-cols-2 gap-2">
                <TextField label={t('studio_apps_bi.connectors.name', 'Name')} value={connector.name} onChange={(v) => set({ name: v })} disabled={disabled} placeholder={t('studio_apps_bi.connectors.name_placeholder', 'Recent emails')} />
                <label className="flex flex-col gap-1">
                    <span className={LABEL}>{t('studio_apps_bi.connectors.gets_data_from', 'Gets data from')}</span>
                    <select
                        className={INPUT}
                        value={connector.kind}
                        // A `chain` is only legal on an app connector
                        // (dataModel.js: "chain is only supported for app
                        // connectors"), and the chain editor is only RENDERED
                        // for one — so switching the kind away left the steps
                        // behind, invisible, and the data model could never be
                        // saved again. The error named a field the screen no
                        // longer showed.
                        onChange={(e) => set(e.target.value === 'integration_tool'
                            ? { kind: e.target.value }
                            : { kind: e.target.value, chain: undefined })}
                        disabled={disabled}
                        aria-label={t('studio_apps_bi.connectors.connector_kind', 'Connector kind')}
                    >
                        {kinds(t).map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
                    </select>
                </label>
            </div>

            {connector.kind === 'integration_tool' ? (
                <>
                    <div className="flex items-center gap-2 rounded-md border px-2.5 py-2" style={{ borderColor: 'var(--border-default)' }}>
                        <div className="w-5 h-5 flex items-center justify-center shrink-0">
                            {getIntegrationIcon(connector.integrationId || '')}
                        </div>
                        <span className="min-w-0 flex-1 truncate text-sm" style={{ color: 'var(--text-primary)' }}>
                            {action?.label || connector.tool || t('studio_apps_bi.connectors.no_action', 'No action chosen yet')}
                        </span>
                        {hit?.app?.available === false ? (
                            <span className="shrink-0 text-[10px] uppercase tracking-wide" style={{ color: '#d97706' }}>{t('studio_apps_bi.connectors.not_connected', 'not connected')}</span>
                        ) : null}
                    </div>

                    <ActionParamsForm
                        action={action}
                        connector={connector}
                        onChange={patch}
                        disabled={disabled}
                        catalogUnavailable={catalog.failed}
                    />

                    <ConnectorChainEditor
                        connector={connector}
                        onChange={patch}
                        availableFields={availableFields}
                        suggestions={suggestions}
                        disabled={disabled}
                    />

                    <label className="flex flex-col gap-1">
                        <span className={LABEL}>{t('studio_apps_bi.connectors.runs_with', 'Runs with')}</span>
                        <select
                            className={INPUT}
                            value={connector.runAs === 'viewer' ? 'viewer' : 'owner'}
                            onChange={(e) => setOpt('runAs', e.target.value === 'viewer' ? 'viewer' : '')}
                            disabled={disabled}
                            aria-label={t('studio_apps_bi.connectors.connector_identity', 'Connector identity')}
                        >
                            <option value="owner">{t('studio_apps_bi.connectors.runs_owner', 'My connection — viewers never need their own')}</option>
                            <option value="viewer">{t('studio_apps_bi.connectors.runs_viewer', 'Each user\'s own connection — viewers must connect the app')}</option>
                        </select>
                    </label>
                </>
            ) : null}

            {connector.kind === 'automation' ? (
                <AutomationField connector={connector} onChangeId={(v) => setOpt('automationId', v)} disabled={disabled} />
            ) : null}

            {connector.kind === 'mailbox' ? (
                <MailboxFields connector={connector} setOpt={setOpt} disabled={disabled} appId={appId} saved={saved} />
            ) : null}

            {connector.kind === 'rest' ? (
                <>
                    <TextField label={t('studio_apps_bi.connectors.url_template', 'URL template (https)')} value={connector.url} onChange={(v) => setOpt('url', v)} disabled={disabled} placeholder="https://api.example.com/items?q={q}" />
                    <p className="-mt-1 text-xs text-[var(--text-tertiary)]">{t('studio_apps_bi.connectors.url_hint', 'Use {placeholder} placeholders for declared params. The host is fixed — it may not be templated.', { placeholder: '{param}' })}</p>
                    <Disclosure title={t('studio_apps_bi.connectors.advanced', 'Advanced settings')}>
                        <div className="flex flex-col gap-3">
                            <JsonObjectField label={t('studio_apps_bi.connectors.static_headers', 'Static headers')} value={connector.headers} onChange={(v) => setOpt('headers', v)} disabled={disabled} placeholder={'{ "X-Api-Version": "2" }'} />
                            <div className="grid grid-cols-3 gap-2">
                                <label className="flex flex-col gap-1">
                                    <span className={LABEL}>{t('studio_apps_bi.connectors.auth_type', 'Auth type')}</span>
                                    <select
                                        className={INPUT}
                                        value={connector.auth?.type || ''}
                                        onChange={(e) => setOpt('auth', e.target.value ? { ...(connector.auth || {}), type: e.target.value } : undefined)}
                                        disabled={disabled}
                                        aria-label={t('studio_apps_bi.connectors.auth_type', 'Auth type')}
                                    >
                                        <option value="">{t('studio_apps_bi.connectors.auth_none', 'None')}</option>
                                        <option value="bearer">Bearer</option>
                                        <option value="header">Header</option>
                                    </select>
                                </label>
                                <TextField
                                    label={t('studio_apps_bi.connectors.auth_header', 'Auth header')}
                                    value={connector.auth?.header}
                                    onChange={(v) => setOpt('auth', { ...(connector.auth || {}), header: v || undefined })}
                                    disabled={disabled || connector.auth?.type !== 'header'}
                                    placeholder="X-Api-Key"
                                />
                                <TextField
                                    label={t('studio_apps_bi.connectors.credential_provider', 'Credential provider')}
                                    value={connector.auth?.credentialProvider}
                                    onChange={(v) => setOpt('auth', { ...(connector.auth || {}), credentialProvider: v || undefined })}
                                    disabled={disabled || !connector.auth?.type}
                                    placeholder="example"
                                />
                            </div>
                            <div className="grid grid-cols-3 gap-2">
                                <TextField label={t('studio_apps_bi.connectors.rows_path', 'Rows path')} value={connector.rowsPath} onChange={(v) => setOpt('rowsPath', v)} disabled={disabled} placeholder="data.items" />
                                <TextField label={t('studio_apps_bi.connectors.next_page_path', 'Next-page path')} value={connector.nextPagePath} onChange={(v) => setOpt('nextPagePath', v)} disabled={disabled} placeholder="data.next_cursor" />
                                <label className="flex flex-col gap-1">
                                    <span className={LABEL}>{t('studio_apps_bi.connectors.max_rows', 'Max rows')}</span>
                                    <input
                                        type="number"
                                        className={INPUT}
                                        value={connector.maxRows ?? ''}
                                        min={1}
                                        max={500}
                                        onChange={(e) => { const n = Number(e.target.value); setOpt('maxRows', e.target.value === '' || !Number.isFinite(n) ? '' : Math.max(1, Math.min(500, Math.round(n)))); }}
                                        disabled={disabled}
                                        aria-label={t('studio_apps_bi.connectors.max_rows', 'Max rows')}
                                    />
                                </label>
                            </div>
                            <p className="text-xs text-[var(--text-tertiary)]">{t('studio_apps_bi.connectors.never_paste_keys', 'Never paste API keys here — reference a saved credential by provider id. The server attaches the owner\'s secret.')}</p>
                        </div>
                    </Disclosure>
                </>
            ) : null}

            <ConnectorSyncPanel
                connector={connector}
                tables={tables}
                appId={appId}
                onChange={patch}
                onCreateTable={(table, sync) => onCreateTable?.(connector.id, [table], sync)}
                onCreateTables={(newTables, sync) => onCreateTable?.(connector.id, newTables, sync)}
                disabled={disabled}
                saved={saved}
                onSave={onSave}
            />

            <TestPanel connector={connector} appId={appId} disabled={disabled} problem={problem} />

            {/* The raw fields. The form above writes these — this is the escape
                hatch for an action the catalog can't describe, or a parameter its
                schema doesn't declare. The REST kind keeps its own disclosure
                above (URL, auth and paging are its whole configuration). */}
            {connector.kind === 'integration_tool' ? (
                <Disclosure title={t('studio_apps_bi.connectors.advanced', 'Advanced settings')}>
                    <div className="flex flex-col gap-3">
                        <TextField label={t('studio_apps_bi.connectors.tool', 'Tool')} value={connector.tool} onChange={(v) => setOpt('tool', v)} disabled={disabled} placeholder="gmail_list_messages" />
                        <TextField label={t('studio_apps_bi.connectors.rows_path', 'Rows path')} value={connector.rowsPath} onChange={(v) => setOpt('rowsPath', v)} disabled={disabled} placeholder="results" />
                        <p className="-mt-2 text-xs text-[var(--text-tertiary)]">
                            {t('studio_apps_bi.connectors.rows_path_hint', 'Only needed when a response holds more than one list and we can’t tell which one holds the rows.')}
                        </p>
                        <JsonObjectField label={t('studio_apps_bi.connectors.pinned_args', 'Pinned arguments (fixedArgs)')} value={connector.fixedArgs} onChange={(v) => setOpt('fixedArgs', v)} disabled={disabled} placeholder={'{ "labelIds": ["INBOX"] }'} />
                        <ParamsEditor params={connector.params} onChange={(params) => set({ params })} disabled={disabled} />
                    </div>
                </Disclosure>
            ) : (
                <ParamsEditor params={connector.params} onChange={(params) => set({ params })} disabled={disabled} />
            )}
        </div>
    );
}

/**
 * Group the list by app so ticking five Gmail actions reads as "Gmail, five
 * things" rather than five unrelated rows. Automations and REST connectors have no
 * app, so they fall into their own bucket at the bottom.
 */
function groupConnectors(list, catalog, t) {
    const groups = new Map();
    for (const c of list) {
        const appId = c.kind === 'integration_tool' ? (c.integrationId || catalog.lookup(c.tool)?.app?.id || 'other') : 'other';
        const label = appId === 'other'
            ? t('studio_apps_bi.connectors.group_other', 'Automations & web addresses')
            : (catalog.lookup(c.tool)?.app?.label || c.integrationId || appId);
        if (!groups.has(appId)) groups.set(appId, { appId, label, items: [] });
        groups.get(appId).items.push(c);
    }
    return [...groups.values()].sort((a, b) => (a.appId === 'other' ? 1 : 0) - (b.appId === 'other' ? 1 : 0)
        || a.label.localeCompare(b.label));
}

export default function ConnectorsManager({
    connectors, onChange, disabled = false, appId = null, tables = [], onCreateTable, saved = true, onSave = null,
}) {
    const { t } = useTranslation();
    const list = useMemo(() => (Array.isArray(connectors) ? connectors : []), [connectors]);
    const [selectedId, setSelectedId] = useState(list[0]?.id || null);
    const [adding, setAdding] = useState(false);
    const [picking, setPicking] = useState(false);
    const selected = list.find((c) => c.id === selectedId) || null;
    const catalog = useIntegrationCatalog();
    // The app id the "Test it" call needs; the editor shell publishes it, and a
    // prop wins for callers that already hold one.
    const chrome = useEditorChrome();
    const effectiveAppId = appId || chrome?.appId || null;

    const createConnector = (kind) => {
        const c = { id: newConnectorId(), kind, name: t('studio_apps_bi.connectors.default_name', 'Connector {n}', { n: list.length + 1 }), params: [] };
        onChange([...list, c]);
        setSelectedId(c.id);
        setAdding(false);
    };
    const updateSelected = (next) => onChange(list.map((c) => (c.id === next.id ? next : c)));
    const removeConnector = (id) => {
        const next = list.filter((c) => c.id !== id);
        onChange(next);
        if (selectedId === id) setSelectedId(next[0]?.id || null);
    };

    /**
     * Apply a picker selection: one connector per newly-ticked action, and drop
     * the ones whose action was un-ticked. A removed connector that fills a table
     * would leave a dangling sync.tableId, which the model validator rejects — so
     * the sync block goes with it rather than blocking the next save.
     */
    const applyPicker = ({ add, remove }) => {
        const removeSet = new Set(remove || []);
        const kept = list.filter((c) => !removeSet.has(c.id));
        const created = (add || []).map((a) => ({
            id: newConnectorId(),
            kind: 'integration_tool',
            name: a.name,
            tool: a.tool,
            ...(a.integrationId ? { integrationId: a.integrationId } : {}),
            params: [],
        }));
        onChange([...kept, ...created]);
        if (created.length) setSelectedId(created[0].id);
        else if (removeSet.has(selectedId)) setSelectedId(kept[0]?.id || null);
        setAdding(false);
    };

    const grouped = useMemo(() => groupConnectors(list, catalog, t), [list, catalog, t]);
    // Nothing to pick from yet → skip the empty pane and ask the one question.
    const choosing = adding || list.length === 0;

    return (
        <div className="flex gap-4 min-h-[22rem]">
            {/* Connector list, grouped by app */}
            <div className="w-60 shrink-0 border-r pr-3 flex flex-col gap-1 overflow-y-auto max-h-[26rem]" style={{ borderColor: 'var(--border-default)' }}>
                {list.length === 0 ? (
                    <p className="px-1 py-2 text-xs" style={{ color: 'var(--text-tertiary)' }}>
                        {t('studio_apps_bi.connectors.none_yet', 'No connectors yet. Pick the apps and actions this app should pull data from.')}
                    </p>
                ) : grouped.map((group) => (
                    <div key={group.appId} className="flex flex-col gap-0.5">
                        <div className="flex items-center gap-1.5 px-1 pt-1.5">
                            <div className="w-3.5 h-3.5 flex items-center justify-center shrink-0">
                                {group.appId !== 'other' ? getIntegrationIcon(group.appId) : <Workflow className="h-3 w-3" style={{ color: 'var(--text-tertiary)' }} />}
                            </div>
                            <span className="truncate text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-tertiary)' }}>
                                {group.label}
                            </span>
                            <span className="ml-auto text-[10px]" style={{ color: 'var(--text-tertiary)' }}>{group.items.length}</span>
                        </div>
                        {group.items.map((c) => (
                            <div key={c.id} className="group flex items-center gap-1">
                                <button
                                    type="button"
                                    onClick={() => { setAdding(false); setSelectedId(c.id); }}
                                    className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm"
                                    style={{ background: c.id === selectedId && !adding ? 'var(--bg-tertiary)' : 'transparent', color: 'var(--text-primary)' }}
                                >
                                    <Plug className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--text-tertiary)' }} aria-hidden="true" />
                                    <span className="truncate">{c.name || c.id}</span>
                                    {connectorProblem(c, catalog.lookup(c.tool)?.action || null, t) ? (
                                        <AlertTriangle className="ml-auto h-3 w-3 shrink-0" style={{ color: '#d97706' }} aria-label={t('studio_apps_bi.connectors.not_finished', 'Not finished yet')} />
                                    ) : c.sync ? (
                                        <Database className="ml-auto h-3 w-3 shrink-0" style={{ color: 'var(--accent-primary)' }} aria-label={t('studio_apps_bi.connectors.fills_table', 'Fills a table')} />
                                    ) : (
                                        <span className="ml-auto text-[9px] uppercase tracking-wide" style={{ color: 'var(--text-tertiary)' }}>{labelForKind(c.kind, t)}</span>
                                    )}
                                </button>
                                <button
                                    type="button"
                                    aria-label={t('studio_apps_bi.connectors.delete', 'Delete {name}', { name: c.name || c.id })}
                                    onClick={() => removeConnector(c.id)}
                                    disabled={disabled}
                                    // Always visible. A destructive action hidden behind hover is
                                    // unreachable by keyboard and by touch, and it is only ever
                                    // FOUND by hovering something you were not trying to delete.
                                    // Muted until hover instead — discoverable, not shouty.
                                    className="p-1 rounded opacity-60 hover:opacity-100 focus-visible:opacity-100 hover:bg-[var(--bg-card-hover)] transition-opacity"
                                    style={{ color: 'var(--error)' }}
                                >
                                    <Trash2 className="h-3.5 w-3.5" />
                                </button>
                            </div>
                        ))}
                    </div>
                ))}
                {/* While the kind question is on screen it already offers both
                    routes, so the sidebar doesn't repeat them. */}
                {choosing ? null : (
                    <>
                        <button
                            type="button"
                            onClick={() => setPicking(true)}
                            disabled={disabled}
                            className="mt-2 inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium text-white"
                            style={{ background: 'var(--accent-primary)' }}
                        >
                            <AppWindow className="h-3.5 w-3.5" aria-hidden="true" />
                            {t('studio_apps_bi.connectors.choose_apps', 'Choose apps & actions')}
                        </button>
                        <button
                            type="button"
                            onClick={() => setAdding(true)}
                            disabled={disabled}
                            className="inline-flex items-center gap-1.5 rounded-md border border-dashed px-2 py-1.5 text-xs"
                            style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}
                        >
                            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                            {t('studio_apps_bi.connectors.automation_or_web', 'Automation or web address')}
                        </button>
                    </>
                )}
            </div>

            {/* Editor */}
            <div className="min-w-0 flex-1">
                {choosing ? (
                    <KindChooser
                        onCreate={createConnector}
                        onCancel={list.length ? () => setAdding(false) : null}
                        onPickApps={() => { setAdding(false); setPicking(true); }}
                        disabled={disabled}
                    />
                ) : selected ? (
                    <ConnectorEditor
                        key={selected.id}
                        connector={selected}
                        onChange={updateSelected}
                        disabled={disabled}
                        appId={effectiveAppId}
                        tables={tables}
                        onCreateTable={onCreateTable}
                        saved={saved}
                        onSave={onSave}
                        catalog={catalog}
                    />
                ) : (
                    <div className="flex h-full flex-col items-center justify-center gap-3 py-10 text-sm" style={{ color: 'var(--text-tertiary)' }}>
                        {t('studio_apps_bi.connectors.pick_connector', 'Pick a connector on the left, or add one to get started.')}
                        <button
                            type="button"
                            onClick={() => setPicking(true)}
                            disabled={disabled}
                            className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium hover:bg-[var(--bg-tertiary)]"
                            style={{ borderColor: 'var(--border-default)', color: 'var(--text-primary)' }}
                        >
                            <AppWindow className="h-3.5 w-3.5" style={{ color: 'var(--accent-primary)' }} aria-hidden="true" />
                            {t('studio_apps_bi.connectors.choose_apps', 'Choose apps & actions')}
                        </button>
                    </div>
                )}
            </div>

            {picking ? (
                <ConnectorPicker
                    connectors={list}
                    onApply={applyPicker}
                    onClose={() => setPicking(false)}
                />
            ) : null}
        </div>
    );
}
