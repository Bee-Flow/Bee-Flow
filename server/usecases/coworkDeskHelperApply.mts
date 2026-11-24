/**
 * Setting up what the Teamwork helper proposed (./coworkDeskHelper.mts, decision record 0049), as the caller, through
 * the desk's own use cases in order: make the desk (./coworkDesks.mts createDesk), put each cowork on it or invite it
 * (addToDesk), set the question role (setDeskRoles, setItemRole), then the hand-offs (./coworkStart.mts chooseStart).
 * The draft is never trusted: every cowork and person is checked again against what the caller may use now, and each
 * use case applies its own rules on top.
 *
 * What only someone else can do stays theirs, and the answer says who it waits for:
 *   - a colleague's cowork is invited and joins only when its owner accepts; they are told what is asked of them;
 *   - that colleague chooses to start their cowork after the one before it (their start is theirs to set). When the
 *     cowork before it is the caller's, the caller's yes to that hand-off is given now, since they asked for it
 *     (allowHandOffAhead); otherwise its owner is asked to allow it, as on the desk;
 *   - the three hand-offs between people in a row (core/cowork/afterCowork.mts) are refused before anything is made.
 *
 * The use cases each write on their own, so there is no one transaction around them: everything is checked before the
 * first change, a new desk is removed again when putting the coworks on it fails, and a hand-off that is refused is
 * reported with its reason while the rest stays.
 */

import { createRequire } from 'node:module';
import type { DeskDeps, DeskView } from './coworkDesks.mts';
import type { StartDeps } from './coworkStart.mts';
import { callerOf, candidatesFor, helperDeps, targetDeskOf, type HelperDeps } from './coworkDeskHelper.mts';
import { crossingsOf, MAX_CROSSINGS, MAX_HELPER_ROLES, MAX_STEPS, type CoworkChoice } from './coworkDeskHelperModel.mts';

const nodeRequire = createRequire(import.meta.url);
const { HttpError } = nodeRequire('../core/http/errors.js') as { HttpError: new (status: number, code: string, message: string) => Error };
const { fallback } = nodeRequire('../utils/bestEffort.js') as { fallback: <T>(label: string, err: unknown, value: T) => T };

type Desks = typeof import('./coworkDesks.mts');
type Starts = typeof import('./coworkStart.mts');

export interface ApplyDeps {
    helper: Pick<HelperDeps, 'getUser' | 'getSchedule' | 'listMembers' | 'myCoworks' | 'sharedWithMe' | 'membershipOf'>;
    desks: () => Desks;
    starts: () => Starts;
    /** The desk and start use cases' own wiring; undefined: their defaults. */
    deskDeps?: DeskDeps;
    startDeps?: StartDeps;
    notify: (n: { userId: string; category: string; title: string; message: string; link: string }) => Promise<unknown>;
}

export const applyDeps = (): ApplyDeps => ({
    helper: helperDeps(),
    desks: () => nodeRequire('./coworkDesks.mts') as Desks,
    starts: () => nodeRequire('./coworkStart.mts') as Starts,
    notify: (n) => (nodeRequire('../stores/notificationStore.js') as { createNotification: ApplyDeps['notify'] }).createNotification(n),
});

export interface DeskDraft { deskName: string; chain: string[]; roles: Array<{ role: string; holderId: string; standInId?: string | null }> }

/** One thing done or waiting, in words the page turns into a sentence. `who` is a colleague's display name. */
export interface ApplyNote {
    kind: 'desk_made' | 'added' | 'starts_after' | 'role_set' | 'invited' | 'their_start' | 'allow' | 'start_later' | 'needs_runner' | 'not_done';
    title?: string; afterTitle?: string; who?: string; role?: string; holderName?: string; standInName?: string | null; reason?: string;
    /** their_start: the caller already allowed the hand-off from their own cowork. */
    allowedByYou?: boolean;
}
export interface ApplyResult { deskId: string; done: ApplyNote[]; waiting: ApplyNote[] }

const refuse = (status: number, message: string) => new HttpError(status, 'cowork_desk_helper_refused', message);

/** The draft's coworks and people, held to what the caller may use now; throws before anything is made. */
function checkedDraft(draft: DeskDraft, cands: { coworks: CoworkChoice[]; people: Array<{ id: string; name: string }> }) {
    const byId = new Map(cands.coworks.map((c) => [c.scheduleId, c]));
    const chain = draft.chain.map((id) => byId.get(id));
    if (chain.length === 0 || chain.length > MAX_STEPS) throw refuse(400, `A desk set up here has 1 to ${MAX_STEPS} coworks.`);
    if (chain.some((c) => !c)) throw refuse(404, 'That cowork is not one you can put on a desk.');
    if (new Set(draft.chain).size !== draft.chain.length) throw refuse(400, 'Each cowork comes once.');
    const steps = chain as CoworkChoice[];
    if (crossingsOf(steps.map((c) => c.ownerId)) > MAX_CROSSINGS) throw refuse(409, `At most ${MAX_CROSSINGS} hand-offs in a row go from one person to another.`);
    const people = new Map(cands.people.map((p) => [p.id, p.name]));
    if (draft.roles.length > MAX_HELPER_ROLES) throw refuse(400, 'The helper sets up one role; add more under All settings.');
    for (const r of draft.roles) {
        if (!people.has(r.holderId) || (r.standInId && !people.has(r.standInId))) throw refuse(404, 'That colleague is not in your organisation.');
    }
    return { steps, nameOf: (id: string | null | undefined) => (id ? people.get(id) ?? null : null) };
}

interface Run { userId: string; myName: string; view: DeskView; deps: ApplyDeps; done: ApplyNote[]; waiting: ApplyNote[] }

/** Tell a colleague what the caller asks of their cowork; a notice that does not go out changes nothing. */
async function askColleague(run: Run, step: CoworkChoice, after: CoworkChoice | null): Promise<void> {
    const asks = after ? ` and to start it after "${after.title}"` : '';
    await run.deps.notify({
        userId: step.ownerId, category: 'cowork', title: 'A colleague asks for your cowork on a desk',
        message: `${run.myName} asks to put your "${step.title}" on the desk "${run.view.desk.name}"${asks}. Open it to accept or decline; it keeps running as you.`,
        link: `/app/cowork/${step.scheduleId}`,
    }).catch((e: unknown) => fallback('usecases/coworkDeskHelperApply:askColleague', e, null));
}

/** Put each cowork on the desk, in order: the caller's at once, a colleague's as an invitation. */
async function putOn(run: Run, steps: CoworkChoice[]): Promise<void> {
    const on = new Set(run.view.members.map((m) => m.scheduleId));
    for (const [i, step] of steps.entries()) {
        if (on.has(step.scheduleId)) continue;
        run.view = await run.deps.desks().addToDesk({ userId: run.userId, deskId: run.view.desk.id, scheduleId: step.scheduleId }, run.deps.deskDeps);
        if (step.mine) {
            run.done.push({ kind: 'added', title: step.title });
            continue;
        }
        await askColleague(run, step, steps[i - 1] ?? null);
        // The first cowork starts after nothing of this chain: its owner only accepts it.
        if (i === 0) run.waiting.push({ kind: 'invited', title: step.title, who: step.ownerName });
    }
}

/** The question role: kept with the desk's other roles, and chosen by each of the caller's own coworks on it. */
async function setRole(run: Run, draft: DeskDraft, steps: CoworkChoice[], nameOf: (id: string | null | undefined) => string | null): Promise<void> {
    const [role] = draft.roles;
    if (!role) return;
    const name = role.role.trim();
    const kept = run.view.roles.filter((r) => r.role !== name && r.holderId).map((r) => ({ role: r.role, holderId: r.holderId as string, standInId: r.standInId, awayUntil: r.awayUntil }));
    const d = run.deps.desks();
    run.view = await d.setDeskRoles({ userId: run.userId, deskId: run.view.desk.id, roles: [...kept, { role: name, holderId: role.holderId, standInId: role.standInId || null }] }, run.deps.deskDeps);
    for (const step of steps.filter((s) => s.mine)) {
        run.view = await d.setItemRole({ userId: run.userId, deskId: run.view.desk.id, scheduleId: step.scheduleId, deskRole: name }, run.deps.deskDeps);
    }
    run.done.push({ kind: 'role_set', role: name, holderName: nameOf(role.holderId) ?? undefined, standInName: nameOf(role.standInId) });
}

/** The caller's own cowork starts after the one before it. */
async function myStart(run: Run, leader: CoworkChoice, follower: CoworkChoice): Promise<void> {
    const leaderOn = run.view.members.find((m) => m.scheduleId === leader.scheduleId);
    if (!leaderOn?.accepted) return void run.waiting.push({ kind: 'start_later', title: follower.title, afterTitle: leader.title, who: leader.ownerName });
    if (!follower.hasRunner) return void run.waiting.push({ kind: 'needs_runner', title: follower.title });
    const item = await run.deps.helper.getSchedule(follower.scheduleId);
    if (!item) return;
    await run.deps.starts().chooseStart({ item, choice: { kind: 'after_cowork', scheduleId: leader.scheduleId } }, run.deps.startDeps);
    run.done.push({ kind: 'starts_after', title: follower.title, afterTitle: leader.title });
    if (!leader.mine) run.waiting.push({ kind: 'allow', title: follower.title, afterTitle: leader.title, who: leader.ownerName });
}

/** A colleague's cowork that should start after the one before it: their choice; the caller's yes is given ahead. */
async function theirStart(run: Run, leader: CoworkChoice, follower: CoworkChoice): Promise<void> {
    if (leader.mine) {
        await run.deps.desks().allowHandOffAhead({ userId: run.userId, deskId: run.view.desk.id, leaderId: leader.scheduleId, followerId: follower.scheduleId }, run.deps.deskDeps);
    }
    run.waiting.push({ kind: 'their_start', title: follower.title, afterTitle: leader.title, who: follower.ownerName, allowedByYou: leader.mine });
}

/** Each hand-off of the chain; one that is refused is reported with its reason, the others go on. */
async function handOffs(run: Run, steps: CoworkChoice[]): Promise<void> {
    for (let i = 1; i < steps.length; i += 1) {
        const [leader, follower] = [steps[i - 1], steps[i]];
        // Already so on this desk: choosing it again would take a plan's approval away for nothing.
        if (run.view.members.some((m) => m.scheduleId === follower.scheduleId && m.after === leader.scheduleId)) continue;
        try {
            await (follower.mine ? myStart(run, leader, follower) : theirStart(run, leader, follower));
        } catch (e) {
            if (!(e instanceof HttpError)) throw e;
            run.waiting.push({ kind: 'not_done', title: follower.title, afterTitle: leader.title, reason: (e as Error).message });
        }
    }
}

/** Set up the helper's proposal, as the caller. */
export async function applyDeskDraft({ userId, itemId = null, draft }: { userId: string; itemId?: string | null; draft: DeskDraft }, deps: ApplyDeps = applyDeps()): Promise<ApplyResult> {
    const me = await callerOf(userId, deps.helper);
    const { deskId } = await targetDeskOf(userId, itemId, deps.helper);
    const cands = await candidatesFor(userId, me.organizationId, deskId, deps.helper);
    const { steps, nameOf } = checkedDraft(draft, cands);
    const d = deps.desks();
    const view = deskId ? await d.deskView(userId, deskId, deps.deskDeps) : await d.createDesk({ userId, name: draft.deskName }, deps.deskDeps);
    const run: Run = { userId, myName: nameOf(userId) ?? 'A colleague', view, deps, done: deskId ? [] : [{ kind: 'desk_made', title: view.desk.name }], waiting: [] };
    try {
        await putOn(run, steps);
        await setRole(run, draft, steps, nameOf);
    } catch (e) {
        // A new desk that could not be filled is taken away again, so nothing half-made is left behind.
        if (!deskId) await d.deleteDesk({ userId, deskId: view.desk.id }, deps.deskDeps).catch((err: unknown) => fallback('usecases/coworkDeskHelperApply:undo', err, null));
        throw e;
    }
    await handOffs(run, steps);
    return { deskId: run.view.desk.id, done: run.done, waiting: run.waiting };
}
