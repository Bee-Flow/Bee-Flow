import type { TranslateFn } from '@/hooks/useTranslation';
import { QUERY_LOG_RETENTION_DAYS } from '@/api/queries/kbQueryLog';

/** AI Act Art. 26(6): a deployer of a high-risk system keeps its logs at least six months. */
export function retentionChoices(highRisk: boolean): readonly number[] {
    return highRisk ? QUERY_LOG_RETENTION_DAYS.filter((d) => d >= 180) : QUERY_LOG_RETENTION_DAYS;
}

export function dpiaLabel(t: TranslateFn, id: string): string {
    return id === 'done'
        ? t('knowledge.query_log.dpia_done', 'A DPIA has been done')
        : t('knowledge.query_log.dpia_not_required', 'A DPIA is not required');
}


/** Words for the vocabulary the server sends as ids. An id this client does not know is shown as it is. */
export function channelLabel(t: TranslateFn, id: string): string {
    return t(`knowledge.query_log.channel.${id}`, id);
}
export function outcomeLabel(t: TranslateFn, id: string): string {
    return t(`knowledge.query_log.outcome.${id}`, id);
}
export function statusLabel(t: TranslateFn, id: string): string {
    return t(`knowledge.query_log.status.${id}`, id);
}

/** The shortest question that still says what it was about. */
export function excerpt(text: string | null | undefined, max = 90): string {
    const flat = (text ?? '').replace(/\s+/g, ' ').trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The period options and how far back each reaches (days; 0 = no limit). */
export const PERIODS = [
    { id: 'all', days: 0 },
    { id: '1', days: 1 },
    { id: '7', days: 7 },
    { id: '30', days: 30 },
    { id: '90', days: 90 },
] as const;

export function periodFrom(days: number, now = Date.now()): string {
    return days > 0 ? new Date(now - days * 86_400_000).toISOString() : '';
}

/** A citation as the answer stored it: a string, or an object with some of title / source. */
export function citationText(c: unknown): string {
    if (typeof c === 'string') return c;
    if (c && typeof c === 'object') {
        const r = c as Record<string, unknown>;
        const parts = [r.title, r.sourceUri ?? r.source ?? r.source_uri].filter((v): v is string => typeof v === 'string' && !!v);
        if (parts.length) return parts.join(' · ');
    }
    return JSON.stringify(c);
}
