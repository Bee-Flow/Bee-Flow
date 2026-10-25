import { type CSSProperties } from 'react';
import { AlertOctagon, ZapOff, RefreshCcw, XCircle } from 'lucide-react';
import { COLORS } from './shared';
import { type TranslateParams } from '../../../hooks/useTranslation';
import type { TypeMeta } from './TerminationsPage.types';
import { request, RefusedError } from '../../../api/mutate';

export const API = (import.meta.env.VITE_API_URL || '') + '/api/terminations';

export const TYPE_META: Record<string, TypeMeta> = {
    max_tokens:     { label: 'Max tokens',     color: COLORS.amber,  icon: ZapOff },
    max_iterations: { label: 'Max iterations', color: COLORS.orange, icon: RefreshCcw },
    error:          { label: 'Error',          color: COLORS.rose,   icon: AlertOctagon },
    aborted:        { label: 'Aborted',        color: COLORS.cyan,   icon: XCircle },
};

export function typeLabel(t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string, type: string) {
    switch (type) {
        case 'max_tokens': return t('admin_monitoring.term_type_max_tokens', 'Max tokens');
        case 'max_iterations': return t('admin_monitoring.term_type_max_iterations', 'Max iterations');
        case 'error': return t('admin_monitoring.term_type_error', 'Error');
        case 'aborted': return t('admin_monitoring.term_type_aborted', 'Aborted');
        default: return type;
    }
}

export async function fetchJson(url: string) {
    try {
        let r: Response;
        try {
            r = await request(url);
        } catch (err) {
            if (!(err instanceof RefusedError)) throw err;
            return null;
        }
        return await r.json();
    } catch { return null; }
}

export function rangeQuery(range: string, customStart: string | number | Date, customEnd: string | number | Date) {
    if (range === 'all') return '';
    if (range === 'custom' && customStart && customEnd) {
        return `?startDate=${encodeURIComponent(new Date(customStart).toISOString())}&endDate=${encodeURIComponent(new Date(customEnd).toISOString())}`;
    }
    const days = range === 'today' ? 1 : range === '7d' ? 7 : range === '30d' ? 30 : 30;
    return `?days=${days}`;
}

export function fmtBytes(n: number | null | undefined) {
    if (!n || n <= 0) return '0 B';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export const filterSelectWrapper: CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px',
    borderRadius: 8, background: 'var(--bg-primary, #0f0f1a)',
    border: '1px solid var(--border-default, rgba(255,255,255,0.08))',
};

export const filterSelectStyle: CSSProperties = {
    background: 'transparent', border: 'none', outline: 'none',
    fontSize: 12, color: 'var(--text-primary, #fff)', cursor: 'pointer',
};
