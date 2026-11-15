/**
 * Immediate Gmail check after an activation (moved out of automation/goLive.js):
 * for every gmail/mail.new subscription of THIS automation, pull the most
 * recent matching email and dispatch it once to that subscription (never the
 * broad dispatchEvent, which fanned out to every gmail automation of the user
 * — A13). Fire-and-forget: the caller never waits for it and it never throws.
 *
 * `deps.dispatch` and `deps.triggerBus` are a test's doubles; the defaults
 * are loaded on first use.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

interface Sub { id: string; provider: string; eventType: string; filter?: unknown }
interface CatchUpStore { getSubscriptionsForAutomation: (automationId: string) => Promise<Sub[] | null | undefined> }
interface CatchUpDeps {
    dispatch?: { dispatchToSubscription: (sub: Sub, event: { provider: string; event: string; payload: unknown }) => unknown };
    triggerBus?: { fetchLatestGmailMatch: (ownerId: string, filter: unknown) => Promise<unknown> };
}

const log = (): { warn: (msg: string) => void } => nodeRequire('../telemetry/log') as { warn: (msg: string) => void };

export function gmailCatchUp(store: CatchUpStore, automationId: string, ownerId: string, deps: CatchUpDeps = {}): Promise<void> {
    return (async () => {
        try {
            const dispatch = deps.dispatch ?? nodeRequire('./triggerBus/dispatch');
            const triggerBus = deps.triggerBus ?? nodeRequire('./triggerBus');
            const subs = await store.getSubscriptionsForAutomation(automationId);
            const gmailSubs = (subs || []).filter((s) => s.provider === 'gmail' && s.eventType === 'mail.new');
            for (const sub of gmailSubs) {
                try {
                    // sub.filter is the normalized copy of the trigger's filter,
                    // so fetch and dispatch agree on what "matching" means.
                    const latest = await triggerBus.fetchLatestGmailMatch(ownerId, sub.filter || null);
                    if (latest) dispatch.dispatchToSubscription(sub, { provider: 'gmail', event: 'mail.new', payload: latest });
                } catch (e) {
                    log().warn(`[automation/activate] immediate Gmail dispatch failed for ${automationId} sub ${sub.id}: ${(e as Error).message}`);
                }
            }
        } catch (e) {
            log().warn(`[automation/activate] immediate Gmail catchup failed for ${automationId}: ${(e as Error).message}`);
        }
    })();
}
