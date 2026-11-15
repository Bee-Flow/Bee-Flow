/**
 * A pushed Nextcloud `mail.new` for one subscription (dispatch.js, the
 * Nextcloud fan-out): delivered only when the Mail account is the
 * subscriber's own (ncMailVisibility.mts, asked as them, whoever the actor
 * was and whatever the filter says), and never a message the subscription
 * was already handed (ncMailCursor.mts: the poller may have read it first).
 * A delivery moves the subscription's cursor and stamps lastPushAt, so the
 * poller backstop does not read the same message again. The filter itself
 * runs afterwards, in dispatch.js, like for every other event.
 *
 * A leaf: the store and the log come from dispatch.js.
 */

import { advanceMailCursor, alreadyHandedOut } from './ncMailCursor.mts';
import type { NcVisibility, VisibilityMemo } from './ncVisibility.mts';

type Payload = Record<string, unknown>;

export interface MailDeliveryArgs {
    sub: { id?: string, userId: string, lastCursor?: string | null };
    payload: Payload;
    ncVisibility: NcVisibility | null;
    memo: VisibilityMemo;
    store: {
        getSubscription: (id: string) => Promise<{ lastCursor?: string | null } | null>,
        updateSubscription: (id: string, patch: Payload) => Promise<unknown>,
    };
    log: { info: (...a: unknown[]) => void, warn: (...a: unknown[]) => void };
}

/** The subscriber's payload, or null for "do not deliver". */
export async function ncMailDeliveryFor({ sub, payload, ncVisibility, memo, store, log }: MailDeliveryArgs): Promise<Payload | null> {
    if (!ncVisibility) return null;
    if (alreadyHandedOut(sub.lastCursor, payload.mailboxId, payload.messageId)) return null;
    const decision = await ncVisibility.check(sub.userId, 'mail.new', payload, memo);
    if (!decision?.visible) {
        log.info(`[TriggerBus] sub ${sub.id} skipped nextcloud.mail.new: not a Mail account of its owner`);
        return null;
    }
    if (sub.id) {
        try {
            // Read again right before writing: a poll or another push may have moved it meanwhile.
            const fresh = await store.getSubscription(sub.id).catch(() => null);
            const lastCursor = advanceMailCursor(fresh ? fresh.lastCursor : sub.lastCursor, payload.mailboxId, payload.messageId);
            await store.updateSubscription(sub.id, { lastCursor, lastPushAt: new Date().toISOString() });
        } catch (e) {
            // The delivery still goes out; the poller may then hand the message out a second time.
            log.warn(`[TriggerBus] sub ${sub.id} mail cursor not saved: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    return { ...payload, ...(decision.overrides || {}), isOwn: false, isOwnAction: false };
}
