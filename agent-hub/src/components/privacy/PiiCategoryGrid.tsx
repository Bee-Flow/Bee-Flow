import type { LucideIcon } from 'lucide-react';
import React, { useId } from 'react';

interface PiiCategory {
    id: string;
    label: string;
    icon?: string;
    Icon?: LucideIcon;
}

/**
 * Two-column grid of PII categories with All / None shortcuts. The full
 * label/icon list lives at the call site so the same grid can render
 * either the local detector's subset or the full catalog.
 *
 * Used by:
 *   - the org Privacy Shield settings page
 *   - personal ConsumerPrivacySection
 *   - SignupStepPrivacy
 *
 * ── Two things this markup gets right on purpose ──────────────────────────
 *
 * 1. `<fieldset>` + `<legend>`. A bare `<label>` above a grid of checkboxes
 *    names nothing: a screen reader reads twenty-one unrelated boxes with no
 *    idea what they belong to. The fieldset is what turns them into one
 *    labelled group.
 *
 * 2. `aria-hidden` on the icon. It used to render through AppEmoji with an
 *    id from a lookup whose entire body was `return null`, so every icon was
 *    announced as an image with NO accessible name — twenty-one "image"
 *    announcements between the real labels. The text beside it already names
 *    the category, so the icon is decorative by definition.
 */
interface PiiCategoryGridProps {
    value?: string[] | null;
    onChange: (value: string[]) => void;
    categories: PiiCategory[];
    label?: string;
    allLabel?: string;
    noneLabel?: string;
    disabled?: boolean;
}

function PiiCategoryGrid({ value, onChange, categories, label = 'Kinds of personal data', allLabel = 'All', noneLabel = 'None', disabled = false }: PiiCategoryGridProps) {
    const selected = Array.isArray(value) ? value : [];
    const legendId = useId();
    const toggle = (id: string) => {
        if (selected.includes(id)) onChange(selected.filter(x => x !== id));
        else onChange([...selected, id]);
    };
    return (
        <fieldset className="min-w-0 border-0 p-0 m-0">
            <div className="flex items-center justify-between mb-3">
                <legend id={legendId} className="text-xs font-medium text-muted float-left">
                    {label} ({selected.length}/{categories.length})
                </legend>
                <div className="flex gap-2 ml-auto">
                    <button
                        type="button"
                        disabled={disabled}
                        onClick={() => onChange(categories.map(c => c.id))}
                        className="text-xs px-2 py-1 rounded hover:bg-white/10 transition-colors font-medium disabled:opacity-50 text-[var(--accent-primary)]"
                    >{allLabel}</button>
                    <button
                        type="button"
                        disabled={disabled}
                        onClick={() => onChange([])}
                        className="text-xs px-2 py-1 rounded hover:bg-white/10 transition-colors text-muted disabled:opacity-50"
                    >{noneLabel}</button>
                </div>
            </div>
            <div
                className="grid grid-cols-2 gap-2 p-4 rounded-xl border bg-[var(--bg-tertiary)] border-[var(--border-subtle)]"
            >
                {categories.map(cat => {
                    // Callers may still pass a bespoke list without `Icon`; fall
                    // back to the emoji rather than rendering a hole.
                    const Icon = cat.Icon;
                    return (
                        <label
                            key={cat.id}
                            className="flex items-center gap-2 text-sm text-[var(--text-secondary)] cursor-pointer p-2 rounded hover:bg-white/5 transition-colors"
                        >
                            <input
                                type="checkbox"
                                disabled={disabled}
                                checked={selected.includes(cat.id)}
                                onChange={() => toggle(cat.id)}
                                className="w-4 h-4 rounded border-gray-600 bg-gray-700 text-[var(--accent-primary)] focus:ring-0"
                            />
                            {Icon
                                ? <Icon className="w-4 h-4 shrink-0 text-[var(--text-muted)]" aria-hidden="true" />
                                : <span aria-hidden="true">{cat.icon}</span>}
                            <span>{cat.label}</span>
                        </label>
                    );
                })}
            </div>
        </fieldset>
    );
}

export default PiiCategoryGrid;
