import { Lock } from 'lucide-react';
import React, { useId, useState } from 'react';

import Button from '../../../../../../shared/Button';
import Disclosure from '../../../../../../shared/Disclosure';
import Toggle from '../../../../../../shared/Toggle';
import type { TranslateFn } from '../../../../../../../hooks/useTranslation';
import { LIMITS } from '../ownDataModel';
import { checkPattern, inferPattern } from '../patternCheck';
import { LinkButton, Note } from '../ui';
import ChipList from './ChipList';
import { helpClass, inputClass, labelClass } from './fieldStyles';
import type { StepProps } from './stepTypes';

/**
 * The inputs that depend on the method: the words themselves, or the real
 * examples a fixed format or an AI type is tested with.
 */

function PasteList({ onAdd, t }: { onAdd: (values: string[]) => void; t: TranslateFn }) {
    const [open, setOpen] = useState(false);
    const [text, setText] = useState('');
    const id = useId();
    if (!open) return <LinkButton onClick={() => setOpen(true)}>{t('shield_data.paste_list', 'Paste a list')}</LinkButton>;
    return (
        <div className="flex flex-col gap-1.5">
            <label htmlFor={id} className={labelClass}>{t('shield_data.paste_label', 'One per line')}</label>
            <textarea id={id} rows={4} value={text} onChange={e => setText(e.target.value)} className={`${inputClass} resize-y`} />
            <span className="flex gap-2">
                <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => { onAdd(text.split(/\r?\n/)); setText(''); setOpen(false); }}
                >
                    {t('shield_data.paste_add', 'Add these')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>{t('common.cancel', 'Cancel')}</Button>
            </span>
        </div>
    );
}

function WordsInputs({ state, dispatch, t }: StepProps) {
    const words = state.type.words || { values: [], caseSensitive: false, wholeWord: true };
    const setValues = (values: string[]) => dispatch({ type: 'patch_block', block: 'words', patch: { values } });
    const addMany = (lines: string[]) => {
        const seen = new Set(words.values.map(v => v.toLowerCase()));
        const next = [...words.values];
        for (const raw of lines) {
            const v = raw.trim().slice(0, LIMITS.word);
            if (v && !seen.has(v.toLowerCase()) && next.length < LIMITS.words) { next.push(v); seen.add(v.toLowerCase()); }
        }
        setValues(next);
    };
    return (
        <div className="flex flex-col gap-3">
            <ChipList
                label={t('shield_data.words_label', 'The words')}
                values={words.values}
                onChange={setValues}
                max={LIMITS.words}
                maxLen={LIMITS.word}
                placeholder={t('shield_data.words_placeholder', 'Type a word and press Enter')}
                caseSensitive={words.caseSensitive}
                t={t}
            />
            <PasteList onAdd={addMany} t={t} />
            <div className="grid gap-2 grid-cols-1 @min-[640px]/pane:grid-cols-2">
                <Toggle
                    checked={words.wholeWord !== false}
                    onChange={on => dispatch({ type: 'patch_block', block: 'words', patch: { wholeWord: on } })}
                    label={t('shield_data.whole_words', 'Only whole words')}
                    description={t('shield_data.whole_words_desc', '“Falcon” does not match “Falconry”.')}
                    size="sm"
                />
                <Toggle
                    checked={!!words.caseSensitive}
                    onChange={on => dispatch({ type: 'patch_block', block: 'words', patch: { caseSensitive: on } })}
                    label={t('shield_data.exact_case', 'Exact upper and lower case')}
                    description={t('shield_data.exact_case_desc', '“Falcon” does not match “falcon”.')}
                    size="sm"
                />
            </div>
        </div>
    );
}

function PatternCheckLine({ source, examples, caseSensitive, t }: { source: string; examples: string[]; caseSensitive: boolean; t: TranslateFn }) {
    const check = checkPattern(source, examples, caseSensitive);
    if (!check.ok) {
        if (check.reason === 'empty') return null;
        const text = check.reason === 'too_long'
            ? t('shield_data.pattern_too_long', 'Keep the pattern under 300 characters.')
            : t('shield_data.pattern_invalid', 'This pattern does not work: {message}', { message: check.message || '' });
        return <p role="alert" className="text-[11px] mt-1 mb-0 text-[var(--error-ink)]">{text}</p>;
    }
    if (check.total === 0) return null;
    return (
        <p role="status" className={`text-[11px] mt-1 mb-0 ${check.misses.length ? 'text-[var(--warning-ink)]' : 'text-[var(--success-ink)]'}`}>
            {t('shield_data.pattern_matches', 'Matches {m} of {n} examples', { m: check.matched, n: check.total })}
            {check.misses.length > 0 && ` · ${t('shield_data.pattern_misses', 'Not matched: {list}', { list: check.misses.join(', ') })}`}
        </p>
    );
}

function PatternAdvanced({ state, dispatch, t }: StepProps) {
    const id = useId();
    const pattern = state.type.pattern || { source: '', caseSensitive: false };
    const inferred = pattern.source ? '' : inferPattern(state.tests.examples);
    const setSource = (source: string) => dispatch({ type: 'patch_block', block: 'pattern', patch: { source } });
    return (
        <Disclosure title={t('shield_data.pattern_advanced', 'Write the pattern yourself (advanced)')} defaultOpen={!!pattern.source}>
            <label htmlFor={id} className={labelClass}>{t('shield_data.pattern_label', 'Pattern')}</label>
            <input
                id={id}
                type="text"
                value={pattern.source}
                maxLength={LIMITS.pattern}
                onChange={e => setSource(e.target.value)}
                placeholder={inferred || 'KL-\\d{5}'}
                className={`${inputClass} font-mono text-xs`}
            />
            {inferred && (
                <p className={helpClass}>
                    {t('shield_data.pattern_inferred', 'From your examples we would use: {pattern}', { pattern: inferred })}{' '}
                    <LinkButton onClick={() => setSource(inferred)}>{t('shield_data.pattern_use', 'Use this')}</LinkButton>
                </p>
            )}
            <PatternCheckLine source={pattern.source || inferred} examples={state.tests.examples} caseSensitive={!!pattern.caseSensitive} t={t} />
        </Disclosure>
    );
}

function ExamplesInputs(props: StepProps) {
    const { state, dispatch, t } = props;
    return (
        <div className="flex flex-col gap-3">
            <ChipList
                label={t('shield_data.examples_label', 'Examples')}
                help={t('shield_data.examples_help', 'Add 3 to 5 real examples. They stay on your server and are only used to test.')}
                values={state.tests.examples}
                onChange={examples => dispatch({ type: 'set_examples', examples })}
                max={LIMITS.examples}
                maxLen={LIMITS.example}
                placeholder={t('shield_data.examples_placeholder', 'Type a real example and press Enter')}
                caseSensitive
                mono={state.type.method === 'pattern'}
                t={t}
            />
            <Note Icon={Lock} tone="muted">
                {t('shield_data.examples_lock', 'The assistant never sees your examples. It gets made-up look-alikes instead.')}
            </Note>
            {state.type.method === 'pattern' && <PatternAdvanced {...props} />}
        </div>
    );
}

export function MethodInputs(props: StepProps) {
    return props.state.type.method === 'words' ? <WordsInputs {...props} /> : <ExamplesInputs {...props} />;
}

export default MethodInputs;
