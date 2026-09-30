/**
 * How a version reads in the History tab — the web's WebpageHistoryTab.jsx
 * row: "v12 · summary", who made it, and the net line change.
 */

import { translate } from '@/core/i18n';

import type { VersionPage, WebpageVersion } from './buildTypes';

/** "v12 · Added a menu", or the summary alone for a row written before numbering. */
export function versionTitle(version: WebpageVersion): string {
    const summary = version.summary.trim() || translate('mobile.webpages.versions.untitled', 'Snapshot');
    return version.seq !== null ? `v${version.seq} · ${summary}` : summary;
}

/** "You", a colleague's name, or "Unknown" when the server could not say. */
export function actorLabel(version: WebpageVersion): string {
    if (version.actor?.isYou) return translate('mobile.webpages.versions.actor_you', 'You');
    if (version.actor?.name) return version.actor.name;
    return translate('mobile.webpages.versions.actor_unknown', 'Unknown');
}

/** "+12 lines" / "−3 lines" / "no line change"; null when not measured. */
export function lineDeltaLabel(version: WebpageVersion): string | null {
    const delta = version.lineDelta;
    if (delta === null) return null;
    if (delta === 0) return translate('mobile.webpages.versions.no_delta', 'no line change');
    const count = Math.abs(delta);
    return delta > 0
        ? translate('mobile.webpages.versions.lines_added', '+{count} lines', { count })
        : translate('mobile.webpages.versions.lines_removed', '−{count} lines', { count });
}

/** Which of the writers made it: the builder, a hand edit, a restore or a publish. */
export function versionSourceLabel(version: WebpageVersion): string {
    switch (version.source) {
        case 'ai':
            return translate('mobile.webpages.versions.source_ai', 'AI edit');
        case 'restore':
            return translate('mobile.webpages.versions.source_restore', 'Before a restore');
        case 'published':
            return translate('mobile.webpages.versions.source_published', 'Published');
        default:
            return translate('mobile.webpages.versions.source_manual', 'Manual edit');
    }
}

/** The pages of an infinite list, flattened, with ids deduplicated across pages. */
export function flattenVersions(pages: readonly VersionPage[] | undefined): WebpageVersion[] {
    const seen = new Set<string>();
    const out: WebpageVersion[] = [];
    for (const page of pages ?? []) {
        for (const version of page.versions) {
            if (seen.has(version.id)) continue;
            seen.add(version.id);
            out.push(version);
        }
    }
    return out;
}
