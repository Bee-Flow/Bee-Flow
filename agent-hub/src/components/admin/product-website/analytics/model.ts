import type { TranslateFn } from '../../../../hooks/useTranslation';

/**
 * Pure folds shared by the breakdown sections.
 *
 * These live outside the components because they are where the actual thinking
 * is — turning Umami's raw dimension rows into the handful of numbers a
 * marketer can act on — and because that thinking is worth testing without a
 * DOM.
 */

/**
 * A `/report/breakdown` row, normalised.
 *
 * The requested field comes back under a key whose casing Umami does not
 * guarantee, so look it up case-insensitively rather than hoping. Getting this
 * wrong yields a table of nulls that looks like "no data".
 */
function readField(row: Record<string, unknown>, field: string): unknown {
    if (row[field] !== undefined) return row[field];
    const want = field.toLowerCase();
    for (const k of Object.keys(row)) {
        if (k.toLowerCase() === want) return row[k];
    }
    return null;
}

export interface PivotRow {
    views: number;
    visitors: number;
    visits: number;
    bounces: number;
    totaltime: number;
    bounceRate?: number | null;
    avgTime?: number | null;
    [key: string]: unknown;
}

export function pivotRow(row: Record<string, unknown>, fields: string[]): PivotRow {
    const out: PivotRow = {
        views: Number(row.views) || 0,
        visitors: Number(row.visitors) || 0,
        visits: Number(row.visits) || 0,
        bounces: Number(row.bounces) || 0,
        totaltime: Number(row.totaltime) || 0,
    };
    for (const f of fields) {
        out[f] = readField(row, f) ?? null;
    }
    out.bounceRate = out.visits > 0 ? (out.bounces / out.visits) * 100 : null;
    // Time on page is only meaningful per VISIT; dividing by views would
    // understate it on any page someone reloads.
    out.avgTime = out.visits > 0 ? out.totaltime / out.visits : null;
    return out;
}

export function pivot(rows: Record<string, unknown>[] | null | undefined, fields: string[]): PivotRow[] {
    return (Array.isArray(rows) ? rows : []).map(r => pivotRow(r, fields));
}

/**
 * Classify a referrer into a marketing channel.
 *
 * A marketing site's referrer list is mostly a long tail of one-visit domains;
 * the channel is the part anyone actually acts on. Deliberately a small, honest
 * table rather than a 500-entry copy of GA's — anything unrecognised is
 * "Referral", which is true, instead of being silently bucketed as "Other".
 */
const SEARCH = /(^|\.)(google|bing|duckduckgo|yahoo|yandex|ecosia|baidu|brave|startpage|qwant)\./i;
const SOCIAL = /(^|\.)(facebook|instagram|twitter|x|t|linkedin|reddit|youtube|pinterest|tiktok|mastodon|bsky|threads)\./i;
const EMAIL = /(^|\.)(mail|outlook|gmail|superhuman|hey)\./i;
const AI = /(^|\.)(chatgpt|openai|perplexity|claude|anthropic|copilot|gemini)\./i;

export function channelOf(referrer: unknown, utm: { utmMedium?: unknown; utmSource?: unknown; utmCampaign?: unknown } = {}): string {
    const medium = String(utm.utmMedium || '').toLowerCase();
    if (medium.includes('cpc') || medium.includes('ppc') || medium.includes('paid')) return 'Paid';
    if (medium.includes('email') || medium.includes('newsletter')) return 'Email';
    if (medium.includes('social')) return 'Social';
    if (utm.utmSource || utm.utmCampaign) return 'Campaign';

    const host = String(referrer || '').replace(/^https?:\/\//, '').split('/')[0].toLowerCase();
    if (!host) return 'Direct';
    if (SEARCH.test(host)) return 'Search';
    if (SOCIAL.test(host)) return 'Social';
    if (EMAIL.test(host)) return 'Email';
    if (AI.test(host)) return 'AI assistants';
    return 'Referral';
}

const CHANNEL_LABEL_KEYS: Record<string, string> = {
    'Direct': 'cms_site.analytics.channel.direct',
    'Search': 'cms_site.analytics.channel.search',
    'Referral': 'cms_site.analytics.channel.referral',
    'Social': 'cms_site.analytics.channel.social',
    'Email': 'cms_site.analytics.channel.email',
    'AI assistants': 'cms_site.analytics.channel.ai_assistants',
    'Campaign': 'cms_site.analytics.channel.campaign',
    'Paid': 'cms_site.analytics.channel.paid',
};

/** Channel names double as identifiers; translate only for display (pass `t`). */
export const channelLabel = (label: string, t?: TranslateFn | null): string => (t && CHANNEL_LABEL_KEYS[label] ? t(CHANNEL_LABEL_KEYS[label], label) : label);

export const CHANNEL_ORDER = ['Direct', 'Search', 'Referral', 'Social', 'Email', 'AI assistants', 'Campaign', 'Paid'];

/** `[{x: referrer, y: count}]` → channel totals, biggest first. */
export interface ChannelRow {
    label: string;
    value: number;
    share: number;
}

export function toChannels(referrerRows: { x?: unknown; y?: unknown }[] | null | undefined, { direct = 0 }: { direct?: number } = {}): ChannelRow[] {
    const totals = new Map<string, number>();
    if (direct > 0) totals.set('Direct', direct);
    for (const r of Array.isArray(referrerRows) ? referrerRows : []) {
        const ch = channelOf(r.x);
        totals.set(ch, (totals.get(ch) || 0) + (Number(r.y) || 0));
    }
    const sum = [...totals.values()].reduce((a, b) => a + b, 0) || 1;
    return [...totals.entries()]
        .map(([label, value]) => ({ label, value, share: (value / sum) * 100 }))
        .sort((a, b) => b.value - a.value
            || CHANNEL_ORDER.indexOf(a.label) - CHANNEL_ORDER.indexOf(b.label));
}

/** A referrer's display name — the host, without the protocol or trailing path. */
export function referrerHost(referrer: unknown): string | null {
    const s = String(referrer || '').trim();
    if (!s) return null;
    try {
        return new URL(s.includes('://') ? s : `https://${s}`).hostname.replace(/^www\./, '');
    } catch {
        return s.replace(/^https?:\/\//, '').split('/')[0].replace(/^www\./, '') || s;
    }
}

/**
 * Fold `/event-data` rows into one row per event occurrence, with its
 * properties flattened.
 *
 * Umami returns one row per EVENT with a nested `eventProperties` array of
 * `{dataKey, stringValue, numberValue, dateValue}`. Our auto-tracked events
 * carry `label`, `href`, `block` and `blockType`, which is what makes
 * per-block conversion attribution possible at all.
 */
/** A tracked event as Umami's /event-data returns it, before flattening. */
export interface RawEventRow {
    eventId?: string;
    eventName?: string;
    eventProperties?: { dataKey?: string; stringValue?: unknown; numberValue?: unknown; dateValue?: unknown }[];
}

/** Flattened event properties; the auto-tracked ones are read by name below. */
export interface EventProps {
    label?: string;
    href?: string;
    block?: string;
    blockType?: string;
    [key: string]: unknown;
}

export interface EventRow {
    eventId?: string;
    eventName?: string;
    props: EventProps;
}

export function foldEventData(payload: { data?: RawEventRow[] } | RawEventRow[] | null | undefined): EventRow[] {
    const rows: RawEventRow[] = Array.isArray(payload) ? payload
        : Array.isArray(payload?.data) ? payload?.data ?? [] : [];
    return rows.map(r => {
        const props: EventProps = {};
        for (const p of Array.isArray(r.eventProperties) ? r.eventProperties : []) {
            const v = p.stringValue ?? p.numberValue ?? p.dateValue;
            if (v !== undefined && v !== null && p.dataKey) props[p.dataKey] = v;
        }
        return { eventId: r.eventId, eventName: r.eventName, props };
    });
}

/**
 * Rank the things visitors actually clicked.
 *
 * Groups by the human label rather than the block id, because "Get started"
 * appearing in three blocks is one CTA with three placements — and the
 * placements are the interesting part, so they are kept as a breakdown.
 */
export function ctaLeaderboard(events: EventRow[]) {
    interface CtaAcc {
        key: string;
        eventName?: string;
        label: string;
        count: number;
        href: string | null;
        placements: Map<string, number>;
    }
    const byLabel = new Map<string, CtaAcc>();
    for (const e of events) {
        const label = e.props.label || e.props.href || '(unlabelled)';
        const key = `${e.eventName}::${label}`;
        const cur = byLabel.get(key) || {
            key, eventName: e.eventName, label, count: 0,
            href: e.props.href || null, placements: new Map(),
        };
        cur.count += 1;
        if (e.props.blockType) {
            cur.placements.set(e.props.blockType, (cur.placements.get(e.props.blockType) || 0) + 1);
        }
        if (!cur.href && e.props.href) cur.href = e.props.href;
        byLabel.set(key, cur);
    }
    return [...byLabel.values()]
        .map(r => ({
            ...r,
            placements: [...r.placements.entries()]
                .map(([type, count]) => ({ type, count }))
                .sort((a, b) => b.count - a.count),
        }))
        .sort((a, b) => b.count - a.count);
}

/** Same events, grouped by the CMS block they fired in. */
export function blockLeaderboard(events: EventRow[]) {
    const byBlock = new Map<string, { type: string; count: number; labels: Set<string> }>();
    for (const e of events) {
        const type = e.props.blockType;
        if (!type) continue;
        const cur = byBlock.get(type) || { type, count: 0, labels: new Set() };
        cur.count += 1;
        if (e.props.label) cur.labels.add(e.props.label);
        byBlock.set(type, cur);
    }
    return [...byBlock.values()]
        .map(r => ({ ...r, labels: [...r.labels] }))
        .sort((a, b) => b.count - a.count);
}

/**
 * Screen widths → the breakpoints a designer actually needs.
 *
 * `sessions[].screen` is "1280x720". Nothing in the product used it, and it is
 * the only honest answer to "what widths do I have to design for".
 */
const SCREEN_LABEL_KEYS: Record<string, string> = {
    'Phone (< 480px)': 'cms_site.analytics.screen.phone',
    'Large phone (480–768)': 'cms_site.analytics.screen.large_phone',
    'Tablet (768–1024)': 'cms_site.analytics.screen.tablet',
    'Laptop (1024–1440)': 'cms_site.analytics.screen.laptop',
    'Desktop (1440–1920)': 'cms_site.analytics.screen.desktop',
    'Wide (1920+)': 'cms_site.analytics.screen.wide',
};

/** Bucket names double as identifiers; translate only for display (pass `t`). */
export const screenLabel = (label: string, t?: TranslateFn | null): string => (t && SCREEN_LABEL_KEYS[label] ? t(SCREEN_LABEL_KEYS[label], label) : label);

const BUCKETS = [
    { max: 480, label: 'Phone (< 480px)' },
    { max: 768, label: 'Large phone (480–768)' },
    { max: 1024, label: 'Tablet (768–1024)' },
    { max: 1440, label: 'Laptop (1024–1440)' },
    { max: 1920, label: 'Desktop (1440–1920)' },
    { max: Infinity, label: 'Wide (1920+)' },
];

export function screenBuckets(sessions: { screen?: string }[] | null | undefined) {
    const counts = new Map<string, number>(BUCKETS.map(b => [b.label, 0] as const));
    let total = 0;
    for (const s of Array.isArray(sessions) ? sessions : []) {
        const w = Number(String(s.screen || '').split('x')[0]);
        if (!Number.isFinite(w) || w <= 0) continue;
        const b = BUCKETS.find(x => w <= x.max);
        if (!b) continue;
        counts.set(b.label, (counts.get(b.label) ?? 0) + 1);
        total += 1;
    }
    return {
        total,
        rows: BUCKETS.map(b => ({
            label: b.label,
            count: counts.get(b.label) ?? 0,
            share: total ? ((counts.get(b.label) ?? 0) / total) * 100 : 0,
        })).filter(r => r.count > 0),
    };
}

// Without a translator (tests, non-React callers) the reasons print English.
const plainT = (_key: string, fallback: string, params?: Record<string, string | number>): string => String(fallback).replace(/\{(\w+)\}/g, (_, k: string) => String(params?.[k] ?? ''));

/**
 * An "is this worth watching?" score for a session.
 *
 * A chronological list cannot answer that. These weights are deliberately
 * simple and are shown to the user as the reasons behind the score, so the
 * ranking is inspectable rather than a black box.
 */
export interface SessionSignalsOptions {
    events?: number;
    replay?: unknown;
    t?: typeof plainT;
}

export function sessionSignals(
    session: { views?: unknown; visits?: unknown; firstAt?: string; lastAt?: string },
    { events = 0, replay = null, t = plainT }: SessionSignalsOptions = {},
) {
    const reasons = [];
    let score = 0;

    const views = Number(session.views) || 0;
    const durationMs = Date.parse(session.lastAt ?? '') - Date.parse(session.firstAt ?? '');
    const duration = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;

    if (events > 0) { score += 40 + Math.min(20, events * 4); reasons.push(events > 1 ? t('cms_site.analytics.session.reason_interactions', '{n} interactions', { n: events }) : t('cms_site.analytics.session.reason_interaction', '{n} interaction', { n: events })); }
    if (views >= 4) { score += 20; reasons.push(t('cms_site.analytics.session.reason_pages', '{n} pages', { n: views })); }
    if (duration >= 120_000) { score += 15; reasons.push(t('cms_site.analytics.session.reason_long', 'long visit')); }
    if (views === 1 && duration < 10_000) { score -= 10; reasons.push(t('cms_site.analytics.session.reason_bounced', 'bounced')); }
    if (replay) { score += 10; reasons.push(t('cms_site.analytics.session.reason_recorded', 'recorded')); }
    if ((Number(session.visits) || 0) > 1) { score += 10; reasons.push(t('cms_site.analytics.session.reason_returning', 'returning')); }

    return { score, reasons, duration, views, events, hasReplay: !!replay };
}
