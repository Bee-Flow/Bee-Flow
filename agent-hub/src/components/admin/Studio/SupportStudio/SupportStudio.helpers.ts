import type { TranslateFn } from '@/hooks/useTranslation';
import type { SupportThread } from './index.types';

export const NOT_SUPPORT_TAG = 'not-support';

export const STATUS_IDS = ['open', 'ai_responding', 'awaiting_user', 'awaiting_agent', 'resolved', 'closed'];

export const PRIORITY_IDS = ['low', 'normal', 'high', 'urgent'];

export const STATUS_COLORS: Record<string, string> = {
    open: 'text-blue-500',
    ai_responding: 'text-amber-500',
    awaiting_user: 'text-[var(--text-tertiary)]',
    awaiting_agent: 'text-amber-600',
    resolved: 'text-green-500',
    closed: 'text-[var(--text-tertiary)]',
};

// Status tabs + a tag-based "Not support" pseudo-tab.
export const FILTER_IDS = ['awaiting_agent', 'awaiting_user', 'resolved', '', 'not_support'];

// Auto-refresh interval choices for the ticket list (persisted per browser).
export const AUTO_REFRESH_STORAGE_KEY = 'support.autoRefreshMs';

const DEFAULT_AUTO_REFRESH_MS = 30000;

export const AUTO_REFRESH_OPTIONS = [
    { ms: 0, key: 'off' },
    { ms: 15000, key: '15s' },
    { ms: 30000, key: '30s' },
    { ms: 60000, key: '1m' },
    { ms: 300000, key: '5m' },
];

export const autoRefreshLabel = (t: TranslateFn, key: string) => {
    if (key === 'off') return t('support.refresh.off', 'Off');
    return t(`support.refresh.${key}`, key);
};

export const readStoredAutoRefreshMs = () => {
    try {
        const raw = window.localStorage.getItem(AUTO_REFRESH_STORAGE_KEY);
        if (raw === null) return DEFAULT_AUTO_REFRESH_MS;
        const v = Number(raw);
        return AUTO_REFRESH_OPTIONS.some(o => o.ms === v) ? v : DEFAULT_AUTO_REFRESH_MS;
    } catch (_) { return DEFAULT_AUTO_REFRESH_MS; }
};

export const statusLabel = (t: TranslateFn, s: string) => {
    if (s === '') return t('support.filter.all', 'All');
    if (s === 'not_support') return t('support.filter.not_support', 'Not support');
    return t(`support.status.${s}`, s);
};

export const slaBreached = (th: SupportThread) => !!(th && (th.sla_first_response_breached_at || th.sla_resolution_breached_at));
