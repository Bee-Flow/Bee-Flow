/**
 * The Teamwork helper's proposal as the person changes it (./CoworkTeamworkHelper.tsx): what each dropdown holds,
 * whether it can be set up yet, the body that sets it up, and the plain sentences of what was done and what waits for
 * whom. Pure, no React.
 */
import type { TranslateFn } from '@/hooks/useTranslation';
import type { DeskDraftBody, DeskProposal, HelperCowork, HelperNote } from '@/api/coworkDeskHelper';

/** A chain is at most five coworks long, and at most three hand-offs in a row go from one person to another. */
export const MAX_STEPS = 5;
const MAX_CROSSINGS = 3;

/** One step: the cowork chosen ('' while none is), and the person's words when the helper found none for them. */
export interface EditStep { scheduleId: string; words: string }
export interface EditRole { role: string; holderId: string; standInId: string; holderWords: string }
export interface EditDraft { deskName: string; steps: EditStep[]; role: EditRole | null }

export function editableOf(p: DeskProposal): EditDraft {
    const [role] = p.roles;
    return {
        deskName: p.deskName,
        steps: p.chain.map((s) => ({ scheduleId: s.scheduleId ?? '', words: s.scheduleId ? '' : s.words })),
        role: role ? { role: role.role, holderId: role.holderId ?? '', standInId: role.standInId ?? '', holderWords: role.holderId ? '' : role.holderWords } : null,
    };
}

/** The cowork a step has chosen, from the helper's choices. */
const coworkOf = (id: string, coworks: HelperCowork[]): HelperCowork | undefined => coworks.find((c) => c.scheduleId === id);

/** How many hand-offs in a row go from one person to another. */
function crossingsOf(steps: EditStep[], coworks: HelperCowork[]): number {
    const owners = steps.map((s) => coworkOf(s.scheduleId, coworks)?.ownerName ?? '');
    return owners.slice(1).filter((o, i) => o !== owners[i]).length;
}

export type NotReady = 'no_steps' | 'unchosen' | 'twice' | 'crossings' | 'holder' | 'name';

/** Why it cannot be set up as it is, or null when it can. */
export function notReady(d: EditDraft, coworks: HelperCowork[], newDesk: boolean): NotReady | null {
    const ids = d.steps.map((s) => s.scheduleId);
    if (ids.length === 0) return 'no_steps';
    if (ids.some((id) => !coworkOf(id, coworks))) return 'unchosen';
    if (new Set(ids).size !== ids.length) return 'twice';
    if (crossingsOf(d.steps, coworks) > MAX_CROSSINGS) return 'crossings';
    if (d.role && (!d.role.holderId || !d.role.role.trim())) return 'holder';
    if (newDesk && !d.deskName.trim()) return 'name';
    return null;
}

export function bodyOf(d: EditDraft): DeskDraftBody {
    const role = d.role;
    return {
        deskName: d.deskName.trim().slice(0, 80),
        chain: d.steps.map((s) => s.scheduleId),
        roles: role ? [{ role: role.role.trim().slice(0, 40), holderId: role.holderId, standInId: role.standInId && role.standInId !== role.holderId ? role.standInId : null }] : [],
    };
}

/** The name of whoever must agree before this step joins: the owner of a colleague's cowork. */
export const agreesFirst = (step: EditStep, coworks: HelperCowork[]): string | null => {
    const c = coworkOf(step.scheduleId, coworks);
    return c && !c.mine ? c.ownerName : null;
};

/** The sentence of each kind of note, as [key, English]; the second form of role_set and their_start is chosen below. */
const NOTE_TEXT: Record<string, [string, string]> = {
    desk_made: ['cowork_teamwork.note.desk_made', 'The desk "{title}" is made.'],
    added: ['cowork_teamwork.note.added', '"{title}" is on it.'],
    starts_after: ['cowork_teamwork.note.starts_after', '"{title}" starts after "{after}".'],
    role_set: ['cowork_teamwork.note.role_set', 'Questions go to {role}: {holder}.'],
    role_set_stand_in: ['cowork_teamwork.note.role_set_stand_in', 'Questions go to {role}: {holder}. When {holder} is away: {standIn}.'],
    invited: ['cowork_teamwork.note.invited', '{who} has been asked to agree. "{title}" joins once they do.'],
    their_start: ['cowork_teamwork.note.their_start', '{who} has been asked to agree. It starts once they accept "{title}" and start it after "{after}".'],
    their_start_ask: ['cowork_teamwork.note.their_start_ask', '{who} has been asked to agree. It starts once they accept "{title}" and start it after "{after}", and the owner of "{after}" allows it.'],
    their_start_planned: ['cowork_teamwork.note.their_start_planned', '{who} has been asked to agree. Accepting puts "{title}" on the desk and starts it after "{after}".'],
    their_start_planned_ask: ['cowork_teamwork.note.their_start_planned_ask', '{who} has been asked to agree. Accepting puts "{title}" on the desk and starts it after "{after}"; it gets that result once the owner of "{after}" allows it.'],
    allow: ['cowork_teamwork.note.allow', '{who} is asked to allow that "{title}" gets the result of "{after}". Until then it receives nothing.'],
    start_later: ['cowork_teamwork.note.start_later', 'Once {who} accepts "{after}", open the helper again to start "{title}" after it.'],
    needs_runner: ['cowork_teamwork.note.needs_runner', '"{title}" keeps its own start: give it an agent or a plan first, then it can start after another cowork.'],
    not_done: ['cowork_teamwork.note.not_done', '"{title}" could not start after "{after}": {reason}'],
};

const variantOf = (n: HelperNote): string => {
    if (n.kind === 'role_set' && n.standInName) return 'role_set_stand_in';
    if (n.kind === 'their_start' && n.planned) return n.allowedByYou ? 'their_start_planned' : 'their_start_planned_ask';
    if (n.kind === 'their_start' && !n.allowedByYou) return 'their_start_ask';
    return n.kind;
};

/** What a note of the result says, in plain words. */
export function noteText(n: HelperNote, t: TranslateFn): string {
    const [key, english] = NOTE_TEXT[variantOf(n)];
    return t(key, english, { title: n.title ?? '', after: n.afterTitle ?? '', who: n.who ?? '', role: n.role ?? '', holder: n.holderName ?? '', standIn: n.standInName ?? '', reason: n.reason ?? '' });
}
