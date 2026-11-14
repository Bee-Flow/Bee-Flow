/**
 * The pure-ish rules of starting a manual run and following runs, for
 * routes/automation/runs.js:
 *
 *   refuseUnpublished     RM-11: a run-only colleague never runs the working copy live
 *   sampleTriggerPayload  the payload a manual run of a mail or Nextcloud trigger enters with
 *   eventIsFor            whose run events the run stream passes (run-watch F8)
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type Row = Record<string, any>;

/**
 * RM-11: a manual LIVE run of an automation without a live copy (not
 * published) would execute the author's working copy, half-finished edits
 * included, as a production run. Somebody who may edit it tests it instead;
 * anybody else is told it is not published yet (409 not_published). A managed
 * automation has its own refusal (definitionForRun: managed_part_not_deployed),
 * and a kind other than 'automation' always runs its working copy.
 */
export function refuseUnpublished(stored: Row | null | undefined, access: { role?: string | null }, isTest: boolean): void {
    if (isTest || stored?.liveVersion != null) return;
    if ((stored?.kind || 'automation') !== 'automation') return;
    const { roleSatisfies } = nodeRequire('../../automation/access') as { roleSatisfies: (role: unknown, need: string) => boolean };
    if (roleSatisfies(access.role, 'edit')) return;
    const { HttpError } = nodeRequire('../../core/http/errors') as { HttpError: new (status: number, code: string, message: string) => Error };
    throw new HttpError(409, 'not_published', 'This automation has not been published yet.');
}

/** `skipped` (with the message to show) when there is nothing to test against; `payload` is then null. */
export type Sampled = { payload: unknown; skipped: boolean; message?: string };

/**
 * The trigger payload a manual run enters with. For Gmail- and Nextcloud-
 * triggered automations a manual run is meaningless without a real payload
 * (every binding resolves to undefined, gmail_compose then errors with "to is
 * required", the first NC action with "path is required"), so one is read from
 * the account's most recent matching message or activity, mirroring a real
 * fire of the trigger. `skipped` when there is nothing to test against.
 */
export async function sampleTriggerPayload(trig: Row | null | undefined, sampleUserId: string, given: unknown): Promise<Sampled> {
    if (given || trig?.kind !== 'app_event') return { payload: given, skipped: false };
    const appEvent = trig.appEvent || {};
    const triggerBus = nodeRequire('../../automation/triggerBus');
    if (appEvent.provider === 'gmail' && appEvent.event === 'mail.new') {
        const latest = await triggerBus.fetchLatestGmailMatch(sampleUserId, appEvent.filter || null);
        if (latest) return { payload: { provider: 'gmail', event: 'mail.new', ...latest }, skipped: false };
        return { payload: null, skipped: true, message: 'No matching email found in your inbox to test against. The automation is ready — it will fire when a new matching email arrives.' };
    }
    if (appEvent.provider === 'nextcloud') {
        const ev = String(appEvent.event || '').replace(/^nextcloud\./, '');
        const latest = await triggerBus.fetchLatestNextcloudMatch(sampleUserId, ev, appEvent.filter || null);
        if (latest) return { payload: { provider: 'nextcloud', event: appEvent.event, ...latest }, skipped: false };
        return { payload: null, skipped: true, message: 'No matching recent Nextcloud activity to test against. The automation is ready — it will fire when a matching event arrives.' };
    }
    return { payload: given, skipped: false };
}

/**
 * Is this run event for `me`? Events without an owner stay unscoped, as they
 * always were; otherwise the run's owner (userId) or the person who started it
 * (startedByUserId): an editor's test of a shared automation runs AS THE
 * OWNER, and its starter must still see it move.
 */
export function eventIsFor(event: { userId?: string | null; startedByUserId?: string | null }, me: string): boolean {
    if (!event.userId) return true;
    return event.userId === me || (!!event.startedByUserId && event.startedByUserId === me);
}
