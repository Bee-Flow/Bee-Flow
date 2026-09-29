import type { TranslateFn } from '../../../../hooks/useTranslation';

/**
 * The quiet line under a suggested automation: why Bee suggests it, in plain
 * words ("seen 6× in the last 3 months · from Gmail · a few steps").
 *
 * The server computes the evidence (automation/suggestions.js scoreSuggestion)
 * from the caller's tool activity over the last 90 days; the model never
 * supplies it. `evidence.signals` carries the counts per app; older scans
 * carry only a sentence, as a string or as `evidence.summary`.
 */

interface Signal { integration?: unknown; count?: unknown }

export interface SuggestionLike {
    groundedIn?: string | null;
    evidence?: unknown;
    requiredIntegrations?: unknown;
    unavailableIntegrations?: unknown;
    complexity?: string | null;
}

const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x) : []);

function signalsOf(evidence: unknown): Signal[] | null {
    if (!evidence || typeof evidence !== 'object') return null;
    const s = (evidence as { signals?: unknown }).signals;
    return Array.isArray(s) ? s.filter((x): x is Signal => !!x && typeof x === 'object') : null;
}

/** The evidence as a sentence: a plain string, or `{ summary }`. */
export function evidenceSummary(evidence: unknown): string {
    if (typeof evidence === 'string') return evidence;
    if (evidence && typeof evidence === 'object') {
        const summary = (evidence as { summary?: unknown }).summary;
        if (typeof summary === 'string') return summary;
    }
    return '';
}

/** How often the busiest app behind it was used (0 when nothing was seen). */
export function seenCount(evidence: unknown): number {
    let top = 0;
    for (const s of signalsOf(evidence) || []) {
        const n = typeof s.count === 'number' ? s.count : 0;
        if (n > top) top = n;
    }
    return top;
}

/** The effort tier, as words rather than a coloured badge. */
export function effortLabel(tier: string | null | undefined, t: TranslateFn): string | null {
    switch (tier) {
        case 'quick': return t('routines.repeating.effortQuick', 'quick to set up');
        case 'assisted': return t('routines.repeating.effortAssisted', 'a few steps');
        case 'orchestrated': return t('routines.repeating.effortOrchestrated', 'several steps');
        case 'advanced': return t('routines.repeating.effortAdvanced', 'takes some work');
        default: return null;
    }
}

/** The apps it needs that are not connected yet, by name. */
export function missingApps(s: SuggestionLike | null | undefined, labelFor: (id: string) => string): string[] {
    return list(s?.unavailableIntegrations).map(labelFor);
}

/**
 * The parts of the evidence line, in order: how often it was seen (or the
 * server's sentence, for a scan without counts), which apps it comes from,
 * and how much work it is. Whether it was observed or is an idea is drawn
 * separately (it has its own colour), as is what still has to be connected.
 */
export function evidenceParts(s: SuggestionLike | null | undefined, t: TranslateFn, labelFor: (id: string) => string): string[] {
    const parts: string[] = [];
    const seen = seenCount(s?.evidence);
    if (seen === 1) parts.push(t('routines.repeating.seenOnce', 'seen once in the last 3 months'));
    else if (seen > 1) parts.push(t('routines.repeating.seen', 'seen {count}× in the last 3 months', { count: seen }));
    else if (!signalsOf(s?.evidence)?.length) {
        // No counts at all: an older scan, whose sentence is all there is.
        const summary = evidenceSummary(s?.evidence).trim();
        if (summary) parts.push(summary);
    }
    const missing = new Set(list(s?.unavailableIntegrations));
    const apps = list(s?.requiredIntegrations).filter(id => !missing.has(id)).map(labelFor);
    if (apps.length) parts.push(t('routines.repeating.fromApps', 'from {apps}', { apps: apps.join(', ') }));
    const effort = effortLabel(s?.complexity, t);
    if (effort) parts.push(effort);
    return parts;
}
