import React from 'react';
import MarkdownRenderer from '../../renderers/MarkdownRenderer';
import { useTranslation } from '../../../hooks/useTranslation';
import type { LessonStep } from '../../../api/lessons.types';

/**
 * SlideStep — a teaching card inside the LessonPlayer. Renders the step's markdown
 * body. Always satisfiable: the player's Next button is enabled for slides.
 */
export default function SlideStep({ step }: { step: LessonStep }) {
    const { t } = useTranslation();
    const title = t(step.titleKey, step.titleFallback);
    const body = t(step.bodyMdKey, step.bodyMdFallback);

    return (
        <div>
            <div className="flex items-start gap-3 mb-3">
                <div
                    className="w-10 h-10 rounded-xl flex items-center justify-center text-xl flex-shrink-0 [background:color-mix(in_srgb,var(--accent-primary)_14%,transparent)]"
                    aria-hidden="true"
                >
                    {step.icon || '💡'}
                </div>
                <h2 className="text-lg font-bold leading-snug pt-1 text-[var(--text-primary)]">
                    {title}
                </h2>
            </div>
            <div className="text-[14px] leading-relaxed learning-slide-body text-[var(--text-secondary)]">
                <MarkdownRenderer content={body} />
            </div>
        </div>
    );
}
