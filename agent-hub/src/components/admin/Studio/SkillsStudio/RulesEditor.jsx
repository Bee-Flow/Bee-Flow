import { Ban, Check, Plus, Trash2 } from 'lucide-react';
import React from 'react';
import useTranslation from '../../../../hooks/useTranslation';
import { newLocalId } from './skillModel';

/**
 * "Rules" — what holds regardless of the question (Skills artboard 1a,
 * right column).
 *
 * ── POLARITY IS A CONTROL, NOT A WORD IN THE SENTENCE ───────────────
 * A rule used to be a line in a free-text box, and whether it was a "do" or
 * a "never" lived in the phrasing ("do not mention…"). The model had to
 * infer it, the UI could not colour it, and a negation written as "avoid"
 * read as a suggestion. `polarity` is now a field with two values, so the
 * check/ban mark and the prompt say the same thing, and S3 can grade a
 * `never` differently from a `must`.
 *
 * The mark is a BUTTON: clicking it flips the rule. That is the whole
 * editor for polarity — a select with two options for a binary is a form
 * where a switch would do.
 *
 * ── COLOURS COME FROM THE STATUS TOKENS ─────────────────────────────
 * `--success` / `--error`, never a hex. The artboard's `--status-success`
 * is this repo's `--success` (recorded deviation, plan "Waar ik het ontwerp
 * niet volg").
 */
export default function RulesEditor({ rules, onChange, readOnly = false }) {
    const { t } = useTranslation();
    const rows = Array.isArray(rules) ? rules : [];

    const patch = (id, next) => onChange(rows.map(r => (r.id === id ? { ...r, ...next } : r)));
    const remove = (id) => onChange(rows.filter(r => r.id !== id));
    const add = () => onChange([...rows, { id: newLocalId('rule'), polarity: 'must', text: '' }]);

    return (
        <section className="flex flex-col gap-2" data-testid="skill-rules">
            <div className="flex items-center gap-2">
                <h2 className="text-[13px] font-semibold text-[var(--text-primary)] m-0">
                    {t('skills_studio.rules.title', 'Rules')}
                </h2>
                <span className="text-xs text-[var(--text-tertiary)]">
                    {t('skills_studio.rules.hint', 'always, whatever the question')}
                </span>
            </div>

            {rows.length === 0 && (
                <p className="text-xs text-[var(--text-tertiary)] italic m-0">
                    {t('skills_studio.rules.empty', 'No rules yet. A rule holds for every answer this skill gives.')}
                </p>
            )}

            <ul className="list-none p-0 m-0 flex flex-col gap-1.5">
                {rows.map((rule) => (
                    <RuleRow
                        key={rule.id}
                        rule={rule}
                        readOnly={readOnly}
                        onText={(text) => patch(rule.id, { text })}
                        onFlip={() => patch(rule.id, { polarity: rule.polarity === 'never' ? 'must' : 'never' })}
                        onRemove={() => remove(rule.id)}
                        t={t}
                    />
                ))}
            </ul>

            {!readOnly && (
                <button
                    type="button"
                    onClick={add}
                    data-testid="skill-rule-add"
                    className="self-start flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] rounded-lg hover:bg-[var(--bg-secondary)] transition"
                >
                    <Plus size={13} aria-hidden="true" />
                    {t('skills_studio.rules.add', 'Add rule')}
                </button>
            )}
        </section>
    );
}

function RuleRow({ rule, readOnly, onText, onFlip, onRemove, t }) {
    const never = rule.polarity === 'never';
    const Icon = never ? Ban : Check;
    const color = never ? 'var(--error)' : 'var(--success)';
    const flipLabel = never
        ? t('skills_studio.rules.set_must', 'Change to “always do this”')
        : t('skills_studio.rules.set_never', 'Change to “never do this”');
    const stateLabel = never
        ? t('skills_studio.rules.never', 'Never')
        : t('skills_studio.rules.must', 'Always');

    return (
        <li
            data-testid="skill-rule"
            data-rule-id={rule.id}
            data-polarity={rule.polarity}
            className="flex items-center gap-2 px-2.5 py-2 rounded-lg bg-[var(--bg-card)] border border-[var(--border-default)]"
        >
            <button
                type="button"
                onClick={readOnly ? undefined : onFlip}
                disabled={readOnly}
                aria-label={readOnly ? stateLabel : flipLabel}
                title={readOnly ? stateLabel : flipLabel}
                data-testid="skill-rule-polarity"
                className="p-0.5 rounded flex-shrink-0 disabled:cursor-default hover:bg-[var(--bg-tertiary)] transition"
            >
                <Icon size={13} aria-hidden="true" style={{ color }} />
            </button>
            <input
                value={rule.text}
                onChange={(e) => onText(e.target.value)}
                readOnly={readOnly}
                aria-label={t('skills_studio.rules.text', 'Rule')}
                placeholder={t('skills_studio.rules.placeholder', 'One sentence — what always holds?')}
                className="flex-1 min-w-0 bg-transparent outline-none text-xs text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)]"
            />
            {!readOnly && (
                <button
                    type="button"
                    onClick={onRemove}
                    aria-label={t('skills_studio.rules.remove', 'Remove rule')}
                    title={t('skills_studio.rules.remove', 'Remove rule')}
                    className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--error)] transition flex-shrink-0"
                >
                    <Trash2 size={12} aria-hidden="true" />
                </button>
            )}
        </li>
    );
}
