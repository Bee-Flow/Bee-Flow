import React from 'react';

import type { TranslateFn } from '../../../../../../../hooks/useTranslation';
import AddRow from '../../parts/AddRow';
import { LIMITS } from '../ownDataModel';
import type { Mark } from '../testBench';
import { makeSentence, scoreSentence } from '../testBench';
import type { WizardAction, WizardState } from '../useTypeWizard';
import TestSentence from './TestSentence';

/** The id of the "Add a sentence" field, so "Write my own" can put the cursor there. */
export const ADD_SENTENCE_ID = 'own-data-add-sentence';

/** Legend for the marks, so the colours are never the only signal. */
function Legend({ tested, t }: { tested: boolean; t: TranslateFn }) {
    const item = (cls: string, text: string) => (
        <span className="inline-flex items-center gap-1">
            <span aria-hidden="true" className={`inline-block w-5 h-2.5 rounded-sm ${cls}`} />
            {text}
        </span>
    );
    return (
        <p className="flex gap-3 flex-wrap m-0 text-[11px] text-[var(--text-tertiary)]">
            {tested ? (
                <>
                    {item('bg-[color-mix(in_srgb,var(--success)_30%,transparent)]', t('shield_data.legend_found', 'Found'))}
                    {item('border-b-2 border-dashed border-[var(--warning)]', t('shield_data.legend_missed', 'Missed'))}
                    {item('bg-[color-mix(in_srgb,var(--error)_20%,transparent)]', t('shield_data.legend_false_alarm', 'False alarm'))}
                    {item('bg-[color-mix(in_srgb,var(--info)_20%,transparent)]', t('shield_data.legend_unmarked', 'Found in a sentence you have not marked'))}
                </>
            ) : item('border-b-2 border-dashed border-[var(--text-tertiary)]', t('shield_data.legend_gold', 'Should be hidden'))}
            <span>{t('shield_data.legend_hint', 'Select text to mark it, or click a mark to change it.')}</span>
        </p>
    );
}

export function SentenceList({
    state, dispatch, t,
}: { state: WizardState; dispatch: React.Dispatch<WizardAction>; t: TranslateFn }) {
    const { sentences } = state.tests;
    const marksFor = (id: string): Mark[] | null => {
        const found = state.run?.found[id];
        const s = sentences.find(x => x.id === id);
        return found && s ? scoreSentence(s, found) : null;
    };
    const add = (text: string): string | null => {
        if (sentences.length >= LIMITS.sentences) return t('shield_data.sentences_full', 'You can keep up to 40 test sentences.');
        if (text.length > LIMITS.sentence) return t('shield_data.sentence_too_long', 'Keep a sentence under 300 characters.');
        dispatch({ type: 'add_sentences', sentences: [makeSentence(text, 'own')] });
        return null;
    };
    return (
        <section aria-labelledby="own-data-sentences" className="flex flex-col gap-2">
            <h4 id="own-data-sentences" className="text-xs font-semibold m-0 text-[var(--text-primary)]">
                {t('shield_data.sentences_title', 'Test sentences ({n} of 40)', { n: sentences.length })}
            </h4>
            <Legend tested={!!state.run} t={t} />
            {sentences.length > 0 && (
                <ul className="list-none p-0 m-0 rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)]">
                    {sentences.map(s => (
                        <TestSentence
                            key={s.id}
                            sentence={s}
                            marks={marksFor(s.id)}
                            onChange={sentence => dispatch({ type: 'replace_sentence', sentence })}
                            onRemove={() => dispatch({ type: 'remove_sentence', id: s.id })}
                            t={t}
                        />
                    ))}
                </ul>
            )}
            <div id={ADD_SENTENCE_ID}>
                <AddRow
                    onAdd={add}
                    placeholder={t('shield_data.add_sentence', 'Add a sentence')}
                    addLabel={t('shield_data.chip_add', 'Add')}
                    disabled={sentences.length >= LIMITS.sentences}
                    mono={false}
                />
            </div>
        </section>
    );
}

export default SentenceList;
