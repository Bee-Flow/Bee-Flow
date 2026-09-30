/**
 * The pure half of the privacy sheet (the web's PrivacyPanel.jsx): what the
 * shield did, what it found, per attachment, and the reply with the
 * placeholders put back where the real values were.
 */

import type { PrivacyAttachment, TokenisationInfo } from './types';

export interface Words {
    i18nKey: string;
    en: string;
}

/** The action line's first words. "Nothing found" is a result too (BFSF-291). */
export function privacyActionOf(info: TokenisationInfo): Words {
    if (!((info.count ?? 0) > 0)) return { i18nKey: 'privacy.scanned_no_findings', en: 'Scanned for personal data — nothing found.' };
    if (info.action === 'block') return { i18nKey: 'privacy.action_blocked', en: 'Blocked' };
    if (info.action === 'restore') return { i18nKey: 'privacy.action_restored', en: 'Restored from vault' };
    if (info.action === 'protected') return { i18nKey: 'privacy.action_protected', en: 'Privacy active' };
    if (info.source === 'dlp') return { i18nKey: 'privacy.action_tokenised_dlp', en: 'Tokenised (DLP)' };
    return { i18nKey: 'privacy.action_tokenised', en: 'Tokenised' };
}

/** The badge beside the title: "scanned", or "3 items redacted" / restored / protected. */
export function privacyBadgeOf(info: TokenisationInfo): Words & { count: number } {
    const count = info.count ?? 0;
    if (!(count > 0)) return { i18nKey: 'privacy.badge_scanned', en: 'scanned', count: 0 };
    const verb = info.action === 'restore' ? 'restored' : info.action === 'protected' ? 'protected' : 'redacted';
    return count === 1
        ? { i18nKey: `privacy.badge_${verb}`, en: `1 item ${verb}`, count }
        : { i18nKey: `privacy.badge_${verb}_plural`, en: `{count} items ${verb}`, count };
}

/** "email ×2, phone" — each category once, with its count when it repeats. */
export function categoryList(categories: readonly string[] | undefined): string {
    const counts = new Map<string, number>();
    for (const c of categories ?? []) counts.set(c, (counts.get(c) ?? 0) + 1);
    return [...counts.entries()].map(([label, n]) => `${label}${n > 1 ? ` ×${n}` : ''}`).join(', ');
}

/** "2 emails, 1 phone" for one attachment or one of its pages. */
export function countsLine(byCategory: Record<string, number> | undefined): string {
    return Object.entries(byCategory ?? {})
        .map(([cat, n]) => `${n} ${cat.toLowerCase()}${n > 1 ? 's' : ''}`)
        .join(', ');
}

export type IncompleteReason = 'overflow' | 'timeout' | 'degraded';

/** Why part of an attachment went unchecked, or null when all of it was checked. */
export function incompleteReasonOf(att: PrivacyAttachment): IncompleteReason | null {
    const reason = att.reason || (att.timeout ? 'timeout' : att.overflow ? 'overflow' : null);
    if (!reason) return null;
    return reason === 'overflow' || reason === 'timeout' ? reason : 'degraded';
}

export const INCOMPLETE_WORDS: Readonly<Record<IncompleteReason, Words>> = {
    overflow: { i18nKey: 'dlp.attachment_overflow_truncated', en: 'too large to fully check; the rest was left out' },
    timeout: { i18nKey: 'dlp.attachment_timeout_truncated', en: 'check ran out of time; the rest was left out' },
    degraded: { i18nKey: 'dlp.attachment_degraded_truncated', en: 'checking unavailable; the rest was left out' },
};

/** Whether any attachment was only partly checked — the explainer must then say so. */
export function anyIncomplete(info: TokenisationInfo): boolean {
    return (info.attachments ?? []).some((a) => a.reason || a.timeout || a.overflow || a.truncated);
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * What the AI returned: the raw reply when the org opted in, else the shown
 * reply with each real value swapped back for its placeholder — longest
 * value first, so "Jan de Vries" is replaced before "Jan".
 */
export function aiReturnedText(info: TokenisationInfo, shown: string): string {
    if (info.rawResponse) return info.rawResponse;
    if (!info.tokenMap || !shown) return shown || '';
    const entries = Object.entries(info.tokenMap).sort((a, b) => (b[1]?.length ?? 0) - (a[1]?.length ?? 0));
    let out = shown;
    for (const [token, value] of entries) {
        if (!value) continue;
        out = out.replace(new RegExp(escapeRegExp(value), 'g'), token);
    }
    return out;
}
