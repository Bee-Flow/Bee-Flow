/**
 * Small pieces of "Suggest outputs" (RouteAssist.jsx) that speak the
 * condition_node vocabulary: the rule read back as a sentence (S3), the line
 * about what matches nothing (S5), and the files-inside note with its
 * "Check each attachment instead" button (S4).
 */
import { useCallback } from 'react';
import { appendKey, appendWildcard, pathKeys } from '@shared/expr/path.mjs';
import { singularKey } from '@shared/expr/rules.mjs';
import { useTranslation } from '../../../../../hooks/useTranslation';
import { useVariablePickerContext } from '../../mapping/VariablePickerContext';
import { humanizeFieldKey, ruleSentence } from '../displayHelpers';
import type { FilesInside } from './routeIntentsFiles';

type Translate = (key: string, fallback?: string, params?: Record<string, unknown>) => string;

/** The accept button of a suggestion: primary, so it reads as THE next step. */
// O1: the default --accent-primary is a mid grey (#9ca3af) that reads as a
// disabled button at this size; the inverted text colours are a filled button
// with full contrast in the light and the dark theme alike.
export const PRIMARY_BUTTON_CLASS = 'px-2.5 py-1 text-[11px] font-semibold rounded border border-transparent bg-[var(--text-primary)] text-[var(--bg-primary)] hover:opacity-90 transition';

/**
 * A rule as the sentence the canvas shows; "a custom rule" for a formula the
 * rule rows cannot show — never the expression itself.
 */
export function useRuleLine(): (expr: string) => string {
    const { t } = useTranslation() as { t: Translate };
    const picker = useVariablePickerContext() as { stepLabelById?: Map<string, string> } | null;
    const labels = picker?.stepLabelById ?? null;
    return useCallback(
        (expr: string) => ruleSentence(expr, labels, t) ?? t('condition_node.suggest.custom_rule', 'a custom rule'),
        [labels, t],
    );
}

/** A key as a word in a sentence: `attachments` → "attachments". */
const word = (key: string): string => String(humanizeFieldKey(key) || key).toLowerCase();

/** The last named key of a list path (`steps.a.output.messages` → `messages`); '' when none. */
function lastKey(path: string): string {
    const keys = (pathKeys(path) || []).filter((k: unknown) => k !== '*' && typeof k === 'string');
    return String(keys[keys.length - 1] ?? '');
}

/**
 * The sentence for a description that produced no outputs. Silence would
 * read as "still thinking", which — with no model behind it — it never is.
 */
export function SuggestProblem({ suggestion }: { suggestion: { problem?: string | null; problemCode?: string | null } }) {
    const { t } = useTranslation() as { t: Translate };
    if (!suggestion.problem) return null;
    return (
        <div className="text-[10px] text-amber-600 dark:text-amber-400">
            {suggestion.problemCode === 'name_types'
                ? t('condition_node.suggest.name_types', 'Name the file types to split by, for example “pdf, word and powerpoint”.')
                : suggestion.problem}
        </div>
    );
}

interface Counts {
    total: number;
    unmatched: number;
}

interface UnmatchedLineProps {
    counts: Counts;
    ruleCount: number;
    unit: string;
    /** One output that sends what it does not match to Otherwise (keep-rest). */
    keepRest?: boolean;
}

/** S5: what the sample rows that match no output do — go to Otherwise, or stop here. */
export function UnmatchedLine({ counts, ruleCount, unit, keepRest = false }: UnmatchedLineProps) {
    const { t } = useTranslation() as { t: Translate };
    // "0 of 4 … match none of these" says nothing: with every sample row placed, no line.
    if (!counts.unmatched) return null;
    const vars = { n: counts.unmatched, total: counts.total, unit };
    let line = t('condition_node.suggest.unmatched_one', '{n} of {total} sample {unit} don’t match and stop here.', vars);
    if (ruleCount > 1) {
        line = t('condition_node.suggest.unmatched_several', '{n} of {total} sample {unit} match none of these and go to “Otherwise”.', vars);
    } else if (keepRest) {
        line = t('condition_node.suggest.unmatched_one_keep', '{n} of {total} sample {unit} don’t match and go to “Otherwise”.', vars);
    }
    return <div className="text-[10px] text-[var(--text-tertiary)]">{line}</div>;
}

interface FilesInsideNoteProps {
    filesInside?: FilesInside | null;
    /** The list the node works through now (`steps.<id>.output.messages`). */
    sourceRef?: string;
    ruleCount: number;
    /** Does a row matching several outputs go down each (fan-out), or only the first? */
    fanOut?: boolean;
    /** Switches the node to the given list; absent where the surface cannot. */
    onWorkThroughList?: ((listPath: string) => void) | null;
}

/**
 * S4: the outputs look at the files INSIDE each item, so one mail with a PDF
 * and a Word file goes down both (or, on a first-match router, the first
 * output that matches) — said when there is more than one output —
 * and the way out: work through the files themselves. The button sets the
 * node's list to `<source>[*].<list>`; the typed sentence stays, so the box
 * suggests again against the files.
 */
export function FilesInsideNote({ filesInside, sourceRef = '', ruleCount, fanOut = true, onWorkThroughList = null }: FilesInsideNoteProps) {
    const { t } = useTranslation() as { t: Translate };
    if (!filesInside?.listKey || !sourceRef) return null;
    const list = word(filesInside.listKey);
    const name = word(singularKey(lastKey(sourceRef)) || 'item');
    const item = word(singularKey(filesInside.listKey));
    const target = appendKey(appendWildcard(sourceRef), filesInside.listKey);
    return (
        <div className="space-y-1">
            {ruleCount > 1 && (
                <div className="text-[10px] text-[var(--text-tertiary)]">
                    {fanOut
                        ? t('condition_node.suggest.files_inside', 'These outputs look at the {list} of each {name}: a {name} with a PDF and a Word file goes down both.', { list, name })
                        : t('condition_node.suggest.files_inside_first', 'These outputs look at the {list} of each {name}: a {name} with a PDF and a Word file goes down the first matching output only.', { list, name })}
                </div>
            )}
            {typeof onWorkThroughList === 'function' && (
                <div className="flex flex-wrap items-center gap-2">
                    <button
                        type="button"
                        onClick={() => onWorkThroughList(target)}
                        className="px-2 py-1 text-[11px] rounded border border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] transition"
                    >
                        {t('condition_node.suggest.check_each', 'Check each {item} instead', { item })}
                    </button>
                    <span className="text-[10px] text-[var(--text-tertiary)]">
                        {t('condition_node.suggest.check_each_note', 'Splits the {list} themselves, one by one.', { list })}
                    </span>
                </div>
            )}
        </div>
    );
}
