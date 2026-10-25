import { useMemo, useState } from 'react';
import { AlertTriangle, HelpCircle, Loader2, Lock, Plus } from 'lucide-react';
import useTranslation from '../../hooks/useTranslation';
import { API_BASE, authFetch } from '../../utils/helpers';
import type { ConnectLinkProps, AddAppFormProps } from './WebpageAppsPanel.types';

export const GRANTS_BASE = (id: string | number | boolean) => `${API_BASE}/api/webpages/${encodeURIComponent(id)}/grants`;

export async function readJson(res: Response) {
    try { return await res.json(); } catch { return null; }
}

/** Settings → Connections deep link that lands the author back on this page. */
function connectHref(webpageId: string) {
    return `/app/settings/integrations?return=${encodeURIComponent(`/app/studio/webpages/${webpageId}`)}`;
}

export function ConnectLink({ webpageId, children }: ConnectLinkProps) {
    const { t } = useTranslation();
    return (
        <a
            href={connectHref(webpageId)}
            className="underline underline-offset-2 text-[var(--vsc-accent)]"
        >
            {children || t('webpages.apps.connect_first', 'Connect it first')}
        </a>
    );
}

export function AddAppForm({ webpageId, catalog, onGranted, onError }: AddAppFormProps) {
    const { t } = useTranslation();
    const [appId, setAppId] = useState('');
    const [tool, setTool] = useState('');
    const [label, setLabel] = useState('');
    const [fixedArgsText, setFixedArgsText] = useState('');
    const [fixedArgsError, setFixedArgsError] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);
    const [needConnect, setNeedConnect] = useState<string | null>(null); // provider id after a 409

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
            onError((e as Error).message || t('webpages.apps.err_network', 'Could not reach the server.'));
        } finally {
            setSubmitting(false);
        }
    };

    const selectCls = 'w-full px-2 py-1.5 rounded text-[12px] border outline-none';
    const selectStyle = { background: 'var(--vsc-editor-bg)', borderColor: 'var(--vsc-border)', color: 'var(--vsc-fg)' };

    return (
        <div className="flex flex-col gap-2 p-2 rounded border border-[var(--vsc-border)] bg-[var(--vsc-editor-bg)]">
            <label className="flex flex-col gap-1">
                <span className="text-[11px] text-[var(--vsc-fg-muted)]">{t('webpages.apps.field_app', 'App')}</span>
                <select
                    className={selectCls}
                    style={selectStyle}
                    value={appId}
                    aria-label={t('webpages.apps.field_app', 'App')}
                    onChange={(e) => { setAppId(e.target.value); setTool(''); setNeedConnect(null); }}
                >
                    <option value="">{t('webpages.apps.choose_app', 'Choose an app…')}</option>
                    {/*
                      * THREE states, not two. `available === null` means
                      * "the status check did not succeed" — this panel already
                      * has its own banner for that (discovery_failed), and the
                      * pill beside it says "Status unknown". Switching such an
                      * app OFF and writing "not connected" beside it tells the
                      * author that he must create a connection that may well
                      * simply exist, and meanwhile does not let him choose it.
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
                <p className="text-[11px] flex items-start gap-1.5 [color:#d97706]!">
                    <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                    <span>
                        {t('webpages.apps.app_not_connected', "{name} isn't connected to your account.", { name: app.label || app.id })}{' '}
                        <ConnectLink webpageId={webpageId}>{t('webpages.apps.connect_in_settings', 'Connect it in Settings → Connections')}</ConnectLink>{' '}
                        {t('webpages.apps.come_back', 'and come back — this list updates when you return.')}
                    </span>
                </p>
            ) : app && app.available !== true ? (
                <p className="text-[11px] flex items-start gap-1.5 text-[var(--vsc-fg-muted)]" data-testid="app-status-unknown">
                    <HelpCircle size={12} className="mt-0.5 shrink-0" />
                    <span>
                        {t('webpages.apps.app_status_unknown',
                            "Bee Flow couldn't check whether {name} is connected. Adding it is fine; it will simply fail at run time if it isn't.",
                            { name: app.label || app.id })}
                    </span>
                </p>
            ) : null}
            <label className="flex flex-col gap-1">
                <span className="text-[11px] text-[var(--vsc-fg-muted)]">{t('webpages.apps.field_what', 'What it may do')}</span>
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
                <span className="text-[11px] text-[var(--vsc-fg-muted)]">{t('webpages.apps.field_label', 'Label (optional)')}</span>
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
                <span className="text-[11px] inline-flex items-center gap-1 text-[var(--vsc-fg-muted)]">
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
                <span className="text-[10px] text-[var(--vsc-fg-muted)]">
                    {t('webpages.apps.pinned_hint', 'Pinned values always win over what the page sends — pin anything a visitor must not choose (recipient, channel, sheet id).')}
                </span>
                {fixedArgsError ? <span className="text-[10px] [color:#ef4444]!">{fixedArgsError}</span> : null}
            </label>
            {needConnect ? (
                <p className="text-[11px] [color:#d97706]!">
                    {t('webpages.apps.need_connect', "That app isn't connected (anymore).")} <ConnectLink webpageId={webpageId}>{t('webpages.apps.reconnect_it', 'Reconnect it')}</ConnectLink> {t('webpages.apps.and_try_again', 'and try again.')}
                </p>
            ) : null}
            <button
                type="button"
                onClick={submit}
                disabled={!tool || submitting}
                className="self-start inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-[12px] font-medium text-white disabled:opacity-50 bg-[var(--vsc-accent)]"
            >
                {submitting ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
                {t('webpages.apps.add_to_page', 'Add to page')}
            </button>
        </div>
    );
}
