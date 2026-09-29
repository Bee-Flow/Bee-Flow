import { Sparkles } from 'lucide-react';
import React, { useState } from 'react';
import { PRIMARY_ACTION_STYLE } from '../../../shared/StudioSectionHeader';

/**
 * The empty-skill head start (artboard 1a, "Let AI fill it in").
 *
 * Shown ONLY while the skill still has no method: one sentence is all an
 * empty skill can offer a model, and once there is something on the page
 * "Improve with AI" in the header is the action that makes sense — it has
 * the current skill to work from and it says what it changed.
 */
export default function FillInCard({ onFillIn, drafting, t }) {
    const [sentence, setSentence] = useState('');
    const submit = () => { if (sentence.trim()) onFillIn?.(sentence); };
    return (
        <div
            className="flex flex-col gap-2 px-3.5 py-3 rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-card)]"
            data-testid="skill-fill-in"
        >
            <span className="text-xs font-medium text-[var(--text-primary)] inline-flex items-center gap-1.5">
                <Sparkles size={13} aria-hidden="true" />
                {t('skills_studio.fill.title', 'Start from one sentence')}
            </span>
            <div className="flex gap-2">
                <input
                    value={sentence}
                    onChange={(e) => setSentence(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
                    aria-label={t('skills_studio.fill.label', 'What should this skill do?')}
                    placeholder={t('skills_studio.fill.placeholder', 'Describe in one sentence what this skill should do…')}
                    className="flex-1 rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] px-3 py-2 text-xs outline-none text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)]"
                />
                <button
                    type="button"
                    onClick={submit}
                    disabled={drafting || !sentence.trim()}
                    data-testid="skill-fill-in-run"
                    className="h-8 px-3 rounded-[10px] text-xs font-semibold whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
                    style={PRIMARY_ACTION_STYLE}
                >
                    {drafting
                        ? t('skills_studio.fill.working', 'Writing…')
                        : t('skills_studio.fill.button', 'Let AI fill it in')}
                </button>
            </div>
        </div>
    );
}
