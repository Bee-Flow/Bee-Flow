// Assertions and their results in plain language. The server sends codes and
// parameters, never sentences; the words live here, in the viewer's language.

import type { Assertion, AssertionOp, AssertionResult, TestStatus } from '../../../../../../api/queries/automation/testCases';
import type { TranslateFn } from '../../../../../../hooks/useTranslation';

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** "the whole result" for an empty path, else the path itself. */
function pathLabel(t: TranslateFn, path: string): string {
    const p = (path || '').trim();
    return p && p !== '$' ? p : t('automation_testing.path.whole', 'the whole result');
}

/** A JSON text from the server without its outer quotes, for a type name or a key. */
const unquote = (s: string | undefined): string => {
    const text = s ?? '';
    return /^".*"$/.test(text) ? text.slice(1, -1) : text;
};

export const typeName = (t: TranslateFn, name: string): string => {
    const known: Record<string, string> = {
        string: t('automation_testing.type.string', 'text'),
        number: t('automation_testing.type.number', 'a number'),
        boolean: t('automation_testing.type.boolean', 'true or false'),
        object: t('automation_testing.type.object', 'an object'),
        array: t('automation_testing.type.array', 'a list'),
        null: t('automation_testing.type.null', 'empty'),
    };
    return known[name] ?? name;
};

/** "at least 3 entries" for {cmp, n}. */
function countPhrase(t: TranslateFn, value: unknown): string {
    const v = isRecord(value) ? value : {};
    const n = typeof v.n === 'number' ? v.n : 0;
    if (v.cmp === 'gte') return t('automation_testing.count.gte', 'at least {n} entries', { n });
    if (v.cmp === 'lte') return t('automation_testing.count.lte', 'at most {n} entries', { n });
    return t('automation_testing.count.eq', 'exactly {n} entries', { n });
}

const show = (value: unknown): string => {
    if (typeof value === 'string') return `"${value}"`;
    try { return JSON.stringify(value) ?? ''; } catch { return String(value); }
};

/** One assertion as a sentence: "items has at least 3 entries". */
export function assertionSentence(t: TranslateFn, a: Assertion): string {
    const path = pathLabel(t, a.path);
    switch (a.op) {
        case 'equals': return t('automation_testing.sentence.equals', '{path} is exactly {value}', { path, value: show(a.value) });
        case 'not_equals': return t('automation_testing.sentence.not_equals', '{path} is not {value}', { path, value: show(a.value) });
        case 'contains': return t('automation_testing.sentence.contains', '{path} contains {value}', { path, value: show(a.value) });
        case 'has_key': return t('automation_testing.sentence.has_key', '{path} has the field {value}', { path, value: String(a.value ?? '') });
        case 'type_is': return t('automation_testing.sentence.type_is', '{path} is {type}', { path, type: typeName(t, String(a.value)) });
        case 'count_is': return t('automation_testing.sentence.count_is', '{path} has {count}', { path, count: countPhrase(t, a.value) });
    }
}

/** Why an assertion failed, as a sentence: "Expected items to have 3 entries, got 2". */
export function failureSentence(t: TranslateFn, r: AssertionResult, a?: Assertion): string {
    const path = pathLabel(t, r.params.path);
    const expected = r.params.expected ?? '';
    const actual = r.params.actual ?? '';
    switch (r.code) {
        case 'path_missing':
            return t('automation_testing.fail.path_missing', 'Expected something at {path}, but there is nothing there.', { path });
        case 'not_equal':
            return t('automation_testing.fail.not_equal', 'Expected {path} to be {expected}, got {actual}.', { path, expected, actual });
        case 'equal':
            return t('automation_testing.fail.equal', 'Expected {path} not to be {expected}, but it is.', { path, expected });
        case 'not_contained':
            return t('automation_testing.fail.not_contained', 'Expected {path} to contain {expected}, got {actual}.', { path, expected, actual });
        case 'key_missing':
            return t('automation_testing.fail.key_missing', 'Expected {path} to have the field {expected}, but it does not.', { path, expected: unquote(expected) });
        case 'wrong_count': {
            let wanted: unknown = a?.value;
            try { wanted = JSON.parse(expected); } catch { wanted = a?.value; }
            return t('automation_testing.fail.wrong_count', 'Expected {path} to have {count}, got {actual}.', { path, count: countPhrase(t, wanted), actual });
        }
        case 'not_countable':
            return t('automation_testing.fail.not_countable', 'Cannot count the entries of {path}: it is {actual}.', { path, actual: typeName(t, unquote(actual)) });
        case 'wrong_type': {
            const want = unquote(expected);
            return t('automation_testing.fail.wrong_type', 'Expected {path} to be {expected}, got {actual}.', {
                path, expected: typeName(t, want), actual: typeName(t, unquote(actual)),
            });
        }
        default:
            return t('automation_testing.fail.other', 'The check on {path} did not hold.', { path });
    }
}

export const STATUS_LABEL: Record<TestStatus | 'never', [string, string]> = {
    pass: ['automation_testing.status.pass', 'Passed'],
    fail: ['automation_testing.status.fail', 'Failed'],
    error: ['automation_testing.status.error', 'Error'],
    unusable: ['automation_testing.status.unusable', 'Cannot run'],
    never: ['automation_testing.status.never', 'Not run yet'],
};

/** Why a case could not give a verdict, in a sentence. */
export function reasonSentence(t: TranslateFn, reason: string | null, message: string | null): string {
    switch (reason) {
        case 'fixture_expired':
            return t('automation_testing.reason.fixture_expired', 'The run this input came from was deleted, so the test cannot run. Edit it to type values or pick another run.');
        case 'code_syntax_error':
            return t('automation_testing.reason.code_syntax_error', 'The code has a syntax error, so nothing could run. The Checks tab shows where.');
        case 'code_blocked':
            return t('automation_testing.reason.code_blocked', 'A check blocks this code from running. The Checks tab says which.');
        case 'code_param_invalid':
            return t('automation_testing.reason.code_param_invalid', 'A value in this test does not fit what the code asks for: {message}', { message: message || '' });
        case 'sandbox_missing':
            return t('automation_testing.reason.sandbox_missing', 'The sandbox that runs code is not available on this server.');
        default:
            return message || t('automation_testing.reason.other', 'The test could not run.');
    }
}

/** What the server refused, in words the person can act on, by its code. */
export function serverRefusal(t: TranslateFn, code: string | null, fallback: string): string {
    switch (code) {
        case 'test_case_limit': return t('automation_testing.error.test_case_limit', 'This step has reached the number of tests it can keep. Delete one first.');
        case 'test_data_not_on_prd': return t('automation_testing.error.test_data_not_on_prd', 'Test data is not kept for automations in a production stage.');
        case 'caller_run_not_capturable': return t('automation_testing.error.caller_run_not_capturable', 'That run used the connections of the person who started it, so its data cannot be saved as test data.');
        case 'fixture_too_large': return t('automation_testing.error.fixture_too_large', 'The input of this step in that run is too large to keep as test data.');
        case 'fixture_truncated': return t('automation_testing.error.fixture_truncated', 'The input of this step was too large to be recorded in full in that run, so it cannot be used.');
        case 'step_not_in_run': return t('automation_testing.error.step_not_in_run', 'This step has no recorded input in that run. Pick a run where it ran.');
        case 'run_not_finished': return t('automation_testing.error.run_not_finished', 'That run has not finished yet. Pick a finished run.');
        case 'run_not_found': return t('automation_testing.error.run_not_found', 'That run could not be found.');
        default: return fallback;
    }
}

/** The operation's name in the drop-down. */
export function opLabel(t: TranslateFn, op: AssertionOp): string {
    return ({
        equals: t('automation_testing.op.equals', 'is exactly'),
        not_equals: t('automation_testing.op.not_equals', 'is not'),
        contains: t('automation_testing.op.contains', 'contains'),
        has_key: t('automation_testing.op.has_key', 'has the field'),
        type_is: t('automation_testing.op.type_is', 'is of type'),
        count_is: t('automation_testing.op.count_is', 'has this many items'),
    })[op];
}

/** The help line under a check's value box. */
export function valueHelp(t: TranslateFn, op: AssertionOp): string {
    if (op === 'has_key') return t('automation_testing.value_help.key', 'The name of a field the result must have.');
    if (op === 'type_is') return t('automation_testing.value_help.type', 'What kind of value must be there.');
    if (op === 'count_is') return t('automation_testing.value_help.count', 'How many entries a list has, how many characters a text has, or how many fields an object has.');
    return t('automation_testing.value_help.json', 'Type a number, true or false, a list or an object as it is. Anything else is taken as text; put text that looks like a number in quotes.');
}
