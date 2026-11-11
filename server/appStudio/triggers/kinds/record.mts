/**
 * The `record` trigger: run an action when a row of one of the app's own tables changes.
 *
 *   { id, kind: 'record', actionId, tableId, on: ['create', 'update', 'delete'],
 *     fields?: [field keys], when?: '<formula>', allowPublicWrites?: true }
 *
 *   tableId            a table of the app's data model with its own storage (a table linked to a
 *                      Studio table is refused)
 *   on                 the events it listens to, at least one
 *   fields             for `update`: fire only when one of these fields changed value
 *   when               a formula over the `trigger` root (trigger.record.*); the run starts only when it is true.
 *                      Evaluated on the server (recordDrain.mts), inside the expression engine's
 *                      work budget; a formula that fails starts nothing and the trigger says why
 *   allowPublicWrites  only written as true: the trigger may also start on a write by a visitor
 *                      of a public page, and on any write into a table such visitors can write.
 *                      Its action then holds none of PUBLIC_REFUSED_KINDS
 *
 * The run is the app owner (unattendedIdentity.mts) and reads the change as the `trigger` root,
 * under its kind's own name (triggerScope.mts), so no other kind can claim the same path:
 *
 *   trigger.kind               'record'
 *   trigger.record.event       'create' | 'update' | 'delete'
 *   trigger.record.tableId     the table
 *   trigger.record.id          the row's id
 *   trigger.record.row         the row after the change (for a delete: the row as it was), as the owner reads it
 *   trigger.record.before      the row before an update or a delete; null for a create
 *   trigger.record.changed     the field keys whose value changed (update), else []
 *   trigger.record.by          who wrote it, as a kind: 'member', 'owner', 'public', 'trigger' or
 *                              'webhook'. A run that a visitor's write could start writes as
 *                              'public' again, and a run in a chain a webhook delivery started as
 *                              'webhook' (recordTriggerRule.mts rule 6). Never a name or an account
 *   trigger.record.depth       how many trigger runs led to this change (0: a person wrote it)
 *   trigger.record.triggerId   this trigger's id
 *
 * Which writes fire it, the public-table rule and the loop guard: recordTriggerRule.mts.
 */

import { createRequire } from 'node:module';
import type { Finding, KindValidateCtx, Obj, Push, TriggerKind } from '../triggerKinds.mts';
import { PUBLIC_REFUSED_KINDS, RECORD_EVENTS, needsPublicOptIn } from '../recordTriggerRule.mts';

const nodeRequire = createRequire(import.meta.url);
const { LIMITS } = nodeRequire('../../componentSpecs/limits.js') as { LIMITS: { MAX_FORMULA_LEN: number } };
type Compiled = { refs: string[] };
const compile = (expr: string): Compiled => (nodeRequire('../../../shared/expr/index.mjs') as { compile: (e: string) => Compiled }).compile(expr);

export const MAX_WATCHED_FIELDS = 50;
export const MAX_NAME_LEN = 80;
/** The roots a `when` formula may read. */
export const WHEN_ROOTS: readonly string[] = Object.freeze(['trigger', 'now', 'today']);

const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const isName = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= MAX_NAME_LEN;

export type RecordTriggerConfig = { tableId: string; on: string[]; fields?: string[]; when?: string; allowPublicWrites?: true };

/** The kind's fields in canonical form, or the reason they are not usable. */
export function readRecordTrigger(raw: Obj): { ok: true; config: RecordTriggerConfig } | { ok: false; problem: string; path: string } {
    if (!isName(raw.tableId)) return { ok: false, path: 'tableId', problem: 'tableId names the table whose changes start the action' };
    const asked = Array.isArray(raw.on) ? raw.on : [];
    const on = RECORD_EVENTS.filter((e) => asked.includes(e));
    if (!on.length || asked.some((e) => !(RECORD_EVENTS as readonly unknown[]).includes(e))) {
        return { ok: false, path: 'on', problem: `on lists at least one of ${RECORD_EVENTS.join(', ')} and nothing else` };
    }
    const config: RecordTriggerConfig = { tableId: raw.tableId, on: [...on] };
    if (raw.fields !== undefined && raw.fields !== null) {
        if (!Array.isArray(raw.fields) || raw.fields.length > MAX_WATCHED_FIELDS || !raw.fields.every(isName)) {
            return { ok: false, path: 'fields', problem: `fields is a list of at most ${MAX_WATCHED_FIELDS} field names` };
        }
        const fields = [...new Set(raw.fields as string[])];
        if (fields.length) config.fields = fields;
    }
    if (raw.when !== undefined && raw.when !== null && raw.when !== '') {
        if (typeof raw.when !== 'string' || raw.when.length > LIMITS.MAX_FORMULA_LEN) {
            return { ok: false, path: 'when', problem: `when is a formula of at most ${LIMITS.MAX_FORMULA_LEN} characters` };
        }
        config.when = raw.when;
    }
    if (raw.allowPublicWrites !== undefined && raw.allowPublicWrites !== false && raw.allowPublicWrites !== true) {
        return { ok: false, path: 'allowPublicWrites', problem: 'allowPublicWrites is only written as true' };
    }
    if (raw.allowPublicWrites === true) config.allowPublicWrites = true;
    return { ok: true, config };
}

/** Why a `when` formula cannot be used, or null. Compiled, never evaluated. */
export function whenProblem(expr: string): string | null {
    let refs: string[];
    try {
        refs = compile(expr).refs;
    } catch (e) {
        return `the when formula does not parse: ${(e as Error)?.message || 'syntax error'}`;
    }
    const unknown = refs.filter((r) => !WHEN_ROOTS.includes(r));
    return unknown.length ? `the when formula reads ${unknown.map((r) => `"${r}"`).join(', ')}, but only ${WHEN_ROOTS.join(', ')} exist when a record trigger is checked` : null;
}

function canon(raw: Obj, at: string, push: Push): Obj | null {
    const read = readRecordTrigger(raw);
    if ('problem' in read) {
        push('triggers.record_invalid', `${at}.${read.path}`, `${read.problem} — the trigger was removed.`);
        return null;
    }
    return read.config;
}

const HINT = 'Shape: { kind: "record", tableId, on: ["create", "update", "delete"], fields?, when?, allowPublicWrites? }.';

/** The model table `tableId` names, when the validator was handed the data model (undefined: it was not). */
function modelTable(ctx: KindValidateCtx, tableId: string): Obj | null | undefined {
    if (ctx.dataModel === undefined) return undefined;
    const tables = isObject(ctx.dataModel) && Array.isArray(ctx.dataModel.tables) ? ctx.dataModel.tables : [];
    return (tables.find((t) => isObject(t) && t.id === tableId) as Obj | undefined) ?? null;
}

/** The names of a model table's fields. */
function fieldNames(table: Obj): Set<unknown> {
    const out = new Set<unknown>();
    for (const field of Array.isArray(table.fields) ? table.fields : []) if (isObject(field)) out.add(field['key']);
    return out;
}

function checkTable(config: RecordTriggerConfig, at: string, ctx: KindValidateCtx): void {
    const table = modelTable(ctx, config.tableId);
    if (table === undefined) return;
    const error = (code: string, path: string, message: string, hint: string): void => ctx.pushE({ code, severity: 'error', path, message, hint });
    if (table === null) {
        error('triggers.record_table_unknown', `${at}.tableId`, `A record trigger names table ${JSON.stringify(config.tableId)}, which is not in the app's data model.`, 'Create the table first, or point the trigger at an existing one.');
        return;
    }
    if (table.source !== undefined && table.source !== null) {
        error('triggers.record_linked_table', `${at}.tableId`, `Table "${config.tableId}" is linked to a Studio table, and a record trigger only runs on a table the app stores itself.`, 'Use a table of the app, or start the action on a schedule.');
        return;
    }
    const names = fieldNames(table);
    for (const field of config.fields ?? []) {
        if (!names.has(field)) error('triggers.record_field_unknown', `${at}.fields`, `Table "${config.tableId}" has no field "${field}".`, 'List fields of the table.');
    }
    if (needsPublicOptIn(table, config.on) && !config.allowPublicWrites) {
        error(
            'triggers.record_public_table', `${at}.allowPublicWrites`,
            `Visitors of a public page can write table "${config.tableId}", so anyone could start this trigger's action, which runs as the app owner.`,
            `Take the public role's write access off the table, or set allowPublicWrites: true on the trigger; its action may then hold no ${PUBLIC_REFUSED_KINDS.join(', ')} step.`,
        );
    }
}

function validate(trigger: Obj, at: string, ctx: KindValidateCtx): void {
    const read = readRecordTrigger(trigger);
    if ('problem' in read) {
        const finding: Finding = { code: 'triggers.record_invalid', severity: 'error', path: `${at}.${read.path}`, message: `Record trigger: ${read.problem}.`, hint: HINT };
        ctx.pushE(finding);
        return;
    }
    if (trigger.allowPublicWrites === false) {
        ctx.pushE({ code: 'triggers.record_invalid', severity: 'error', path: `${at}.allowPublicWrites`, message: 'Record trigger: allowPublicWrites is only written as true.', hint: 'Remove it.' });
    }
    if (read.config.when) {
        const problem = whenProblem(read.config.when);
        if (problem) ctx.pushE({ code: 'triggers.record_when_invalid', severity: 'error', path: `${at}.when`, message: `Record trigger: ${problem}.`, hint: 'Read the change as trigger.record.row.<field>, trigger.record.before.<field>, trigger.record.event and trigger.record.changed.' });
    }
    if (read.config.fields && !read.config.on.includes('update')) {
        ctx.pushW({ code: 'triggers.record_fields_unused', severity: 'warning', path: `${at}.fields`, message: 'Record trigger: fields only narrows the update event, and this trigger does not listen to update.', hint: 'Add "update" to on, or remove fields.' });
    }
    checkTable(read.config, at, ctx);
}

const record: TriggerKind = {
    kind: 'record',
    since: 3,
    fields: ['tableId', 'on', 'fields', 'when', 'allowPublicWrites'],
    canon,
    validate,
    config: (trigger) => {
        const read = readRecordTrigger(trigger);
        return read.ok ? { ...read.config } : {};
    },
    refusedKinds: [],
    refusedKindsFor: (trigger) => (trigger.allowPublicWrites === true ? PUBLIC_REFUSED_KINDS : []),
    shape: '{ id, kind: "record", actionId, tableId, on: ["create" | "update" | "delete"], fields?, when?, allowPublicWrites?, enabled? }',
    description: 'record runs the action when a row of table tableId (a table of the app itself, not one linked to a Studio table) is created, updated or deleted; on lists the events. '
        + 'fields narrows update to changes of those fields; when is a formula that must be true, e.g. "trigger.record.row.status == \\"done\\"". '
        + 'The action reads the change under trigger.record (and trigger.kind is "record"): trigger.record.event, trigger.record.tableId, trigger.record.id, '
        + 'trigger.record.row (the row after the change; for a delete the row as it was), trigger.record.before (update and delete), trigger.record.changed (the changed fields), '
        + 'trigger.record.by ("member", "owner", "public", "trigger" or "webhook") and trigger.record.depth. '
        + 'It fires on a change a person makes in the app (a grid or form edit, a create_record / update_record / delete_record step by id) and on such a step of another trigger run. '
        + 'It does NOT fire on rows written by the builder tools (app_seed_records, app_update_records, app_run_action, app_run_tests), imports, template installs, connector sync, '
        + 'the mailbox hook, ai_extract, file_intake, a transaction step, or an update_record / delete_record with a filter. '
        + 'If visitors of a public page can write the table, the trigger needs allowPublicWrites: true and its action may then hold no send_email, run_automation, request_approval, delete_record or http_request step. '
        + 'The same holds further down a chain: a row written by a run that a visitor\'s write could start counts as a visitor\'s row for the next record trigger, '
        + 'and a record trigger that fires on a row a webhook run wrote runs no http_request. '
        + 'Loops end by themselves: a trigger never fires on a row its own run wrote, and a chain of trigger runs stops after 3. Runs come one at a time per trigger, in the order of the changes.',
};

export default record;
