import React, { useState } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from '../../../../hooks/useTranslation';

const MAX_IGNORE_PATHS = 50;
const MAX_PATH_LENGTH = 500;

interface IgnorePathsEditorProps {
    paths: string[];
    onChange: (paths: string[]) => void;
}

/** The fields a replay should not count as a difference: chips, plus one box to add another. */
export default function IgnorePathsEditor({ paths, onChange }: IgnorePathsEditorProps) {
    const { t } = useTranslation();
    const [draft, setDraft] = useState('');
    const add = () => {
        const next = draft.trim().slice(0, MAX_PATH_LENGTH);
        if (next && !paths.includes(next) && paths.length < MAX_IGNORE_PATHS) onChange([...paths, next]);
        setDraft('');
    };
    return (
        <div className="flex flex-col gap-1.5">
            <label className="font-medium text-[var(--text-primary)]" htmlFor="ignore-path-input">
                {t('automation_run_checks.ignore.label', 'Ignore these fields when comparing')}
            </label>
            <p className="text-[var(--text-tertiary)]">
                {t('automation_run_checks.ignore.help', 'For values that are different every time, such as a date or a reference number. Use the name of the field in the step result, for example createdAt or items[0].id.')}
            </p>
            {paths.length > 0 && (
                <ul className="flex flex-wrap gap-1.5">
                    {paths.map(p => (
                        <li key={p} className="inline-flex items-center gap-1 rounded-md bg-[var(--bg-tertiary)] pl-2 pr-1 py-0.5 font-mono text-[var(--text-primary)]">
                            {p}
                            <button
                                type="button"
                                aria-label={t('automation_run_checks.ignore.remove', 'Stop ignoring {field}', { field: p })}
                                onClick={() => onChange(paths.filter(x => x !== p))}
                                className="p-0.5 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                            >
                                <X size={11} aria-hidden />
                            </button>
                        </li>
                    ))}
                </ul>
            )}
            <div className="flex gap-1.5">
                <input
                    id="ignore-path-input"
                    value={draft}
                    onChange={e => setDraft(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
                    placeholder={t('automation_run_checks.ignore.placeholder', 'createdAt')}
                    maxLength={MAX_PATH_LENGTH}
                    className="min-w-0 flex-1 h-[28px] px-2 rounded-md border border-[var(--border-default)] bg-[var(--bg-primary)] text-[var(--text-primary)]"
                />
                <button
                    type="button"
                    onClick={add}
                    disabled={!draft.trim() || paths.length >= MAX_IGNORE_PATHS}
                    className="h-[28px] px-2.5 rounded-md border border-[var(--border-default)] text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] disabled:opacity-50"
                >
                    {t('automation_run_checks.ignore.add', 'Add field')}
                </button>
            </div>
        </div>
    );
}
