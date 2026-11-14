/**
 * App Studio Builder — changes that wait for the user's confirmation.
 *
 * A few builder calls take effect on live data at once (the data model is not
 * held back by publishing): writing to existing rows, arming a mailbox hook
 * that then runs on every incoming mail, and changes that give more people
 * access to data (column rights, table access rules, roles and the role
 * mapping). The in-product builder does not run those on the model's word.
 * It holds the call, shows the user a confirmation card (the same
 * `review_questions` card as app_ask_questions, one question with two
 * answers), and ends the turn. The held call is kept in the session snapshot;
 * when the user's next message is the card's answer "Apply this change", the
 * route runs exactly that call before the model's first round and tells the
 * model the outcome in a machine note. Any other message leaves it unapplied.
 *
 * What counts as giving more access, per call:
 *   app_upsert_table  on an existing table: a change of its access rules, or a
 *                     field whose column rights get wider (rights removed, a
 *                     role added to read or write); on a new table: a right
 *                     for the public role. A dry run never waits.
 *   app_set_roles     a new role key, a changed role mapping (default or
 *                     groups), or the organisation member list switched on.
 * Both only while the app holds rows: on an app with no stored data a change
 * of rights exposes nothing, and building a new app's roles stays one step.
 *   app_update_records  every write (the `updates` form, or a filter with
 *                     dry_run:false); a dry run never waits.
 *   app_set_mailbox_hook  arming or changing a hook (switching it off never waits).
 */

import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const nodeRequire = createRequire(import.meta.url);
const { parseAnswersText } = nodeRequire('../../../automation/builderTools/questionAnswers.js') as {
    parseAnswersText: (content: unknown) => { prompt: string; answer: string }[] | null;
};

type Obj = Record<string, unknown>;
type Field = { id?: string; key?: string; access?: unknown };
type Table = { id?: string; key?: string; name?: string; fields?: Field[]; access?: unknown };
type Model = { tables?: Table[]; roles?: Array<{ key?: string }>; roleMapping?: unknown; directory?: { orgMembers?: boolean }; connectors?: Array<{ id?: string; kind?: string }> };
type Draft = { dataModel?: unknown; rowCounts?: Record<string, unknown> | null; def?: { actions?: unknown } | null };

export type ConfirmCard = { id: string; header: string; prompt: string; options: string[] };
export type HeldChange = { name: string; args: Obj; prompt: string };

export const APPLY = 'Apply this change';
export const SKIP = 'Leave it as it is';
/** The arguments of a held call are kept in the session snapshot; a larger call is split instead. */
const MAX_HELD_ARGS_CHARS = 32_000;
const { PUBLIC_ROLE_KEY: PUBLIC_ROLE } = nodeRequire('../../../core/dataEngine/dataModel/vocabulary.js') as { PUBLIC_ROLE_KEY: string };

export const CONFIRMABLE_TOOLS: ReadonlySet<string> = new Set(['app_update_records', 'app_set_mailbox_hook', 'app_upsert_table', 'app_set_roles']);

const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const oneLine = (t: unknown): string => String(t ?? '').replace(/\s+/g, ' ').trim();
const quoted = (t: unknown): string => `"${oneLine(t).slice(0, 80)}"`;
const modelOf = (draft: Draft): Model => (isObj(draft.dataModel) ? draft.dataModel as Model : {});
const tablesOf = (m: Model): Table[] => (Array.isArray(m.tables) ? m.tables : []);
const hasRows = (draft: Draft): boolean => Object.values(isObj(draft.rowCounts) ? draft.rowCounts : {}).some((n) => Number(n) > 0);
const stable = (v: unknown): string => JSON.stringify(v ?? null, (_k, x) => (isObj(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));

function tableName(m: Model, tableId: unknown): string {
    const t = tablesOf(m).find((x) => x.id === tableId);
    return quoted(t?.name || t?.key || tableId);
}

function list(v: unknown): string[] | null {
    return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : null;
}

/** True when `after` reaches a role `before` did not (null = every role). */
function gains(before: string[] | null, after: string[] | null): boolean {
    if (before === null) return false;
    if (after === null) return true;
    return after.some((r) => !before.includes(r));
}

/** Column rights (core/dataEngine/columnRights.mts): read left out = every role; write left out follows read. */
function fieldWidens(before: unknown, after: unknown): boolean {
    const b = isObj(before) ? before : {};
    const a = isObj(after) ? after : {};
    const bRead = list(b.read);
    const aRead = list(a.read);
    return gains(bRead, aRead) || gains(list(b.write) ?? bRead, list(a.write) ?? aRead);
}

function namesPublic(table: Table): boolean {
    const access = isObj(table.access) ? table.access : {};
    if (isObj(access.roles) && Object.hasOwn(access.roles, PUBLIC_ROLE)) return true;
    return (table.fields || []).some((f) => isObj(f?.access) && ['read', 'write'].some((k) => (list((f.access as Obj)[k]) || []).includes(PUBLIC_ROLE)));
}

function upsertTablePrompt(args: Obj, draft: Draft): string | null {
    if (args.dryRun === true) return null;
    const m = modelOf(draft);
    const { mergeTableOp } = nodeRequire('../../../appStudio/builderTools/dataToolsTables.js') as {
        mergeTableOp: (model: unknown, a: unknown, rc: unknown) => { error?: string; table?: Table };
    };
    let merged: { error?: string; table?: Table };
    try { merged = mergeTableOp(structuredClone(m), args, draft.rowCounts || {}); } catch { return null; }
    if (merged.error || !merged.table) return null; // the tool refuses it itself
    const after = merged.table;
    const before = tablesOf(m).find((t) => t.id === after.id) || null;
    const name = quoted(after.name || after.key);
    if (!before) return namesPublic(after) ? `Create table ${name} with rights for public visitors?` : null;
    if (!hasRows(draft)) return null;
    const what: string[] = [];
    if (args.access !== undefined && stable(before.access) !== stable(after.access)) what.push('its access rules');
    const wider = (after.fields || []).filter((f) => {
        const old = (before.fields || []).find((o) => (o.id && o.id === f.id) || o.key === f.key);
        return old && fieldWidens(old.access, f.access);
    }).map((f) => oneLine(f.key));
    if (wider.length) what.push(`wider column rights on ${wider.slice(0, 6).join(', ')}${wider.length > 6 ? ', …' : ''}`);
    return what.length ? `Change who may see or edit data in table ${name}: ${what.join('; ')}?` : null;
}

function setRolesPrompt(args: Obj, draft: Draft): string | null {
    if (!hasRows(draft)) return null;
    const m = modelOf(draft);
    const known = new Set((Array.isArray(m.roles) ? m.roles : []).map((r) => r?.key));
    const added = (Array.isArray(args.roles) ? args.roles : []).map((r) => (isObj(r) ? r.key : null))
        .filter((k): k is string => typeof k === 'string' && !known.has(k));
    const what: string[] = [];
    if (added.length) what.push(`new roles ${added.slice(0, 6).join(', ')}`);
    if (isObj(args.roleMapping)) {
        const before = isObj(m.roleMapping) ? m.roleMapping : { default: 'app', byGroup: {} };
        const rm = args.roleMapping;
        if (rm.default !== undefined && rm.default !== before.default) what.push(`everyone without a group mapping gets ${quoted(rm.default)}`);
        if (rm.byGroup !== undefined && stable(rm.byGroup) !== stable(before.byGroup ?? {})) what.push('a new group-to-role mapping');
    }
    if (args.orgDirectory === true && m.directory?.orgMembers !== true) what.push('the app may read the organisation\'s member list');
    return what.length ? `Change the app's roles: ${what.join('; ')}?` : null;
}

function updateRecordsPrompt(args: Obj, draft: Draft): string | null {
    const m = modelOf(draft);
    const table = tableName(m, args.tableId);
    if (Array.isArray(args.updates)) {
        const keys = new Set<string>();
        for (const u of args.updates) if (isObj(u) && isObj(u.values)) for (const k of Object.keys(u.values)) keys.add(k);
        return `Write new values to ${args.updates.length} existing row(s) of table ${table}${keys.size ? ` (${[...keys].slice(0, 6).join(', ')})` : ''}?`;
    }
    if (args.dry_run !== false) return null;
    const keys = isObj(args.values) ? Object.keys(args.values) : [];
    const max = Number.isInteger(args.max) ? args.max : null;
    return `Write new values${keys.length ? ` (${keys.slice(0, 6).join(', ')})` : ''} to ${max ? `up to ${max}` : 'the'} existing rows of table ${table} that match a filter?`;
}

function mailboxHookPrompt(args: Obj, draft: Draft): string | null {
    if (args.actionId === null || typeof args.actionId !== 'string') return null;
    const actions = isObj(draft.def?.actions) ? draft.def.actions : {};
    const action = Object.hasOwn(actions, args.actionId) && isObj(actions[args.actionId]) ? actions[args.actionId] as Obj : null;
    const label = quoted(action && typeof action.name === 'string' && action.name ? action.name : args.actionId);
    const what = args.target === 'thread' ? 'new conversation' : 'new incoming message';
    return `Run the action ${label} automatically for every ${what} in mailbox ${quoted(args.connectorId)}, once the app is published?`;
}

/** The one-line question for a call that waits for the user's confirmation, or null when it may run. */
export function confirmationPrompt(name: string, args: unknown, draft: Draft): string | null {
    if (!CONFIRMABLE_TOOLS.has(name)) return null;
    const a = isObj(args) ? args : {};
    switch (name) {
        case 'app_update_records': return updateRecordsPrompt(a, draft);
        case 'app_set_mailbox_hook': return mailboxHookPrompt(a, draft);
        case 'app_upsert_table': return upsertTablePrompt(a, draft);
        case 'app_set_roles': return setRolesPrompt(a, draft);
        default: return null;
    }
}

export type HoldOutcome = { held: HeldChange; card: ConfirmCard; result: Obj } | { result: Obj } | null;

/**
 * What the gate does with a call: null to let it run, or the tool result the
 * model reads instead, with the change to hold and its card when it is held.
 */
export function holdCall(name: string, args: unknown, draft: Draft): HoldOutcome {
    const prompt = confirmationPrompt(name, args, draft);
    if (!prompt) return null;
    const a = isObj(args) ? args : {};
    if (JSON.stringify(a).length > MAX_HELD_ARGS_CHARS) {
        return { result: { error: `${name} changes live data and needs the user's confirmation, but this call is too large to hold for it. Split it into smaller calls.` } };
    }
    const card: ConfirmCard = { id: `confirm_${randomUUID()}`, header: 'Confirm change', prompt: prompt.slice(0, 1000), options: [APPLY, SKIP] };
    return {
        held: { name, args: a, prompt: card.prompt },
        card,
        result: {
            error: `Not applied yet: ${name} changes live data, so it waits for the user's confirmation (the chat shows them a card). End your turn now with one short sentence that says what waits for their confirmation. Do not call it again: when they confirm, it is applied for you.`,
        },
    };
}

/** The held change of the last turn, and whether this message is the card's answer "apply". */
export function readConfirmation(prior: unknown, message: unknown): { held: HeldChange; confirmed: boolean } | null {
    if (!isObj(prior) || typeof prior.name !== 'string' || !CONFIRMABLE_TOOLS.has(prior.name) || !isObj(prior.args) || typeof prior.prompt !== 'string') return null;
    const held: HeldChange = { name: prior.name, args: prior.args, prompt: prior.prompt };
    const answer = (parseAnswersText(message) || []).find((p) => oneLine(p.prompt) === oneLine(held.prompt));
    return { held, confirmed: !!answer && oneLine(answer.answer) === APPLY };
}

/** What the model is told about the held change at the start of the next turn. */
export function confirmationNoteBody(held: HeldChange, outcome: { applied: boolean; result?: unknown; reason?: string }): string {
    if (!outcome.applied) {
        return `The change you held last turn was NOT applied (${outcome.reason || 'the user did not confirm it'}): ${held.prompt} Do not make it unless the user asks for it again.`;
    }
    const text = JSON.stringify(outcome.result ?? null);
    return `The user confirmed the change you held last turn, and it was run for you now: ${held.name} → ${text.length > 4000 ? `${text.slice(0, 4000)}…` : text} Do not call it again.`;
}

// ── The route's side ─────────────────────────────────────────────────

type Send = (event: string, data: unknown) => void;
type TurnLike = { heldChange: HeldChange | null; toolCallCount: number; mutatingToolCalls: number; builtThisTurn: boolean };
type DraftWrap = Draft & { appId?: string | null; version?: number; [k: string]: unknown };

/** The refusal of every call after a change was held this turn: the turn ends at the card. */
export function heldWait(turn: { heldChange: HeldChange | null }): Obj | null {
    return turn.heldChange ? { error: 'A change waits for the user\'s confirmation: end your turn now.' } : null;
}

/** The gate of the build loop: null to run the call, or the result the model reads (the card is sent here). */
export function gateConfirmable(name: string, args: unknown, turn: TurnLike, ctx: { draftWrap: Draft; send: Send }): Obj | null {
    const hold = holdCall(name, args, ctx.draftWrap);
    if (!hold) return null;
    if ('held' in hold) {
        turn.heldChange = hold.held;
        ctx.send('review_questions', { questions: [hold.card] });
    }
    return hold.result;
}

/**
 * Start of a turn: the change held last turn runs when this message is the
 * card's "apply" answer, and is dropped otherwise. Returns the note body for
 * the model, or null when nothing was held.
 */
export async function settleHeldChange({ prior, message, workMode, draftWrap, send, turn }: {
    prior: unknown; message: unknown; workMode: unknown; draftWrap: DraftWrap; send: Send; turn: TurnLike;
}): Promise<string | null> {
    const read = readConfirmation(prior, message);
    if (!read) return null;
    const { held, confirmed } = read;
    if (!confirmed) return confirmationNoteBody(held, { applied: false });
    if (workMode === 'discuss') return confirmationNoteBody(held, { applied: false, reason: 'the chat is in Just advise mode, which changes nothing' });
    const tools = nodeRequire('../../../appStudio/builderTools') as {
        applyToolCall: (n: string, a: unknown, d: unknown) => Promise<unknown>;
        persistDraft: (d: unknown) => Promise<{ error?: string }>;
        MUTATING_TOOLS: Set<string>; DATA_MODEL_TOOLS: Set<string>;
    };
    const { toolCallEvent } = nodeRequire('./toolCallEvents') as { toolCallEvent: (n: string, a: unknown, r: unknown, ok: boolean, d: unknown) => Obj };
    const { dataModelEvent } = nodeRequire('./dataModelEvent') as { dataModelEvent: (d: unknown) => unknown };
    const result = await tools.applyToolCall(held.name, held.args, draftWrap);
    const ok = !(isObj(result) && result.error);
    turn.toolCallCount += 1;
    send('tool_call', toolCallEvent(held.name, held.args, result, ok, draftWrap));
    if (!ok) return confirmationNoteBody(held, { applied: false, reason: `the builder refused it: ${oneLine((result as Obj).error).slice(0, 300)}` });
    turn.mutatingToolCalls += 1;
    turn.builtThisTurn = true;
    if (tools.MUTATING_TOOLS.has(held.name)) {
        const persisted = await tools.persistDraft(draftWrap);
        if (!persisted.error) send('draft', { appId: draftWrap.appId, definition: draftWrap.def, version: draftWrap.version });
    }
    if (tools.DATA_MODEL_TOOLS.has(held.name)) send('data_model', dataModelEvent(draftWrap));
    return confirmationNoteBody(held, { applied: true, result });
}
