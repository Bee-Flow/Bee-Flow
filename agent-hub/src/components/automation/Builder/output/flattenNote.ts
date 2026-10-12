import { flattenSentenceParts } from '@shared/expr/flatten.mjs';
import type { TranslateFn } from '../../../../hooks/useTranslation';

/**
 * A flatten's run in one sentence (spec F49), in place of its Count / Input
 * count / Empty count numbers:
 *  - "Made 64 rows from 4 messages.";
 *  - plus "1 of them had no lines and made no row." (or, with keepEmpty,
 *    "… and got one row without line details.");
 *  - a skip: "None of the 4 messages has a list called attachments, so there
 *    was nothing to flatten.";
 *  - an empty input: "The list was empty, so there are no rows."
 *
 * The nouns are the data's own keys, humanised by the shared
 * flattenSentenceParts (mobile builds its sentence on the same parts).
 */
export function flattenSentence(output: unknown, step: unknown, t: TranslateFn): string {
    const p = flattenSentenceParts(output, step);
    if (p.kind === 'no_match') {
        return t('flatten_node.run.no_match', 'None of the {inputCount} {parents} has a list called {children}, so there was nothing to flatten.', {
            inputCount: p.inputCount, parents: p.parents, children: p.children,
        });
    }
    if (p.kind === 'empty') return t('flatten_node.run.empty_input', 'The list was empty, so there are no rows.');
    const madeVars = { count: p.count, inputCount: p.inputCount, parents: p.parents };
    const made = p.count === 1
        ? t('flatten_node.run.made', 'Made {count} row from {inputCount} {parents}.', madeVars)
        : t('flatten_node.run.made_plural', 'Made {count} rows from {inputCount} {parents}.', madeVars);
    if (p.emptyCount <= 0) return made;
    return `${made} ${emptySentence(p, t)}`;
}

/** "1 of them had no lines and made no row." (plural is a key choice). */
function emptySentence(p: ReturnType<typeof flattenSentenceParts>, t: TranslateFn): string {
    const vars = { emptyCount: p.emptyCount, children: p.children, child: p.child };
    const one = p.emptyCount === 1;
    if (p.keepEmpty) {
        return one
            ? t('flatten_node.run.empty_kept', '{emptyCount} of them had no {children} and got one row without {child} details.', vars)
            : t('flatten_node.run.empty_kept_plural', '{emptyCount} of them had no {children} and each got one row without {child} details.', vars);
    }
    return one
        ? t('flatten_node.run.empty_dropped', '{emptyCount} of them had no {children} and made no row.', vars)
        : t('flatten_node.run.empty_dropped_plural', '{emptyCount} of them had no {children} and made no rows.', vars);
}
