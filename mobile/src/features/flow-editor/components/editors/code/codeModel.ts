/**
 * The code step, the pure half of the web's CodeFields
 * (actionEditors/codeFields.tsx; the reader is codeStep/readCodeContract.ts,
 * the round trip codeStep/CodeSourceBlock.tsx): the contract read back off
 * the author's own code (which inputs it reads, which connected apps it
 * calls, whether it fetches, logs or asks for secrets), whether the step's
 * `inputs` survive a save, and why a code step would be refused here at all.
 * A READER, not a parser: it matches the source as written. Pinned by
 * code.lockstep.test.ts.
 */

import { buildPatch, extractFormState } from '@/features/flow-editor/formState';
import { CODE_OFF_REASONS } from '@/features/flow-editor/model';

import { msg, type Msg } from '../declarative/spec';

const INPUT_DOT = /\binputs\s*\.\s*([A-Za-z_$][\w$]*)/g;
const INPUT_BRACKET = /\binputs\s*\[\s*['"]([^'"]+)['"]\s*\]/g;
const INPUT_DESTRUCTURE = /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*inputs\b/g;
const INPUT_COMPUTED = /\binputs\s*\[\s*(?!['"])/;
const TOOL_DOT = /\bctx\s*\.\s*integrations\s*\.\s*([A-Za-z_$][\w$]*)/g;
const TOOL_BRACKET = /\bctx\s*\.\s*integrations\s*\[\s*['"]([^'"]+)['"]\s*\]/g;
const USES_HTTP = /\bctx\s*\.\s*http\s*\(/;
const USES_SECRETS = /\bctx\s*\.\s*secrets\s*\(/;
const USES_LOG = /\bctx\s*\.\s*log\s*\(/;

export interface CodeContract {
    inputNames: string[];
    /** `inputs[key]` with a variable key, or `...rest`: the list of names is a floor, not the whole. */
    computedInputs: boolean;
    toolNames: string[];
    usesHttp: boolean;
    usesSecrets: boolean;
    usesLog: boolean;
}

function destructured(src: string, names: Set<string>): boolean {
    let rest = false;
    for (const m of src.matchAll(INPUT_DESTRUCTURE)) {
        for (const part of (m[1] as string).split(',')) {
            const name = (part.split(':')[0] as string).split('=')[0]?.trim() ?? '';
            if (!name) continue;
            if (name.startsWith('...')) {
                rest = true;
                continue;
            }
            if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
        }
    }
    return rest;
}

export function readCodeContract(code: unknown = ''): CodeContract {
    const src = typeof code === 'string' ? code : '';
    const inputNames = new Set<string>();
    for (const m of src.matchAll(INPUT_DOT)) inputNames.add(m[1] as string);
    for (const m of src.matchAll(INPUT_BRACKET)) inputNames.add(m[1] as string);
    const rest = destructured(src, inputNames);
    const toolNames = new Set<string>();
    for (const m of src.matchAll(TOOL_DOT)) toolNames.add(m[1] as string);
    for (const m of src.matchAll(TOOL_BRACKET)) toolNames.add(m[1] as string);
    return {
        inputNames: [...inputNames].sort(),
        computedInputs: INPUT_COMPUTED.test(src) || rest,
        toolNames: [...toolNames].sort(),
        usesHttp: USES_HTTP.test(src),
        usesSecrets: USES_SECRETS.test(src),
        usesLog: USES_LOG.test(src),
    };
}

/**
 * Do a code step's `inputs` survive the form's round trip? Asked, not assumed:
 * a table whose rows the save drops would lose the author's input on reopen
 * with no error anywhere. Both halves, the write half with a CHANGED draft.
 */
export function codeInputsRoundTrip(): boolean {
    const probe = { id: 'probe_code', type: 'code', code: '', inputs: { probe_key: { kind: 'literal', value: 'x' } } };
    try {
        const draft = extractFormState(probe);
        const read = (draft.inputs as Record<string, unknown> | undefined)?.probe_key;
        if (!read) return false;
        const edited = { ...draft, inputs: { probe_key: { kind: 'literal', value: 'y' } } };
        const sent = buildPatch(probe, edited).inputs as Record<string, { value?: unknown }> | undefined;
        return sent?.probe_key?.value === 'y';
    } catch {
        return false;
    }
}

/**
 * Why a code step would be refused for this caller, or null: the server's
 * `flags.code` must be the literal `true`; otherwise its `codeReason` says
 * which gate said no. No reason at all is no claim (an older server).
 */
export function codeRefusal(flags: { code?: unknown; codeReason?: unknown } | null | undefined): Msg | null {
    if (!flags || flags.code === true) return null;
    const reason = typeof flags.codeReason === 'string' ? flags.codeReason : '';
    if (!reason) return null;
    const known = Object.prototype.hasOwnProperty.call(CODE_OFF_REASONS, reason) ? reason : 'unknown';
    return msg(`mobile.flow.palette.code_off_${known}`, CODE_OFF_REASONS[known] as string);
}
