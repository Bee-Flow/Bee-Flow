/**
 * The daily Cowork e-mail: once a day, in the owner's morning, one mail with what waits for them in Cowork (the
 * "Needs you" list: decisions, reviews, sign-ins, plans). Off until the owner switches it on (routes/coworkSideRoutes.js,
 * stores/coworkDailyMail.mts); nothing waits, no mail.
 *
 * Personal data leaves Bee Flow only by e-mail to the person it is about: the mail goes to the owner's own address and
 * says the titles of their own work and what each waits for, never what a run read, a review's reason or a result.
 *
 * Once per owner per local day: the day is claimed before the mail is built (stores/coworkDailyMail.mts claimDay), so
 * two servers or a restart send it once; a mail that fails is not tried again that day.
 *
 * `start()` is called from boot (boot/startupJobs.js) with the list of needs injected: that list is composed in
 * usecases/, above this layer. Requiring this module starts nothing.
 */

import { createRequire } from 'node:module';
import type { CoworkDailyMailStore, DailyMailOwner } from '../stores/coworkDailyMail.mts';

const nodeRequire = createRequire(import.meta.url);
const log = nodeRequire('../telemetry/log.js') as { info: (m: string) => void; warn: (m: string) => void };

/** One entry of the list (usecases/coworkNeedsYou.mts), as far as the mail reads it. */
export interface MailNeed { kind: string; title: string; plan: string | null }

interface MailUser { email?: string | null; preferredLocale?: string | null }

export interface DailyMailDeps {
    store: Pick<CoworkDailyMailStore, 'listEnabled' | 'claimDay'>;
    needsYou: (userId: string) => Promise<MailNeed[]>;
    getUser: (userId: string) => Promise<MailUser | null>;
    translate: (locale: string, key: string, vars?: Record<string, unknown>) => Promise<string>;
    renderTemplate: (templateId: string, locale: string, vars: Record<string, string>) => Promise<{ subject: string; html: string; text: string }>;
    sendServiceEmail: (mail: { to: string; subject: string; html: string; text: string }) => Promise<{ success?: boolean; error?: string } | undefined>;
    serviceMailConfigured: () => Promise<boolean>;
    clientHost: () => string;
}

/** The mail goes out from this hour of the owner's morning, and not after the evening one (the server was down). */
export const SEND_FROM_HOUR = 8;
export const SEND_UNTIL_HOUR = 20;
/** More entries than this are counted, not listed. */
export const LIST_CAP = 20;
const PAGE = 200;

/** The owner's local day (YYYY-MM-DD) and hour at `now`; null for a time zone this runtime does not know. */
export function localClock(now: Date, timeZone: string): { day: string; hour: number } | null {
    try {
        const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(now);
        const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
        return { day: `${part('year')}-${part('month')}-${part('day')}`, hour: Number(part('hour')) };
    } catch {
        return null;
    }
}

/** Is it this owner's morning, with today's mail not sent yet? Answers the local day to claim, or null. */
export function dueDay(owner: DailyMailOwner, now: Date): string | null {
    const clock = localClock(now, owner.timeZone);
    if (!clock || clock.hour < SEND_FROM_HOUR || clock.hour >= SEND_UNTIL_HOUR) return null;
    return owner.lastSentOn === clock.day ? null : clock.day;
}

/** The catalogue key and English of what one entry waits for (the same sentences as the web list). */
function sentenceOf(need: MailNeed): [string, string] {
    if (need.kind === 'decision') return ['cowork_needs.decision', 'A step waits for your decision.'];
    if (need.kind === 'review') return ['cowork_needs.review', 'The agent asks you to look at something.'];
    if (need.kind === 'sign_in') return ['cowork_needs.sign_in', 'An app needs you to sign in again. It paused itself.'];
    if (need.plan === 'changed') return ['cowork_needs.plan.changed', 'The plan changed and may do more than you approved. Approve it again.'];
    if (need.plan === 'blocked') return ['cowork_needs.plan.blocked', 'The plan cannot run as it is.'];
    if (need.plan === 'gone') return ['cowork_needs.plan.gone', 'The automation of its plan is gone.'];
    return ['cowork_needs.plan.first', 'Its plan waits for your approval.'];
}

/** The list of the mail, one line per entry, in the owner's language. */
export async function listOf(needs: MailNeed[], locale: string, translate: DailyMailDeps['translate']): Promise<string> {
    const say = async (key: string, en: string, vars: Record<string, unknown> = {}) => (await translate(locale, key, vars)) || en;
    const untitled = await say('cowork_needs.untitled', 'Untitled work');
    const lines: string[] = [];
    for (const need of needs.slice(0, LIST_CAP)) {
        const [key, en] = sentenceOf(need);
        lines.push(`• ${need.title || untitled}: ${await say(key, en)}`);
    }
    const more = needs.length - LIST_CAP;
    if (more > 0) lines.push(await say('cowork_needs.mail_more', `…and ${more} more.`, { count: more }));
    return lines.join('\n');
}

/** Build and send one owner's mail; answers whether it went out. */
async function mailOwner(userId: string, deps: DailyMailDeps): Promise<boolean> {
    const needs = await deps.needsYou(userId);
    if (needs.length === 0) return false;
    const user = await deps.getUser(userId);
    if (!user?.email) return false;
    const locale = user.preferredLocale || 'en';
    const vars = { count: String(needs.length), list: await listOf(needs, locale, deps.translate), cta: `${deps.clientHost()}/app/cowork` };
    const { subject, html, text } = await deps.renderTemplate('cowork_daily', locale, vars);
    const sent = await deps.sendServiceEmail({ to: user.email, subject, html, text });
    if (sent && sent.success === false) throw new Error(sent.error || 'the service mailbox refused it');
    return true;
}

/** One pass over every owner with the mail on: mail those whose morning it is. Answers how many mails went out. */
export async function sendDue(now: Date, deps: DailyMailDeps = defaults()): Promise<number> {
    if (!(await deps.serviceMailConfigured())) return 0;
    let sent = 0;
    let after: string | null = null;
    for (;;) {
        const page = await deps.store.listEnabled(PAGE, after);
        for (const owner of page) {
            const day = dueDay(owner, now);
            // Claimed first: whatever happens next, this day's mail of this owner is not built twice.
            if (!day || !(await deps.store.claimDay(owner.userId, day))) continue;
            try {
                if (await mailOwner(owner.userId, deps)) sent += 1;
            } catch (e) {
                log.warn(`[Cowork] the daily mail of ${owner.userId} was not sent: ${(e as Error).message}`);
            }
        }
        if (page.length < PAGE) return sent;
        after = page[page.length - 1].userId;
    }
}

function defaults(needsYou: DailyMailDeps['needsYou'] = async () => []): DailyMailDeps {
    const email = () => nodeRequire('../utils/emailTransport.js') as {
        sendServiceEmail: DailyMailDeps['sendServiceEmail'];
        getServiceEmailConfig: () => Promise<{ configured: boolean }>;
    };
    return {
        store: (nodeRequire('../stores/coworkDailyMail.mts') as { coworkDailyMailStore: () => CoworkDailyMailStore }).coworkDailyMailStore(),
        needsYou,
        getUser: (id) => (nodeRequire('../stores/userStore.js') as { getUser: DailyMailDeps['getUser'] }).getUser(id),
        translate: (locale, key, vars) => (nodeRequire('../i18n/translate.js') as { translate: DailyMailDeps['translate'] }).translate(locale, key, vars),
        renderTemplate: (id, locale, vars) => (nodeRequire('../utils/emailTemplates.js') as { renderEmailTemplate: DailyMailDeps['renderTemplate'] }).renderEmailTemplate(id, locale, vars),
        sendServiceEmail: (mail) => email().sendServiceEmail(mail),
        serviceMailConfigured: async () => (await email().getServiceEmailConfig()).configured,
        clientHost: () => (nodeRequire('../utils/appPaths.js') as { clientHost: () => string }).clientHost(),
    };
}

const EVERY_MS = 10 * 60_000;
let timer: ReturnType<typeof setInterval> | null = null;

/** Look every ten minutes. `needsYou` is the list of one owner (usecases/coworkNeedsYou.mts). Answers whether it started. */
export function start(needsYou: DailyMailDeps['needsYou'], deps: DailyMailDeps = defaults(needsYou)): boolean {
    if (timer) return false;
    const pass = () => { sendDue(new Date(), deps).catch((e: Error) => log.warn(`[Cowork] the daily mail pass failed: ${e.message}`)); };
    timer = setInterval(pass, EVERY_MS);
    timer.unref?.();
    log.info('[Cowork] daily mail started');
    return true;
}

/** Stop looking (shutdown, tests). */
export function stop(): void {
    if (timer) clearInterval(timer);
    timer = null;
}
