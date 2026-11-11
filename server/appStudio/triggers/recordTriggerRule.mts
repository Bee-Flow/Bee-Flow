/**
 * THE RULE of record triggers: which write may start an owner-level run, and how far a chain
 * of such runs may go. One file, read by the validator and the kind (kinds/record.mts), the
 * arming (triggerSync.mts through the kind), the write path (recordOutbox.mts) and the fire
 * (recordDrain.mts). Pure: no I/O.
 *
 * A record trigger runs its action AS THE APP OWNER (unattendedIdentity.mts) when a row of its
 * table is created, updated or deleted. Whoever wrote the row gets nothing of the owner's
 * rights, but they do decide WHEN the owner's steps run. So:
 *
 * 1. WHICH WRITES COUNT. Only a write that says where it comes from can fire, and only two
 *    origins exist (WriteSource):
 *      user     a person using the app: the record API (grid and form edits) and the
 *               create_record / update_record / delete_record steps of a click or of a
 *               server run a person started;
 *      trigger  the same three steps in a run a trigger started.
 *    Every other write names no origin and NEVER fires: the AI builder and MCP tools
 *    (app_seed_records, app_update_records, app_run_action, app_run_tests), dry runs (they do
 *    not write), template and Blueprint installs, imports, connector sync, the mailbox hook,
 *    file intake, ai_extract's rows, dataset_query's write-back, the log row of send_email and
 *    the approval hook. So do, in this version, the writes that are not one row through the
 *    choke point: a filter update or delete (bulkRecords.mts), a transaction step, replace and
 *    upsert targets, a batch create, a delete that follows delete rules onto linked records
 *    (cascadeDelete.mts), and a retention sweep. A one-row create or update that also sets
 *    many-relation links fires as one change (the links are not part of `changed`). A table linked to a Studio datatable is refused as
 *    a trigger table altogether (rows change there without this app seeing it, and two apps
 *    sharing one could start each other without end).
 *
 * 2. WHO WROTE IT (WriterKind), decided here from the viewer the write path was handed, never
 *    from what a caller claims:
 *      public   an anonymous visitor of a public page (the reserved public role, or an
 *               anonymous viewer id), whatever else is said;
 *      owner    the app owner;
 *      member   any other signed-in person;
 *      trigger  a run a trigger started.
 *
 * 3. THE PUBLIC-TABLE RULE. A write by `public`, and ANY write into a table the public role
 *    may write for that event (create, update or delete in the table's access), fires a
 *    trigger only when both hold:
 *      - the trigger says `allowPublicWrites: true`, and
 *      - its action, and every action that one calls, holds none of PUBLIC_REFUSED_KINDS:
 *        the steps that reach people in the owner's name (send_email, run_automation,
 *        request_approval) and the one that erases data (delete_record).
 *    The table counts, not only the writer: on a table strangers can write, a member's row
 *    and a stranger's row are told apart by nothing a rule may rest on. Enforced three times:
 *    the validator refuses the trigger (with the data model at hand, so at the publish), the
 *    arming leaves it out (the kind refuses the kinds through `refusedKindsFor`), and every
 *    fire reads the table's access again from the data model of that moment.
 *
 * 4. THE DEPTH GUARD. Every event carries its depth: the number of trigger runs in the chain
 *    that led to the write. A person's write is depth 0; a write made by a run that an event
 *    of depth d started is depth d + 1; a write of a schedule run is depth 1. An event of
 *    depth STUDIO_APP_RECORD_TRIGGER_MAX_DEPTH (default 3) or more starts nothing, and the
 *    trigger shows why: a chain is at most that many runs long. A run whose chain cannot be
 *    read (its event is gone) writes at a depth beyond every limit. And a trigger never fires
 *    on a write of ITS OWN run, whatever the row: the plain loop (update the row I fire on)
 *    ends at once, and A -> B -> A ends at the depth limit.
 *
 * 5. BURST. One writer starts at most STUDIO_APP_RECORD_TRIGGER_WRITER_BURST runs of one app
 *    per minute (default 30); beyond it the event is skipped and the trigger shows why. The
 *    per-app limits of every trigger (triggerLimits.mts) hold on top.
 *
 * Personal data: the row values travel in the outbox and in the run's `trigger` scope, both
 * inside Bee Flow. The writer is kept as a kind and a one-way key for the burst count, never
 * as a name or an address; logs carry ids, kinds and counts only.
 */

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

export const RECORD_EVENTS = Object.freeze(['create', 'update', 'delete'] as const);
export type RecordEvent = typeof RECORD_EVENTS[number];

export type WriterKind = 'public' | 'owner' | 'member' | 'trigger';

/** Where a write says it comes from (rule 1). `trigger`: the chain of the run that writes. */
export type WriteSource =
    | { kind: 'user' }
    | { kind: 'trigger'; depth: number; triggerId: string | null };

/** The steps an action may not hold when a stranger's write can start it (rule 3). */
export const PUBLIC_REFUSED_KINDS: readonly string[] = Object.freeze(['send_email', 'run_automation', 'request_approval', 'delete_record']);

/** The depth given to a run whose chain could not be read: beyond every limit, so its writes fire nothing. */
export const UNKNOWN_DEPTH = 1_000_000;

const publicKeys = (): { role: string; anonPrefix: string } => {
    const { PUBLIC_ROLE_KEY } = nodeRequire('../dataModel') as { PUBLIC_ROLE_KEY: string };
    const { ANON_VIEWER_PREFIX } = nodeRequire('../publicAccess') as { ANON_VIEWER_PREFIX: string };
    return { role: PUBLIC_ROLE_KEY, anonPrefix: ANON_VIEWER_PREFIX };
};

/** A write source as the write path accepts it, or null (the write then fires nothing). */
export function readWriteSource(raw: unknown): WriteSource | null {
    if (!isObject(raw)) return null;
    if (raw.kind === 'user') return { kind: 'user' };
    if (raw.kind !== 'trigger') return null;
    const depth = typeof raw.depth === 'number' && Number.isFinite(raw.depth) && raw.depth >= 0 ? Math.floor(raw.depth) : UNKNOWN_DEPTH;
    return { kind: 'trigger', depth, triggerId: typeof raw.triggerId === 'string' && raw.triggerId ? raw.triggerId : null };
}

/** Rule 2. A viewer without an id, with an anonymous id or with the public role is `public`, whatever the source says. */
export function writerKindOf(source: WriteSource, viewer: unknown, ownerUserId: string): WriterKind {
    const v = isObject(viewer) ? viewer : {};
    const keys = publicKeys();
    const id = typeof v.id === 'string' ? v.id : '';
    if (!id || id.startsWith(keys.anonPrefix) || v.role === keys.role || !v.role) return 'public';
    if (source.kind === 'trigger') return 'trigger';
    return id === ownerUserId && v.role === 'owner' ? 'owner' : 'member';
}

/** The key the burst count groups by: one way, per app, so it names nobody. Null for a trigger's own write. */
export function writerKeyOf(kind: WriterKind, viewer: unknown, appId: string): string | null {
    if (kind === 'trigger') return null;
    const id = isObject(viewer) && typeof viewer.id === 'string' ? viewer.id : '';
    return createHash('sha256').update(`${appId}\n${kind}\n${id}`).digest('hex').slice(0, 32);
}

/** The events the public role may cause in `table` (its access block), read as the write path reads it. */
export function publicWritableEvents(table: unknown): RecordEvent[] {
    const { resolveScope } = nodeRequire('../../core/dataEngine/accessFilter') as { resolveScope: (t: unknown, role: string, action: string) => unknown };
    const role = publicKeys().role;
    return RECORD_EVENTS.filter((event) => {
        const scope = resolveScope(table, role, event);
        return event === 'create' ? scope === true : scope === 'own' || scope === 'all';
    });
}

/** Rule 3, the table half: does a trigger on these events of `table` need `allowPublicWrites`? */
export function needsPublicOptIn(table: unknown, on: readonly string[]): boolean {
    return publicWritableEvents(table).some((event) => on.includes(event));
}

export type DeliveryCheck = {
    event: string; writerKind: string; depth: number; causeTriggerId: string | null;
};
export type TriggerRule = { triggerId: string; on: readonly string[]; allowPublicWrites: boolean };

/**
 * Rules 3 and 4 for one event and one trigger: null when the event may start the trigger's run,
 * else why not, as a code and a sentence for the owner. `table` is the model table of this moment
 * (null: it is gone).
 */
export function deliveryRefusal(check: DeliveryCheck, trigger: TriggerRule, table: unknown, maxDepth: number): { code: string; reason: string } | null {
    if (!table) return { code: 'table_gone', reason: 'Skipped: the table of this trigger is no longer in the app.' };
    if (isObject(table) && table.source !== undefined && table.source !== null) {
        return { code: 'linked_table', reason: 'Skipped: the table is linked to a Studio table, and a record trigger does not run on a linked table.' };
    }
    if (!trigger.on.includes(check.event)) return { code: 'event_off', reason: 'Skipped: the trigger does not listen to this event.' };
    if (check.causeTriggerId !== null && check.causeTriggerId === trigger.triggerId) {
        return { code: 'own_write', reason: 'Skipped: the row was written by a run of this same trigger.' };
    }
    if (maxDepth > 0 && check.depth >= maxDepth) {
        return { code: 'depth', reason: `Skipped: this change came from a chain of ${check.depth >= UNKNOWN_DEPTH ? 'unknown length of' : check.depth} trigger runs, and a chain stops after ${maxDepth} (STUDIO_APP_RECORD_TRIGGER_MAX_DEPTH=${maxDepth}).` };
    }
    const publicTable = publicWritableEvents(table).includes(check.event as RecordEvent);
    if ((check.writerKind === 'public' || publicTable) && !trigger.allowPublicWrites) {
        return { code: 'public_write', reason: 'Skipped: visitors of a public page can write this table, and the trigger does not allow such writes to start it (allowPublicWrites).' };
    }
    return null;
}
