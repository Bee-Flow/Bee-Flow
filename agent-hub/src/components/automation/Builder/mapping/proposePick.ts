/**
 * The pick decision for a slot that wants ONE value (expectShape 'scalar'),
 * as data, so the web builder and the phone make the same one
 * (mobile bindings/mismatch.ts proposePickBinding): which path goes in — a
 * table's column or a record's field when the slot's name or kind says which —
 * and, when what is picked still does not fit, the remedy written without
 * asking (mismatch.quietDefaultId: a list into text is joined, into a number
 * its first, a table "as a table", a group its summary).
 *
 * Pure and React-free; the remedies themselves live in mismatch.js.
 */
import { pathListShape } from './listShape';
import { columnForSlot, detectMismatch, fieldForSlot, kindAtPath, quietDefaultId, remediesFor } from './mismatch';
import { canonicalRefPath } from '../../../../utils/bindingHelpers';

export interface PickRemedy {
    id: string;
    binding?: unknown;
    [key: string]: unknown;
}

export interface PickRemedies {
    primary: PickRemedy[];
    more: PickRemedy[];
    defaultId?: string;
    [key: string]: unknown;
}

export interface PickOpts {
    slot?: string | null;
    expectKind?: string | null;
    expectShape?: string;
    allowForEach?: boolean;
}

export interface PickDecision {
    path: string;
    actualKind: string | null;
    expectedKind: string | null;
    /** Null: insert `path` as it is. */
    remedy: PickRemedy | null;
    remedies: PickRemedies | null;
}

// mismatch.js is untyped JS whose defaults (`slot = null`) read as narrower
// types than it accepts; these are the signatures it really has.
type SlotPick = (path: string, sampleRoot: unknown, opts: { slot?: string | null; expectedKind?: string }) => string | null;
type PickCtx = { path: string; actualKind: string | null; expectedKind: string };
const columnFor = columnForSlot as unknown as SlotPick;
const fieldFor = fieldForSlot as unknown as SlotPick;
const remediesAt = remediesFor as unknown as (path: string, sampleRoot: unknown, opts: { allowForEach?: boolean; actualKind?: string }) => PickRemedies;
const quietIdOf = quietDefaultId as unknown as (remedies: PickRemedies, ctx: PickCtx) => string | undefined;

/** Narrow a whole table to its column, or a whole record to its field, when the slot says which. */
function narrowPick(path: string, sampleRoot: unknown, slot: string | null, expectKind: string | null) {
    let clean = path;
    let actualKind: string | null = kindAtPath(clean, sampleRoot);
    // A whole table on a number / date / yes-no / e-mail slot means one of
    // its columns (accountId ← Id); as a Markdown table it would fail the run.
    if (actualKind === 'table') {
        const col = columnFor(clean, sampleRoot, { slot, expectedKind: expectKind ?? undefined });
        if (col) { clean = col; actualKind = kindAtPath(col, sampleRoot); }
    }
    // A whole record on a title / an e-mail slot means one of its fields
    // (title ← name); the readable summary stays for a body or description.
    if (actualKind === 'group') {
        const field = fieldFor(clean, sampleRoot, { slot, expectedKind: expectKind ?? undefined });
        if (field) { clean = field; actualKind = kindAtPath(field, sampleRoot); }
    }
    return { clean, actualKind };
}

/** The remedy written without asking: the quiet default, else the remedies' own default, else the first. */
function quietRemedy(remedies: PickRemedies, ctx: PickCtx): PickRemedy | null {
    const all = [...remedies.primary, ...remedies.more];
    const quiet = quietIdOf(remedies, ctx);
    return all.find(r => r.id === quiet) || all.find(r => r.id === remedies.defaultId) || remedies.primary[0] || null;
}

/** Which path goes in for a pick, and the remedy written without asking (null: as it is). */
export function proposePickBinding(path: unknown, sampleRoot: unknown, opts: PickOpts = {}): PickDecision {
    const picked = canonicalRefPath(String(path || '').trim());
    if (!picked || opts.expectShape !== 'scalar') return { path: picked, actualKind: null, expectedKind: null, remedy: null, remedies: null };
    const expectKind = opts.expectKind ?? null;
    const { clean, actualKind } = narrowPick(picked, sampleRoot, opts.slot ?? null, expectKind);
    // A scalar slot with no declared kind still wants ONE value; 'text' is the
    // widest scalar, so it never asks a narrower question than the shape rule.
    const expectedKind = expectKind && expectKind !== 'unknown' ? expectKind : 'text';
    const decided: PickDecision = { path: clean, actualKind, expectedKind, remedy: null, remedies: null };
    const mm = detectMismatch({ actualKind, expectedKind });
    if (!mm || (mm.code === 'list_into_one' && !pathListShape(clean, sampleRoot))) return decided;
    const remedies = remediesAt(clean, sampleRoot, { allowForEach: !!opts.allowForEach, actualKind: actualKind ?? undefined });
    return { ...decided, remedy: quietRemedy(remedies, { path: clean, actualKind, expectedKind }), remedies };
}
