/**
 * The Teamwork helper (routes/coworkDeskRoutes.js, decision record 0049): from what a person writes in their own words
 * ("When my supplier mails are done, Ben checks the invoices. Questions go to purchasing: Ben, or Lena when he is
 * away.") to a PROPOSAL of a desk (usecases/coworkDesks.mts): which coworks, in which order, and who answers their
 * questions. It proposes and creates nothing; setting the proposal up goes through the desk's own use cases
 * (./coworkDeskHelperApply.mts), so every desk rule applies unchanged.
 *
 *   - the choices are what the desk itself allows the caller: their own coworks, coworks a colleague of their
 *     organisation shared with them, and the active members of their organisation; a cowork on another desk is left
 *     out (one desk per item);
 *   - one model call on the fast tier, with a strict schema (./coworkDeskHelperModel.mts); the model sees the
 *     person's words, the cowork titles and the colleagues' display names under local labels, never an id, an e-mail
 *     address or anything a run produced. The person's words pass the Cowork Privacy Shield first, as the composer's do
 *     (core/cowork/coworkCompose.js);
 *   - it counts as Cowork AI: refused at the item's or the organisation's budget (core/cowork/spendGate.mts), and the
 *     call is booked in the usage ledger under Cowork;
 *   - without a model, or when the model or the shield says no, the answer is an empty proposal the person fills in
 *     by hand from the same lists (`drafted: false`).
 */

import { createRequire } from 'node:module';
import { helperSystemPrompt, PROPOSAL_TOOL, readProposal, type Candidates, type ChainStep, type CoworkChoice, type PersonChoice, type RoleDraft } from './coworkDeskHelperModel.mts';

const nodeRequire = createRequire(import.meta.url);
const { HttpError } = nodeRequire('../core/http/errors.js') as { HttpError: new (status: number, code: string, message: string) => Error };
const log = nodeRequire('../telemetry/log.js') as { warn: (m: string) => void };

interface Person { id: string; organizationId?: string | null; status?: string | null; displayName?: string | null; username?: string | null }
interface Item { id: string; userId: string; title?: string | null; agentId?: string | null; planAutomationId?: string | null; monthlyBudget?: number | null }
interface Membership { deskId: string; deskOwnerId: string; accepted: boolean }
type Message = { role: string; content: string };

export interface HelperDeps {
    getUser: (id: string) => Promise<Person | null>;
    listMembers: (orgId: string) => Promise<Person[]>;
    getSchedule: (id: string) => Promise<Item | null>;
    myCoworks: (userId: string) => Promise<Item[]>;
    sharedWithMe: (userId: string) => Promise<Array<{ id: string; ownerId: string; title: string }>>;
    membershipOf: (scheduleId: string) => Promise<Membership | null>;
    /** Throws when the item's or the organisation's Cowork AI budget is used up (core/cowork/spendGate.mts). */
    spendLeft: (item: { id: string; userId: string; monthlyBudget?: number | null }) => Promise<void>;
    resolveModel: (who: { userOrgId: string | null; userId: string }) => Promise<string | null>;
    /** The Cowork Privacy Shield on the outgoing messages (core/cowork/coworkShield.js); throws on a block. */
    shield: (who: { orgId: string | null; userId: string; messages: Message[] }) => Promise<unknown>;
    chat: (modelId: string, messages: Message[], tool: typeof PROPOSAL_TOOL, options: Record<string, unknown>) => Promise<{ structured: unknown; usage?: unknown }>;
    logUsage: (call: Record<string, unknown>) => void;
    now: () => number;
}

export function helperDeps(): HelperDeps {
    const users = () => nodeRequire('../stores/userStore.js') as { getUser: HelperDeps['getUser']; getOrgMembersForDirectory: HelperDeps['listMembers'] };
    const store = () => nodeRequire('../stores/coworkStore.js') as { getSchedule: HelperDeps['getSchedule']; getSchedules: HelperDeps['myCoworks'] };
    return {
        getUser: (id) => users().getUser(id),
        listMembers: (orgId) => users().getOrgMembersForDirectory(orgId),
        getSchedule: (id) => store().getSchedule(id),
        myCoworks: (userId) => store().getSchedules(userId),
        sharedWithMe: (userId) => (nodeRequire('../stores/coworkShares.mts') as typeof import('../stores/coworkShares.mts')).coworkShares().sharedWith(userId),
        membershipOf: (id) => (nodeRequire('../stores/coworkDesks.mts') as typeof import('../stores/coworkDesks.mts')).coworkDesks().membershipOf(id),
        spendLeft: (item) => (nodeRequire('../core/cowork/spendGate.mts') as typeof import('../core/cowork/spendGate.mts')).assertSpendLeft(item),
        resolveModel: (who) => (nodeRequire('../core/llm/modelResolver.js') as { resolveModelForTier: (t: string, w: unknown) => Promise<string | null> }).resolveModelForTier('tier:fast', who),
        shield: (who) => (nodeRequire('../core/cowork/coworkShield.js') as { applyCoworkShieldToInput: HelperDeps['shield'] }).applyCoworkShieldToInput(who),
        chat: (modelId, messages, tool, options) => (nodeRequire('../core/llm/llmClient.js') as { chatForcedTool: HelperDeps['chat'] }).chatForcedTool(modelId, messages, tool, options),
        logUsage: (call) => (nodeRequire('../core/llm/surfaceUsage.js') as { logSurfaceUsage: (c: unknown) => void }).logSurfaceUsage(call),
        now: () => Date.now(),
    };
}

/** How many coworks of each kind the helper offers; more than that is chosen under "All settings". */
const MAX_COWORKS = 60;
const refuse = (status: number, message: string) => new HttpError(status, 'cowork_desk_helper_refused', message);
const counts = (p: Person | null | undefined, orgId: string): boolean => !!p && !!orgId && p.organizationId === orgId && (p.status ?? 'active') === 'active';
/** A display name, never an e-mail address: a username that is one is not shown to the model or anyone. */
const displayOf = (p: Person): string => {
    const name = (p.displayName || '').trim() || (p.username || '').trim();
    return name && !name.includes('@') ? name : 'A colleague';
};

/** Who is asking, as an active member of an organisation; 403 otherwise (the rule of usecases/coworkDesks.mts createDesk). */
export async function callerOf(userId: string, deps: Pick<HelperDeps, 'getUser'>): Promise<Person & { organizationId: string }> {
    const me = await deps.getUser(userId);
    if (!me?.organizationId || !counts(me, me.organizationId)) throw refuse(403, 'Teamwork is for members of an organisation.');
    return me as Person & { organizationId: string };
}

/**
 * The desk the helper works on when it is opened from a cowork: none when the item is on no desk, the item's desk
 * when the caller made it. Someone else's item is not found; an item on someone else's desk is changed there.
 */
export async function targetDeskOf(userId: string, itemId: string | null | undefined, deps: Pick<HelperDeps, 'getSchedule' | 'membershipOf'>): Promise<{ item: Item | null; deskId: string | null }> {
    if (!itemId) return { item: null, deskId: null };
    const item = await deps.getSchedule(itemId);
    if (item?.userId !== userId) throw refuse(404, 'That cowork does not exist.');
    const membership = await deps.membershipOf(itemId);
    if (!membership) return { item, deskId: null };
    if (!membership.accepted || membership.deskOwnerId !== userId) throw refuse(409, 'This cowork is on a desk someone else made. Change it there, under All settings.');
    return { item, deskId: membership.deskId };
}

/** On no desk, or on the desk the helper works on. */
async function free(id: string, deskId: string | null, deps: Pick<HelperDeps, 'membershipOf'>): Promise<boolean> {
    const m = await deps.membershipOf(id);
    return !m || (!!deskId && m.deskId === deskId);
}

/**
 * What the caller may use, as the desk's use cases would allow it: their own coworks, the coworks shared with them of
 * owners in their organisation, and the organisation's active members.
 */
export async function candidatesFor(userId: string, orgId: string, deskId: string | null, deps: Pick<HelperDeps, 'listMembers' | 'myCoworks' | 'sharedWithMe' | 'membershipOf' | 'getSchedule'>): Promise<Candidates> {
    const members = (await deps.listMembers(orgId)).filter((p) => (p.status ?? 'active') === 'active');
    const people: PersonChoice[] = members.map((p) => ({ id: p.id, name: displayOf(p), me: p.id === userId }));
    const nameOf = new Map(people.map((p) => [p.id, p.name]));
    const own = (await deps.myCoworks(userId)).slice(0, MAX_COWORKS);
    const shared = (await deps.sharedWithMe(userId)).filter((s) => s.ownerId !== userId && nameOf.has(s.ownerId)).slice(0, MAX_COWORKS);
    const sharedItems = await Promise.all(shared.map((s) => deps.getSchedule(s.id)));
    const all: CoworkChoice[] = [
        ...own.map((i) => ({ scheduleId: i.id, title: i.title || 'Untitled work', ownerId: userId, ownerName: nameOf.get(userId) ?? 'You', mine: true, hasRunner: !!(i.agentId || i.planAutomationId) })),
        ...shared.map((s, n) => ({ scheduleId: s.id, title: s.title || 'Untitled work', ownerId: s.ownerId, ownerName: nameOf.get(s.ownerId) as string, mine: false, hasRunner: !!(sharedItems[n]?.agentId || sharedItems[n]?.planAutomationId) })),
    ];
    const usable = await Promise.all(all.map((c) => free(c.scheduleId, deskId, deps)));
    return { coworks: all.filter((_, n) => usable[n]), people };
}

export interface DeskProposal {
    /** The model made it; false: an empty proposal to fill in by hand (no model, or the model or the shield said no). */
    drafted: boolean;
    /** The desk it changes (the caller's, the item is on), or null for a new desk. */
    deskId: string | null;
    deskName: string;
    chain: ChainStep[];
    roles: RoleDraft[];
    /** The person's words that matched no cowork or person. */
    unmatched: string[];
    /** What the dropdowns offer. */
    choices: { coworks: Array<Omit<CoworkChoice, 'ownerId' | 'hasRunner'>>; people: PersonChoice[] };
}

const messagesOf = (cands: Candidates, fromIndex: number | null, text: string): Message[] => [
    { role: 'system', content: helperSystemPrompt(cands, fromIndex) },
    { role: 'user', content: text },
];

/** The model's structured answer, or null when there is no model or it said nothing usable. Never throws. */
async function askModel(userId: string, userOrgId: string | null, messages: Message[], deps: HelperDeps): Promise<unknown> {
    try {
        const modelId = await deps.resolveModel({ userOrgId, userId });
        if (!modelId) return null;
        // The person's own words, through the shield as the composer's are: a masking rewrites them, a block throws.
        await deps.shield({ orgId: userOrgId, userId, messages });
        const startedAt = deps.now();
        const answer = await deps.chat(modelId, messages, PROPOSAL_TOOL, { maxTokens: 900, temperature: 0 });
        deps.logUsage({ source: 'cowork_compose', userId, orgId: userOrgId, model: modelId, usage: answer.usage, startedAt });
        return answer.structured ?? null;
    } catch (e) {
        log.warn(`[CoworkDeskHelper] no proposal from the model, the person chooses by hand: ${(e as Error).message}`);
        return null;
    }
}

/** Propose a desk from the person's words. Creates nothing. */
export async function draftDesk({ userId, text, itemId = null, userOrgId = null }: { userId: string; text: string; itemId?: string | null; userOrgId?: string | null }, deps: HelperDeps = helperDeps()): Promise<DeskProposal> {
    const me = await callerOf(userId, deps);
    const { item, deskId } = await targetDeskOf(userId, itemId, deps);
    // Asking the helper is Cowork AI: the item's budget when it is opened from one, the organisation's always.
    await deps.spendLeft(item ?? { id: '', userId, monthlyBudget: null });
    const cands = await candidatesFor(userId, me.organizationId, deskId, deps);
    const fromIndex = item ? cands.coworks.findIndex((c) => c.scheduleId === item.id) : -1;
    const words = text.trim();
    const raw = await askModel(userId, userOrgId ?? me.organizationId, messagesOf(cands, fromIndex >= 0 ? fromIndex : null, words), deps);
    const proposal = readProposal(raw, cands, words, item?.title?.trim() || 'Teamwork');
    return {
        drafted: raw !== null, deskId, ...proposal,
        choices: { coworks: cands.coworks.map(({ ownerId: _o, hasRunner: _r, ...c }) => c), people: cands.people },
    };
}
