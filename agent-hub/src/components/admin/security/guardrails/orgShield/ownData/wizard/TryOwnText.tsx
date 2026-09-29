import { FlaskConical, Plus } from 'lucide-react';
import React, { useId, useState } from 'react';

import Button from '../../../../../../shared/Button';
import Disclosure from '../../../../../../shared/Disclosure';
import { customDataErrorCode, useTestMutation } from '../../../../../../../api/queries/customData';
import { errorLine } from '../ownDataCopy';
import type { Span } from '../ownDataModel';
import { LIMITS, resolveType } from '../ownDataModel';
import {
    foundSpansOf, makeSentence, normaliseSpans, scoreSentence,
} from '../testBench';
import { helpClass, inputClass, labelClass } from './fieldStyles';
import type { StepProps } from './stepTypes';
import { DegradedNote, MarkedText } from './TestSentence';

/**
 * Paste any sentence and see what this type, as it stands now, would hide,
 * and what the AI would read instead. Nothing is marked beforehand, so a
 * find is just a find. A sentence worth keeping goes into the test set with
 * its finds already marked, to confirm or correct there.
 */
export function TryOwnText({ state, dispatch, ctx, t }: StepProps) {
    const id = useId();
    const [text, setText] = useState('');
    const [result, setResult] = useState<{ text: string; found: Span[]; preview: string | null; degraded: boolean } | null>(null);
    const test = useTestMutation(ctx.orgId);
    const aiBlocked = state.type.method === 'ai' && ctx.guardDown;

    const run = async () => {
        const sentence = text.trim().slice(0, LIMITS.sentence);
        try {
            const res = await test.mutateAsync({
                type: resolveType(state.type),
                // No `gold`: nothing is marked, so a find is just a find.
                sentences: [{ id: 'try', text: sentence, origin: 'own' }],
            });
            const marks = res.results.find(r => r.id === 'try')?.marks || [];
            setResult({ text: sentence, found: normaliseSpans(foundSpansOf(marks), sentence.length), preview: res.preview, degraded: res.degraded });
        } catch {
            setResult(null);
        }
    };
    const keep = () => {
        if (!result) return;
        // Pre-marked with what was found, to confirm or correct in the list.
        // Nothing found: left unmarked, since "nothing should be hidden" is
        // the admin's call, not ours.
        const gold = result.found.length ? result.found.slice(0, LIMITS.gold) : undefined;
        dispatch({ type: 'add_sentences', sentences: [makeSentence(result.text, 'feedback', gold)] });
        setResult(null);
        setText('');
    };

    const marks = result ? scoreSentence({ id: 'try', text: result.text, origin: 'own' }, result.found) : [];
    return (
        <Disclosure variant="card" title={t('shield_data.try_title', 'Try your own text')}>
            <label htmlFor={id} className={labelClass}>{t('shield_data.try_label', 'Paste a sentence to see what would be hidden.')}</label>
            <textarea id={id} rows={2} value={text} maxLength={LIMITS.sentence} onChange={e => setText(e.target.value)} className={`${inputClass} resize-y`} />
            <span className="flex gap-2 mt-2">
                <Button size="sm" variant="secondary" icon={FlaskConical} onClick={run} disabled={!text.trim() || aiBlocked} busy={test.isPending}>
                    {t('shield_data.try_run', 'Try')}
                </Button>
            </span>
            {test.error && <p role="alert" className="m-0 mt-1 text-[11px] text-[var(--error-ink)]">{errorLine(customDataErrorCode(test.error), t)}</p>}
            {result && (
                <div className="mt-3 flex flex-col gap-2" aria-live="polite">
                    <MarkedText text={result.text} marks={marks} t={t} />
                    {result.degraded && <DegradedNote t={t} />}
                    {marks.length === 0 && <p className={helpClass}>{t('shield_data.try_nothing', 'Nothing in this sentence would be hidden.')}</p>}
                    {result.preview !== null && (
                        <p className="m-0 text-xs text-[var(--text-secondary)]">
                            <span className="font-semibold">{t('shield_data.try_ai_sees', 'The AI would see:')}</span>{' '}
                            <span className="text-[var(--text-primary)]">{result.preview}</span>
                        </p>
                    )}
                    <span>
                        <Button size="sm" variant="ghost" icon={Plus} onClick={keep}>{t('shield_data.try_keep', 'Add to the test sentences')}</Button>
                    </span>
                </div>
            )}
        </Disclosure>
    );
}

export default TryOwnText;
