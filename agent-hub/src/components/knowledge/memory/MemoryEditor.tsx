import React, { useId, useState } from 'react';

import { useTranslation } from '../../../hooks/useTranslation';
import { MEMORY_TYPE_IDS, isMemoryType, typeSingularLabel, type MemoryType } from './memoryTypes';

export interface MemoryDraft {
    content: string;
    type: MemoryType;
    importance: number;
}

interface MemoryEditorProps {
    initial: MemoryDraft;
    /** Types offered in the select (the current type is always included). */
    types?: readonly MemoryType[];
    showImportance?: boolean;
    saving?: boolean;
    autoFocus?: boolean;
    onSave: (draft: MemoryDraft) => void;
    onCancel: () => void;
}

const FIELD = 'w-full rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] px-3 py-2 text-sm text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--focus-ring)]';

export function importanceLabel(t: ReturnType<typeof useTranslation>['t'], value: number): string {
    if (value < 0.34) return t('knowledge.memory_importance_low', 'Low');
    if (value < 0.67) return t('knowledge.memory_importance_normal', 'Normal');
    return t('knowledge.memory_importance_high', 'High');
}

/** Edit one memory, or write a new one: text, type and (when editing) importance. */
export default function MemoryEditor({
    initial, types = MEMORY_TYPE_IDS, showImportance = true, saving = false, autoFocus = true, onSave, onCancel,
}: MemoryEditorProps) {
    const { t } = useTranslation();
    const uid = useId();
    const [content, setContent] = useState(initial.content);
    const [type, setType] = useState<MemoryType>(initial.type);
    const [importance, setImportance] = useState(initial.importance);

    const options = types.includes(initial.type) ? types : [initial.type, ...types];
    const canSave = content.trim().length > 0 && !saving;
    const save = () => { if (canSave) onSave({ content: content.trim(), type, importance }); };

    return (
        <div
            className="space-y-3"
            onKeyDown={(e) => {
                if (e.key === 'Escape') { e.stopPropagation(); onCancel(); }
                else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
            }}
        >
            <div>
                <label htmlFor={`${uid}-content`} className="mb-1 block text-xs font-medium text-[var(--text-secondary)]">
                    {t('knowledge.memory_field_content', 'Memory')}
                </label>
                <textarea
                    id={`${uid}-content`}
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                    rows={3}
                    autoFocus={autoFocus}
                    placeholder={t('knowledge.memory_enter_something_to_remember', 'Enter something to remember...')}
                    className={`${FIELD} resize-y`}
                />
            </div>
            <div className="flex flex-wrap items-end gap-4">
                <div>
                    <label htmlFor={`${uid}-type`} className="mb-1 block text-xs font-medium text-[var(--text-secondary)]">
                        {t('knowledge.memory_field_type', 'Type')}
                    </label>
                    <select
                        id={`${uid}-type`}
                        value={type}
                        onChange={(e) => { if (isMemoryType(e.target.value)) setType(e.target.value); }}
                        className={`${FIELD} w-auto`}
                    >
                        {options.map((id) => (
                            <option key={id} value={id}>{typeSingularLabel(t, id)}</option>
                        ))}
                    </select>
                </div>
                {showImportance && (
                    <div className="min-w-40 flex-1">
                        <label htmlFor={`${uid}-importance`} className="mb-1 flex justify-between text-xs font-medium text-[var(--text-secondary)]">
                            <span>{t('knowledge.memory_field_importance', 'Importance')}</span>
                            <span className="text-[var(--text-tertiary)]">{importanceLabel(t, importance)}</span>
                        </label>
                        <input
                            id={`${uid}-importance`}
                            type="range"
                            min={0}
                            max={1}
                            step={0.1}
                            value={importance}
                            onChange={(e) => setImportance(Number(e.target.value))}
                            className="w-full accent-[var(--accent-primary)]"
                        />
                    </div>
                )}
            </div>
            <div className="flex gap-2">
                <button
                    type="button"
                    onClick={onCancel}
                    className="rounded-lg border border-[var(--border-default)] px-3 py-1.5 text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
                >
                    {t('knowledge.memory_cancel', 'Cancel')}
                </button>
                <button
                    type="button"
                    onClick={save}
                    disabled={!canSave}
                    className="rounded-lg bg-[var(--accent-primary)] px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
                >
                    {t('knowledge.memory_save', 'Save')}
                </button>
            </div>
        </div>
    );
}
