import { MessageSquarePlus, Plus, Trash2 } from 'lucide-react';
import React, { useState } from 'react';
import useTranslation from '@/hooks/useTranslation';
import { newLocalId } from './skillModel';
import type { Rule, Example } from './skillModel.types';
import type { TranslateFn } from '@/hooks/useTranslation';
import type { ExamplesTabProps, ExampleCardProps, FieldProps } from './ExamplesTab.types';
import { FromConversationPicker } from './FromConversationPicker';

export default function ExamplesTab({ skillId, examples, rules = [], onChange, readOnly = false }: ExamplesTabProps) {
    const { t } = useTranslation();
    const rows = Array.isArray(examples) ? examples : [];
    const [picking, setPicking] = useState(false);

    const patch = (id: string, next: Partial<Example>) => onChange(rows.map(e => (e.id === id ? { ...e, ...next } : e)));
    const remove = (id: string) => onChange(rows.filter(e => e.id !== id));
    const add = () => onChange([...rows, {
        id: newLocalId('ex'), question: '', good: '', rationale: '', bad: '', violatedRuleId: '', sourceConversationId: '',
    }]);

    return (
        <div className="flex flex-col gap-3" data-testid="skill-examples">
            <div className="flex items-start gap-3">
                <p className="text-xs text-[var(--text-secondary)] m-0 flex-1">
                    {t(
                        'skills_studio.examples.intro',
                        'Examples show what it should look like. Two or three good ones are enough; a bad one helps with things the agent keeps getting wrong.',
                    )}
                </p>
                {!readOnly && (
                    <div className="flex items-center gap-2 flex-shrink-0">
                        <button
                            type="button"
                            onClick={() => setPicking(true)}
                            data-testid="skill-example-from-chat"
                            className="h-8 px-3 rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-card)] text-xs font-medium text-[var(--text-primary)] inline-flex items-center gap-1.5"
                        >
                            <MessageSquarePlus size={13} aria-hidden="true" />
                            {t('skills_studio.examples.from_chat', 'Pick from a conversation')}
                        </button>
                        <button
                            type="button"
                            onClick={add}
                            data-testid="skill-example-add"
                            className="h-8 px-3 rounded-[10px] text-xs font-semibold inline-flex items-center gap-1.5 bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]"
                        >
                            <Plus size={13} aria-hidden="true" />
                            {t('skills_studio.examples.add', 'Example')}
                        </button>
                    </div>
                )}
            </div>

            {rows.length === 0 && (
                <p className="text-xs text-[var(--text-tertiary)] italic m-0">
                    {t('skills_studio.examples.empty', 'No examples yet.')}
                </p>
            )}

            {rows.map((example) => (
                <ExampleCard
                    key={example.id}
                    example={example}
                    rules={rules}
                    readOnly={readOnly}
                    onPatch={(next) => patch(example.id, next)}
                    onRemove={() => remove(example.id)}
                    t={t}
                />
            ))}

            {/* The artboard's standing hint (1b, bottom): the best examples are
                made where the good answer happened, not typed here afterwards.
                It names the button DIRECTLY ABOVE it. The artboard's own copy
                pointed at a Chat action ("Make an example for skill…") that
                does not exist anywhere in the app — a hint that sends someone
                looking for a menu item nobody built is worse than no hint. */}
            <p
                className="flex items-center gap-2.5 px-3.5 py-3 rounded-xl border border-dashed border-[var(--border-default)] text-xs m-0 text-[var(--text-secondary)]"
                data-testid="skill-examples-chat-hint"
            >
                <MessageSquarePlus size={14} aria-hidden="true" className="flex-shrink-0" />
                {t(
                    'skills_studio.examples.chat_hint',
                    'The best examples come from an answer that already happened — “Pick from a conversation” above brings one in, with personal data removed automatically.',
                )}
            </p>

            {picking && (
                <FromConversationPicker
                    skillId={skillId}
                    onClose={() => setPicking(false)}
                    onAdded={(example) => { setPicking(false); onChange([...rows, example]); }}
                    t={t}
                />
            )}
        </div>
    );
}

const CAP_LABEL = 'text-[10px] tracking-[.08em] uppercase font-semibold';

function ExampleCard({ example, rules, readOnly, onPatch, onRemove, t }: ExampleCardProps) {
    /**
     * Opening the "Not like this" half is a VIEW state, not data. It used to
     * be written as `bad: ' '`, which reads as stored but is not: the server
     * keeps `bad` only when it is non-blank (skillStructure.validateExamples
     * uses `trim()`), so the space was dropped and the half silently closed
     * again on the next load. Local state says the same thing honestly, and
     * has the better behaviour besides — opening a field is not an edit, so
     * it fires no autosave.
     */
    const [revealed, setRevealed] = useState(false);
    const showBad = revealed || !!example.bad || !!example.violatedRuleId;
    // A `violatedRuleId` whose rule no longer exists — see the select below.
    const orphanRule = !!example.violatedRuleId && !rules.some(r => r.id === example.violatedRuleId);
    return (
        <article
            data-testid="skill-example"
            data-example-id={example.id}
            className="rounded-xl bg-[var(--bg-card)] border border-[var(--border-default)] shadow-sm p-4 grid gap-3"
            style={{ gridTemplateColumns: showBad ? '1fr 1fr 1fr' : '1fr 1fr' }}
        >
            <Field
                label={t('skills_studio.examples.question', 'When someone asks')}
                labelColor="var(--text-tertiary)"
                value={example.question}
                readOnly={readOnly}
                onChange={(question) => onPatch({ question })}
                surface
            />
            <div className="flex flex-col gap-1.5">
                <Field
                    label={t('skills_studio.examples.good', 'Good answer')}
                    labelColor="var(--success-ink)"
                    borderColor="var(--success)"
                    value={example.good}
                    readOnly={readOnly}
                    onChange={(good) => onPatch({ good })}
                />
                <input
                    value={example.rationale}
                    readOnly={readOnly}
                    onChange={(e) => onPatch({ rationale: e.target.value })}
                    aria-label={t('skills_studio.examples.rationale', 'Why this is good')}
                    placeholder={t('skills_studio.examples.rationale', 'Why this is good')}
                    className="bg-transparent outline-none text-xs text-[var(--text-tertiary)] placeholder:text-[var(--text-tertiary)]"
                />
            </div>
            {showBad ? (
                <div className="flex flex-col gap-1.5">
                    <Field
                        label={t('skills_studio.examples.bad', 'Not like this')}
                        labelColor="var(--error-ink)"
                        borderColor="var(--error)"
                        value={example.bad}
                        readOnly={readOnly}
                        onChange={(bad) => onPatch({ bad })}
                    />
                    <select
                        value={example.violatedRuleId || ''}
                        disabled={readOnly}
                        onChange={(e) => onPatch({ violatedRuleId: e.target.value })}
                        aria-label={t('skills_studio.examples.violates', 'Rule it breaks')}
                        data-testid="skill-example-violates"
                        className="bg-transparent outline-none text-xs text-[var(--text-tertiary)]"
                    >
                        <option value="">{t('skills_studio.examples.no_rule', 'No specific rule')}</option>
                        {/* The rule this example named was deleted — see above. */}
                        {orphanRule && (
                            <option value={example.violatedRuleId}>
                                {t('skills_studio.examples.rule_gone', 'The rule this broke was removed')}
                            </option>
                        )}
                        {rules.map((rule) => (
                            <option key={rule.id} value={rule.id}>
                                {rule.text || rule.id}
                            </option>
                        ))}
                    </select>
                </div>
            ) : (
                !readOnly && (
                    <button
                        type="button"
                        onClick={() => setRevealed(true)}
                        data-testid="skill-example-add-bad"
                        className="self-start text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] underline decoration-dotted col-span-2 text-left"
                    >
                        {t('skills_studio.examples.add_bad', 'Add an answer to avoid')}
                    </button>
                )
            )}
            <div className="col-span-full flex items-center gap-3">
                {/* PROVENANCE, and nothing more. This line used to say
                    "Taken from one of YOUR conversations · personal data
                    removed" off nothing but the presence of the id — and that
                    id is client input: `PUT /api/skills/:id` takes `examplesV2`
                    straight from the body (skillStructure keeps
                    `sourceConversationId` as a 128-char string), and nothing on
                    that path is scanned. So a hand-typed example with any id in
                    it wore a guarantee no guard had ever made. The picker's own
                    promise is withdrawn honestly when the check did not run
                    (`piiChecked`); this one could not see that at all.
                    "your" was the second untruth: the example is read by every
                    colleague the skill is shared with, and it was not their
                    conversation.

                    A NEW key rather than new English on the old one:
                    `examples.from_conversation` is already in en-defaults.js
                    with the old sentence, and `t()` answers from the ladder —
                    the inline fallback is only reached for a key that is
                    MISSING. Rewriting the fallback would have left the untrue
                    sentence on screen until the ladder caught up, which for a
                    promise about personal data is the wrong way round.
                    `examples.from_conversation` is now unused; it is reported
                    for removal with the rest. */}
                {example.sourceConversationId && (
                    <span className="text-xs text-[var(--text-tertiary)]" data-testid="skill-example-source">
                        {t('skills_studio.examples.source_note', 'Taken from a conversation')}
                    </span>
                )}
                {!readOnly && (
                    <button
                        type="button"
                        onClick={onRemove}
                        aria-label={t('skills_studio.examples.remove', 'Remove example')}
                        className="ml-auto p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--error)] transition"
                    >
                        <Trash2 size={13} aria-hidden="true" />
                    </button>
                )}
            </div>
        </article>
    );
}

function Field({ label, labelColor, borderColor, value, readOnly, onChange, surface = false }: FieldProps) {
    return (
        <label className="flex flex-col gap-1.5 min-w-0">
            <span className={CAP_LABEL} style={{ color: labelColor }}>{label}</span>
            <textarea
                value={value}
                readOnly={readOnly}
                rows={3}
                onChange={(e) => onChange(e.target.value)}
                className="w-full resize-y rounded-lg px-3 py-2 text-xs leading-[17px] outline-none text-[var(--text-primary)]"
                style={{
                    background: surface ? 'var(--bg-secondary)' : 'transparent',
                    border: `1px solid ${borderColor || 'var(--border-default)'}`,
                }}
            />
        </label>
    );
}

