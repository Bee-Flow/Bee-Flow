import { useId, useState } from 'react';
import type { ChangeEvent, KeyboardEvent } from 'react';
import type { TranslateFn } from '@/hooks/useTranslation';
import type { SkillDraft } from './skillModel.types';

/**
 * Two of the skill editor's "All options", next to Dynamic activation:
 *
 *   - "Only through agents": the skill is not switched on by itself in a
 *     chat. The server ignores it as a session skill without an agent that
 *     attaches it (server/core/skills/agentOnlySkills.mts); hiding it in the
 *     chat's skill picker is only the visible half.
 *   - the category: free text with the categories the other skills already
 *     carry as suggestions (a native <datalist>), no fixed list. The agents'
 *     CategoryField is a managed list (ids, rename, merge); a skill's
 *     category is a word, so it takes the same "pick one, or type a new one"
 *     shape without a second category store.
 *
 * The category is written on blur or Enter, not per keystroke: the editor's
 * option changes save at once, and a half-typed word is not a category.
 */
export interface SkillAccessOptionsProps {
    t: TranslateFn;
    agentOnly: boolean;
    category: string;
    categorySuggestions: string[];
    readOnly: boolean;
    onChange: (patch: Partial<SkillDraft>) => void;
}

export default function SkillAccessOptions({ t, agentOnly, category, categorySuggestions, readOnly, onChange }: SkillAccessOptionsProps) {
    const listId = useId();
    const [text, setText] = useState(category);
    const [lastCategory, setLastCategory] = useState(category);
    if (category !== lastCategory) {
        setLastCategory(category);
        setText(category);
    }
    const commit = () => {
        const next = text.trim();
        if (next !== category.trim()) onChange({ category: next });
    };
    const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
    };

    return (
        <>
            <label className="flex items-start gap-2 text-xs text-[var(--text-secondary)] cursor-pointer">
                <input
                    type="checkbox"
                    checked={agentOnly}
                    disabled={readOnly}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => onChange({ agentOnly: e.target.checked })}
                    data-testid="skill-agent-only"
                    className="mt-0.5"
                />
                <span>
                    <span className="block font-medium text-[var(--text-primary)]">
                        {t('skillStore.agent_only_label', 'Only through agents')}
                    </span>
                    {t('skillStore.agent_only_help', 'When on, nobody can switch this skill on by itself in a chat. It works in agents that attach it, and in Cowork and automations that run through such an agent.')}
                </span>
            </label>

            <div className="flex flex-col gap-1 text-xs text-[var(--text-secondary)]">
                <label htmlFor={`${listId}-input`} className="font-medium text-[var(--text-primary)]">
                    {t('skillStore.category_label', 'Category')}
                </label>
                <input
                    id={`${listId}-input`}
                    list={`${listId}-list`}
                    value={text}
                    disabled={readOnly}
                    maxLength={60}
                    onChange={(e) => setText(e.target.value)}
                    onBlur={commit}
                    onKeyDown={onKey}
                    placeholder={t('skillStore.category_placeholder', 'No category')}
                    data-testid="skill-category"
                    className="w-full px-2 py-1.5 rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] text-[var(--text-primary)] outline-none focus:border-[var(--accent-primary)]"
                />
                <datalist id={`${listId}-list`}>
                    {categorySuggestions.map((c) => <option key={c} value={c} />)}
                </datalist>
                <span>{t('skillStore.category_help', 'Pick one the other skills use, or type a new one. Skills with the same category are grouped together.')}</span>
            </div>
        </>
    );
}
