import type { TranslateFn } from '../../../../../../hooks/useTranslation';
import type { CustomDataErrorCode } from '../../../../../../api/queries/customData';
import type { CustomDataType, TokenKeyProblem, TypeStatus, Verdict } from './ownDataModel';
import type { DescribeProblem, TuneInfo } from './useTypeWizard';

/**
 * The words for "Your own data": every code the model and the API return,
 * turned into a plain sentence for a non-technical admin. One module so the
 * list, the locked view and the wizard never word the same state twice.
 *
 * Plurals are a KEY choice (`_plural`), never string surgery.
 */

/**
 * The pipeline strip's read-out for "Your own data". Warn-toned when a type
 * is stored but not in force (invalid), or when an AI type exists while the
 * detection service is down, because then that type finds nothing.
 */
export function ownDataSummary(
    types: readonly CustomDataType[] | undefined,
    { licensed, guard, t }: { licensed: boolean; guard: { configured?: boolean; reachable?: boolean } | null; t: TranslateFn },
): { text: string; tone?: 'warn' } {
    const list = types || [];
    const guardDown = !!guard && (guard.configured === false || guard.reachable === false);
    const warn = list.some(x => x.status === 'invalid' || !!x.pattern?.error) || (guardDown && list.some(x => x.method === 'ai'));
    let text: string;
    if (licensed) {
        const n = list.length;
        if (n === 0) text = t('shield_data.summary_none', 'none yet');
        else text = n === 1 ? t('shield_data.summary_types', '{n} type', { n }) : t('shield_data.summary_types_plural', '{n} types', { n });
    } else {
        text = list.length === 0
            ? t('license.enterprise', 'Enterprise')
            : t('shield_data.summary_readonly', '{n} · read-only', { n: list.length });
    }
    return warn ? { text, tone: 'warn' } : { text };
}

export function placeholderOf(tokenKey: string): string {
    return `[${tokenKey || 'your_type'}_1]`;
}

export function methodLine(type: CustomDataType, t: TranslateFn): string {
    if (type.method === 'pattern') return t('shield_data.method_pattern', 'A fixed format');
    if (type.method === 'ai') return t('shield_data.method_ai', 'Recognised by AI');
    const n = (type.words?.values || []).length;
    return n === 1
        ? t('shield_data.method_words_short', 'A list of words · {n} word', { n })
        : t('shield_data.method_words_short_plural', 'A list of words · {n} words', { n });
}

export function findsLine(found: number, total: number, t: TranslateFn): string {
    return t('shield_data.finds', 'Finds {found} of {total}', { found, total });
}

export function falseAlarmsLine(n: number, t: TranslateFn): string {
    if (n === 0) return t('shield_data.false_alarms_none', 'no false alarms');
    return n === 1
        ? t('shield_data.false_alarms', '{n} false alarm', { n })
        : t('shield_data.false_alarms_plural', '{n} false alarms', { n });
}

export function statusLine(status: TypeStatus, t: TranslateFn): string {
    switch (status.kind) {
    case 'invalid':
        return status.reason
            ? t('shield_data.status_invalid', 'Pattern does not work: {reason}', { reason: status.reason })
            : t('shield_data.status_invalid_plain', 'Does not work. Edit it to fix it.');
    case 'paused':
        return t('shield_data.status_paused', 'Paused. Needs Enterprise.');
    case 'untested':
        return t('shield_data.status_untested', 'Not tested yet');
    case 'stale':
        return t('shield_data.status_stale', 'Changed since the last test');
    default:
        return `${findsLine(status.found, status.total, t)} · ${falseAlarmsLine(status.falseAlarms, t)}`;
    }
}

export function verdictLine(verdict: Verdict, t: TranslateFn): string {
    switch (verdict) {
    case 'no_gold':
        return t('shield_data.verdict_no_gold', 'Add a sentence that contains it, so we can check it is found.');
    case 'perfect':
        return t('shield_data.verdict_perfect', 'Works on all your test sentences.');
    case 'good':
        return t('shield_data.verdict_good', 'Good enough to use.');
    case 'misses':
        return t('shield_data.verdict_misses', 'It misses some. Press Tune, or add more examples.');
    default:
        return t('shield_data.verdict_too_much', 'It finds too much. Press Tune, or mark the false alarms.');
    }
}

export function tokenProblemLine(problem: TokenKeyProblem, t: TranslateFn): string {
    if (problem === 'reserved') return t('shield_data.token_reserved', 'This placeholder is already used for a built-in kind of data. Pick another one.');
    if (problem === 'taken') return t('shield_data.token_taken', 'Another type already uses this placeholder. Pick another one.');
    return t('shield_data.token_format', 'Use lower-case letters, digits and _ only. Start and end with a letter.');
}

export function describeProblemLine(problem: DescribeProblem, t: TranslateFn): string {
    switch (problem) {
    case 'name_missing': return t('shield_data.problem_name', 'Give it a name.');
    case 'token_format': return tokenProblemLine('format', t);
    case 'token_reserved': return tokenProblemLine('reserved', t);
    case 'token_taken': return tokenProblemLine('taken', t);
    case 'method_missing': return t('shield_data.problem_method', 'Choose how we should recognise it.');
    case 'words_missing': return t('shield_data.problem_words', 'Add at least one word.');
    case 'pattern_missing': return t('shield_data.problem_pattern', 'Add a few examples, or write the pattern yourself.');
    case 'pattern_invalid': return t('shield_data.problem_pattern_invalid', 'The pattern does not work yet. Check it under "Write the pattern yourself".');
    case 'ai_unavailable': return t('shield_data.ai_needs_guard', 'Needs the detection service, which is not running.');
    default: return t('shield_data.problem_ai_limit', 'You already have 6 types recognised by AI. That is the most there can be.');
    }
}

/** A failed call, in words. Codes the page does not know read as "try again". */
export function errorLine(code: CustomDataErrorCode, t: TranslateFn): string {
    switch (code) {
    case 'assist_check_unavailable':
    case 'no_assist_model':
    case 'assist_failed':
    case 'assist_no_usable_output':
        return t('shield_data.assist_unavailable', 'The assistant is not available right now. You can still write your own test sentences.');
    case 'guard_unavailable':
        return t('shield_data.test_ai_guard_down', "AI recognition can't be tested while the detection service is not running.");
    case 'feature_locked':
        return t('shield_data.error_locked', 'This needs Enterprise.');
    case 'not_org_admin':
        return t('shield_data.error_not_admin', 'Only an administrator of this organisation can do this.');
    case 'pattern_unsafe':
        return t('shield_data.error_pattern_unsafe', 'This pattern could make the check very slow, so it is not allowed. Try a simpler one.');
    case 'tune_needs_gold':
        return t('shield_data.tune_needs_gold', 'Mark what should be hidden in at least 5 sentences first.');
    case 'rate_limited':
        return t('shield_data.error_rate_limited', 'That was a lot of tries in a short time. Wait a minute, then try again.');
    default:
        return t('shield_data.error_generic', 'That did not work. Try again in a moment.');
    }
}

function sensitivityWord(s: 'low' | 'medium' | 'high', t: TranslateFn): string {
    if (s === 'low') return t('shield_data.sensitivity_low', 'low');
    if (s === 'high') return t('shield_data.sensitivity_high', 'high');
    return t('shield_data.sensitivity_medium', 'medium');
}

function wordsFlagsLine(d: TuneInfo['describe'], t: TranslateFn): string {
    if (d.wholeWord !== false && d.caseSensitive) return t('shield_data.tuned_words_whole_case', 'We now match whole words, with exact upper and lower case.');
    if (d.wholeWord !== false) return t('shield_data.tuned_words_whole', 'We now match whole words only.');
    if (d.caseSensitive) return t('shield_data.tuned_words_case', 'We now match exact upper and lower case, also inside longer words.');
    return t('shield_data.tuned_words_inside', 'We now also match inside longer words.');
}

/** The one line that says what tuning changed, from the server's `describe`. */
export function tuneDescribeLine(info: TuneInfo, t: TranslateFn): string {
    const d = info.describe;
    if (info.method === 'ai') {
        return t('shield_data.tuned_ai', 'We now look for “{label}” at {sensitivity} sensitivity.', {
            label: d.label || '',
            sensitivity: sensitivityWord(d.sensitivity || 'medium', t),
        });
    }
    if (info.method === 'pattern') {
        return t('shield_data.tuned_pattern', 'We now use: {pattern}.', { pattern: d.patternWords || '' });
    }
    return wordsFlagsLine(d, t);
}
