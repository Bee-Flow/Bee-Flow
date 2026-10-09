import { AlertTriangle, CheckCircle2, Link2Off, Loader2, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import useTranslation from '../../../../../../hooks/useTranslation';
import { API_BASE, authFetch } from '../../../../../../utils/helpers';
import { useDataContext } from '../DataContext';
import { useRuntime } from '../RuntimeContext';
import { ROLE_COLORS } from '../styleResolver';

/**
 * App Studio runtime — 'connector_status'. Spec: server/appStudio/componentSpecs.js.
 *
 * The app's data source, made visible to the people who use the app. Before
 * this, an empty screen meant either "no mail today" or "the mailbox has been
 * disconnected for a week" and nothing on screen distinguished them.
 *
 * Reads GET /:id/runtime/connectors/status (members, narrow projection) rather
 * than the owner-only sync-status route, and refreshes through the members'
 * endpoint, which runs the same sync the schedule runs.
 *
 * Editor preview renders a static sample: the editor has no appId to ask about,
 * and a card that says "not connected" while you are designing a screen is
 * worse than one that shows the shape it will take.
 */

function relativeTime(iso, t) {
    if (!iso) return null;
    const then = new Date(iso).getTime();
    if (!Number.isFinite(then)) return null;
    const secs = Math.round((Date.now() - then) / 1000);
    if (secs < 0) return t('studio_apps_runtime.connector.just_now', 'just now');
    if (secs < 60) return t('studio_apps_runtime.connector.just_now', 'just now');
    const mins = Math.round(secs / 60);
    if (mins < 60) return t('studio_apps_runtime.connector.min_ago', '{n} min ago', { n: mins });
    const hours = Math.round(mins / 60);
    if (hours < 24) return t('studio_apps_runtime.connector.hours_ago', '{n} h ago', { n: hours });
    return t('studio_apps_runtime.connector.days_ago', '{n} d ago', { n: Math.round(hours / 24) });
}

const PROVIDER_LABELS = { gmail: 'Gmail', outlook: 'Outlook' };

function Row({ icon, tone, title, detail }) {
    return (
        <div className="flex items-start gap-2.5 min-w-0">
            <span className="shrink-0 mt-0.5" style={{ color: tone }} aria-hidden="true">{icon}</span>
            <span className="min-w-0">
                <span className="block text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>{title}</span>
                {detail ? (
                    <span className="block text-xs mt-0.5" style={{ color: 'var(--text-tertiary)' }}>{detail}</span>
                ) : null}
            </span>
        </div>
    );
}

export default function AppConnectorStatus({ node }) {
    const { t } = useTranslation();
    const { mode } = useRuntime();
    const { appId } = useDataContext();
    const { connectorId = '', title = null, showSync = true } = node.props || {};
    const [state, setState] = useState(null);
    // "could not check" is not "no longer part of the app" — every failure used
    // to collapse into the second, which is a definite claim the card had no
    // way to make.
    const [checkFailed, setCheckFailed] = useState(false);
    const [loading, setLoading] = useState(true);
    const [syncing, setSyncing] = useState(false);
    const [note, setNote] = useState(null);

    const isRun = mode === 'run' && !!appId && !!connectorId;

    const load = useCallback(async () => {
        if (!isRun) { setLoading(false); return; }
        try {
            const res = await authFetch(`${API_BASE}/api/studio-apps/${encodeURIComponent(appId)}/runtime/connectors/status`);
            if (!res.ok) { setCheckFailed(true); setState(null); return; }
            const body = await res.json().catch(() => null);
            // Only a 200 whose list genuinely lacks the id means "removed".
            const found = (body?.connectors || []).find((c) => c.id === connectorId) || null;
            setCheckFailed(false);
            setState(found);
        } catch {
            setCheckFailed(true);
            setState(null);          // best effort: the card degrades, the app does not
        } finally {
            setLoading(false);
        }
    }, [appId, connectorId, isRun]);

    useEffect(() => { load(); }, [load]);

    const refresh = async () => {
        setSyncing(true);
        setNote(null);
        try {
            const res = await authFetch(
                `${API_BASE}/api/studio-apps/${encodeURIComponent(appId)}/runtime/connectors/${encodeURIComponent(connectorId)}/refresh`,
                { method: 'POST' },
            );
            const body = await res.json().catch(() => null);
            if (res.status === 429) setNote(t('studio_apps_runtime.connector.just_checked', 'Just checked — give it a minute.'));
            else if (res.status === 202) setNote(t('studio_apps_runtime.connector.refresh_running', 'A refresh is already running.'));
            else if (!res.ok) setNote(body?.error || t('studio_apps_runtime.connector.check_failed', 'Could not check right now.'));
            else setNote(body?.rowsWritten
                ? t('studio_apps_runtime.connector.rows_new', '{n} new', { n: body.rowsWritten })
                : t('studio_apps_runtime.connector.up_to_date', 'Up to date'));
            await load();
        } catch {
            setNote(t('studio_apps_runtime.connector.check_failed', 'Could not check right now.'));
        } finally {
            setSyncing(false);
        }
    };

    // Editor preview / no runtime: show the shape, not an error.
    const preview = !isRun;
    const data = preview
        ? { provider: 'gmail', connected: true, lastRunAt: null, hasError: false, syncable: true, status: 'idle' }
        : state;

    if (loading && !preview) {
        return (
            <div className="app-connector-card flex items-center gap-2 rounded-lg border p-3 text-sm" style={{ color: 'var(--text-tertiary)' }}>
                <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                {t('studio_apps_runtime.connector.checking', 'Checking the connection…')}
            </div>
        );
    }

    if (!data) {
        return (
            <div className="app-connector-card rounded-lg border p-3">
                <Row
                    icon={<AlertTriangle className="w-4 h-4" />}
                    tone={ROLE_COLORS.warning}
                    title={title || t('studio_apps_runtime.connector.connection', 'Connection')}
                    detail={checkFailed
                        ? t('studio_apps_runtime.connector.check_connection_failed', 'Could not check the connection right now.')
                        : t('studio_apps_runtime.connector.removed', 'This connection is no longer part of the app.')}
                />
            </div>
        );
    }

    const providerLabel = PROVIDER_LABELS[data.provider] || data.provider || t('studio_apps_runtime.connector.connection', 'Connection');
    const heading = title || `${providerLabel}${data.name ? ` · ${data.name}` : ''}`;
    const last = relativeTime(data.lastRunAt, t);

    const connected = data.connected !== false;
    const icon = !connected
        ? <Link2Off className="w-4 h-4" />
        : data.hasError
            ? <AlertTriangle className="w-4 h-4" />
            : <CheckCircle2 className="w-4 h-4" />;
    const tone = !connected
        ? ROLE_COLORS.danger
        : data.hasError
            ? ROLE_COLORS.warning
            : ROLE_COLORS.success;

    const detail = !connected
        ? t('studio_apps_runtime.connector.not_connected', 'Not connected. Connect {provider} under Settings → Integrations and this fills up by itself.', { provider: providerLabel })
        : [
            data.address
                ? t('studio_apps_runtime.connector.reading_address', 'Reading {address}', { address: data.address })
                : t('studio_apps_runtime.connector.reading_account', 'Reading the {provider} account you signed in with', { provider: providerLabel }),
            last
                ? t('studio_apps_runtime.connector.checked', 'checked {when}', { when: last })
                : t('studio_apps_runtime.connector.not_checked', 'not checked yet'),
            data.hasError ? t('studio_apps_runtime.connector.last_problem', 'last check reported a problem') : null,
        ].filter(Boolean).join(' · ');

    return (
        <div
            className="app-connector-card flex items-center justify-between gap-3 rounded-lg border p-3"
            data-app-connector-status={connectorId}
            data-connected={connected || undefined}
        >
            <Row icon={icon} tone={tone} title={heading} detail={detail} />
            {showSync && data.syncable && !preview ? (
                <div className="flex items-center gap-2 shrink-0">
                    {note ? <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{note}</span> : null}
                    <button
                        type="button"
                        onClick={refresh}
                        disabled={syncing}
                        className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-sm disabled:opacity-60"
                        style={{ borderColor: 'var(--border-default)', color: 'var(--text-primary)' }}
                    >
                        <RefreshCw className={`w-3.5 h-3.5${syncing ? ' animate-spin' : ''}`} aria-hidden="true" />
                        {t('studio_apps_runtime.connector.check_now', 'Check now')}
                    </button>
                </div>
            ) : null}
        </div>
    );
}
