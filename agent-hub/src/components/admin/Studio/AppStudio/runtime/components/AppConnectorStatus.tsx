import { AlertTriangle, CheckCircle2, Link2Off, Loader2, RefreshCw } from 'lucide-react';
import { useState, type JSX } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import useTranslation from '@/hooks/useTranslation';
import type { TranslateParams } from '@/hooks/useTranslation';
import { useDataContext } from '../DataContext';
import { useRuntime } from '../RuntimeContext';
import { ROLE_COLORS } from '../styleResolver.constants';
import { RefusedError, errorBody } from '@/api/mutate';
import { apiRequest } from '@/api/typedRequest';
import { useOptionalQueryClient } from '@/api/queries/optionalQueryClient';

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

function relativeTime(iso: string | number | Date | null, t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string) {
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

const PROVIDER_LABELS: Record<string, string> = { gmail: 'Gmail', outlook: 'Outlook' };

interface RowProps {
    icon: JSX.Element;
    tone: string;
    title: string;
    detail: string;
}

function Row({ icon, tone, title, detail }: RowProps) {
    return (
        <div className="flex items-start gap-2.5 min-w-0">
            <span className="shrink-0 mt-0.5 bfa-connector_status__icon" style={{ color: tone }} aria-hidden="true">{icon}</span>
            <span className="min-w-0">
                <span className="block text-sm font-medium truncate text-[var(--text-primary)] bfa-connector_status__title">{title}</span>
                {detail ? (
                    <span className="block text-xs mt-0.5 text-[var(--text-tertiary)] bfa-connector_status__detail">{detail}</span>
                ) : null}
            </span>
        </div>
    );
}

interface ConnectorState {
    id?: string;
    provider: string;
    integrationId?: string | null;
    connected: boolean;
    lastRunAt: string | number | Date | null;
    hasError: boolean;
    syncable: boolean;
    status: string;
    name?: string;
    address?: string;
}

interface AppConnectorStatusProps {
    node: { id: string; type: string; visible?: boolean; props: { connectorId: string; title: string | null; showSync: boolean }; style: { span?: number } };
}

/** The app's connector states; null when the check could not be made (a refusal or a failure). Never rejects. */
function readConnectorStatus(appId: string) {
    return async (): Promise<ConnectorState[] | null> => {
        try {
            const res = await apiRequest('GET /api/studio-apps/{id}/runtime/connectors/status', { params: { id: appId } });
            const body = await res.json().catch(() => null);
            return body?.connectors || [];
        } catch {
            return null;          // best effort: the card degrades, the app does not
        }
    };
}

export default function AppConnectorStatus({ node }: AppConnectorStatusProps) {
    const { t } = useTranslation();
    const { mode } = useRuntime();
    const { appId } = useDataContext();
    const { connectorId = '', title = null, showSync = true } = node.props || {};
    const [note, setNote] = useState<string | null>(null);

    const isRun = mode === 'run' && !!appId && !!connectorId;

    // One read per app, shared by every connector card on the screen.
    const { client, attached } = useOptionalQueryClient();
    const statusQuery = useQuery<ConnectorState[] | null>({
        queryKey: ['studioApps', 'runtimeConnectorStatus', appId],
        enabled: isRun && attached,
        staleTime: 0,
        retry: false,
        queryFn: readConnectorStatus(appId as string),
    }, client);
    // "could not check" (null) is not "no longer part of the app" — every failure
    // collapsing into the second would be a definite claim the card has no way to make.
    const checkFailed = statusQuery.data === null;
    // Only a 200 whose list genuinely lacks the id means "removed".
    const state = statusQuery.data?.find((c) => c.id === connectorId) || null;
    const loading = isRun && statusQuery.data === undefined;
    const { refetch } = statusQuery;

    const refreshMutation = useMutation({
        mutationFn: async () => {
            let status: number;
            let ok: boolean;
            let body: { error?: string; rowsWritten?: number } | null;
            try {
                const res = await apiRequest('POST /api/studio-apps/{id}/runtime/connectors/{connectorId}/refresh', { params: { id: appId as string, connectorId } });
                status = res.status; ok = true;
                body = await res.json().catch(() => null);
            } catch (err) {
                if (!(err instanceof RefusedError)) throw err;
                status = err.status; ok = false;
                body = errorBody(err) as typeof body;
            }
            if (status === 429) return t('studio_apps_runtime.connector.just_checked', 'Just checked — give it a minute.');
            if (status === 202) return t('studio_apps_runtime.connector.refresh_running', 'A refresh is already running.');
            if (!ok) return body?.error || t('studio_apps_runtime.connector.check_failed', 'Could not check right now.');
            return body?.rowsWritten
                ? t('studio_apps_runtime.connector.rows_new', '{n} new', { n: body.rowsWritten })
                : t('studio_apps_runtime.connector.up_to_date', 'Up to date');
        },
        onMutate: () => setNote(null),
        onSuccess: async (text) => {
            setNote(text);
            await refetch();
        },
        onError: () => setNote(t('studio_apps_runtime.connector.check_failed', 'Could not check right now.')),
    }, client);
    const syncing = refreshMutation.isPending;
    const refresh = () => refreshMutation.mutate();

    // Editor preview / no runtime: show the shape, not an error.
    const preview = !isRun;
    const data = preview
        ? { provider: '', connected: true, lastRunAt: null, hasError: false, syncable: true, status: 'idle' }
        : state;

    if (loading && !preview) {
        return (
            <div className="app-connector-card flex items-center gap-2 rounded-lg border p-3 text-sm text-[var(--text-tertiary)] bfa-connector_status__root">
                <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                {t('studio_apps_runtime.connector.checking', 'Checking the connection…')}
            </div>
        );
    }

    if (!data) {
        return (
            <div className="app-connector-card rounded-lg border p-3 bfa-connector_status__root">
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

    const providerKey = data.provider || data.integrationId || '';
    const providerLabel = PROVIDER_LABELS[providerKey] || providerKey || t('studio_apps_runtime.connector.connection', 'Connection');
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

    const detail = preview
        ? t('studio_apps_runtime.connector.sample', 'Preview: the real account and the last check show here once the app runs.')
        : !connected
        ? t('studio_apps_runtime.connector.not_connected', 'Not connected. Connect {provider} under Settings → Connections and this fills up by itself.', { provider: providerLabel })
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
            className="app-connector-card flex items-center justify-between gap-3 rounded-lg border p-3 bfa-connector_status__root"
            data-app-connector-status={connectorId}
            data-connected={connected || undefined}
        >
            <Row icon={icon} tone={tone} title={heading} detail={detail} />
            {showSync && data.syncable && !preview ? (
                <div className="flex items-center gap-2 shrink-0">
                    {note ? <span className="text-xs text-[var(--text-tertiary)] bfa-connector_status__note">{note}</span> : null}
                    <button
                        type="button"
                        onClick={refresh}
                        disabled={syncing}
                        className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-sm disabled:opacity-60 [border-color:var(--border-default)] [color:var(--text-primary)]! bfa-connector_status__action"
                    >
                        <RefreshCw className={`w-3.5 h-3.5${syncing ? ' animate-spin' : ''}`} aria-hidden="true" />
                        {t('studio_apps_runtime.connector.check_now', 'Check now')}
                    </button>
                </div>
            ) : null}
        </div>
    );
}
