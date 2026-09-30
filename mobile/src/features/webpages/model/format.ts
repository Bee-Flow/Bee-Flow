/**
 * Turning share state into the words and colours the webpage screens use.
 *
 * Kept out of the components because the same judgement is made in more than
 * one place — a share is "dead" in the list row, in the action sheet, and in
 * the reach total — and a rule that lives in three renders drifts.
 */

import { translate } from '@/core/i18n';
import { type BadgeTone } from '@/shared/ui';

import type { WebpageShare } from './types';

/** A label and a badge tone. Forms and MCP use the same shape for their statuses. */
export interface StatusToken {
    label: string;
    tone: BadgeTone;
}

/**
 * A share is usable only while it is neither revoked nor past its expiry.
 *
 * Mirrors isShareLinkable in server/routes/webpageShareUrls.js, including its
 * fail-closed handling of an unparseable expiry: a date we cannot reason about
 * is treated as gone, because the viewer route will reject it anyway and an
 * optimistic "still live" here would just be a lie with a copy button.
 */
export function isShareLive(share: WebpageShare, now: number = Date.now()): boolean {
    if (share.revokedAt) return false;
    if (!share.expiresAt) return true;
    const expiry = Date.parse(share.expiresAt);
    if (Number.isNaN(expiry)) return false;
    return expiry >= now;
}

export function shareStatus(share: WebpageShare, now: number = Date.now()): StatusToken {
    if (share.revokedAt) return { label: translate('mobile.webpages.link.state_revoked', 'Revoked'), tone: 'neutral' };
    if (!isShareLive(share, now)) {
        return { label: translate('mobile.webpages.link.state_expired', 'Expired'), tone: 'warning' };
    }
    if (share.accessMode === 'password') {
        return { label: translate('mobile.webpages.link.state_password', 'Password'), tone: 'accent' };
    }
    if (share.accessMode === 'email') {
        return { label: translate('mobile.webpages.link.state_invite', 'Invite only'), tone: 'accent' };
    }
    return { label: translate('mobile.webpages.link.state_live', 'Live'), tone: 'success' };
}

export interface Reach {
    views: number;
    lastViewedAt: string | null;
    live: number;
}

/**
 * Views, and where they do NOT come from. The only view counter is on the
 * external shares (`view_count`, bumped by the /share viewer); an internal,
 * org-published page is served through the authenticated preview and is not
 * counted anywhere — so the screen labels the total "external links".
 */
export function reachOf(shares: WebpageShare[], now: number = Date.now()): Reach {
    const lastViewedAt = shares
        .map((share) => share.lastViewedAt)
        .filter((iso): iso is string => Boolean(iso))
        .sort()
        .pop();
    return {
        views: shares.reduce((sum, share) => sum + share.viewCount, 0),
        lastViewedAt: lastViewedAt ?? null,
        live: shares.filter((share) => isShareLive(share, now)).length,
    };
}
