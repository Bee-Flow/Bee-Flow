/**
 * What a script module becomes, decided before any step is written: the
 * answer of hubScripts.mts, ocsMatcher.mts and codeShim.mts, carried out by
 * modules/script.mts. Keeping the decision a plain value lets each matcher
 * stay pure and testable on its own.
 */

import type { WmInput } from './ir.mts';
import type { Seg } from './mapExpr.mts';
import type { Confidence } from './report.mts';

/** How a reference into the module's result reads on the Bee Flow step: new segments, or null (not known). */
export type Reshape = (segs: Seg[]) => { segs: Seg[]; medium?: boolean } | null;

export type ScriptPlan =
    | {
        kind: 'tool';
        tool: string;
        /** Bee Flow input name to the Windmill input it is filled from. */
        inputs: Record<string, WmInput>;
        /** Inputs with a value the converter fills itself (a literal it found). */
        fixed?: Record<string, unknown>;
        reshape: Reshape | null;
        status: 'mapped' | 'pattern';
        confidence: Confidence;
        reason: string;
        /** Windmill inputs that had no Bee Flow counterpart. */
        leftover?: string[];
        notes?: string[];
        /** Ids the user must pick again in this installation (a table, a calendar, a tag). */
        repick?: string[];
        /** Put the `values` input under this key (a Tables column title). */
        wrapValuesAs?: string;
        /** Take `tableId` from the step before that named a table. */
        tableFromContext?: boolean;
        /** Inputs built as an object of several Windmill inputs (a request body). */
        objects?: Record<string, Record<string, WmInput>>;
    }
    | { kind: 'ai_step'; prompt: string; inputs: Record<string, WmInput>; reason: string; confidence: Confidence; notes?: string[] }
    | { kind: 'code'; code: string; inputs: Record<string, WmInput>; allowedHosts: string[]; reason: string }
    | { kind: 'alias'; path: string; reason: string; reshape?: Reshape }
    | { kind: 'drop'; reason: string }
    | { kind: 'approval'; reason: string; prompt?: WmInput }
    | { kind: 'ai'; reason: string; title?: string }
    | { kind: 'unsupported'; reason: string };

/** A reshape that prefixes every reference with fixed segments. */
export function under(...prefix: string[]): Reshape {
    return (segs) => ({ segs: [...prefix.map((v) => ({ kind: 'name', v }) as Seg), ...segs] });
}

/** The result is the field itself (a Hub script returned a bare value). */
export function asField(field: string): Reshape {
    return (segs) => ({ segs: [{ kind: 'name', v: field }, ...segs] });
}
