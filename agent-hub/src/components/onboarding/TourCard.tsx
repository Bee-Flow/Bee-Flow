import { X, ArrowLeft, ArrowRight, Check } from 'lucide-react';
import type { RefObject } from 'react';
import { useTranslation } from '../../hooks/useTranslation';
import { CARD_WIDTH } from './tourDom';
import type { TourStep } from './OnboardingTour.types';

interface TourCardProps {
    step: TourStep;
    steps: TourStep[];
    stepIndex: number;
    title: string;
    body: string;
    actionHint: string | null;
    cardRef: RefObject<HTMLDivElement | null>;
    cardStyle: { top: number; left: number };
    onFinish: () => void;
    onNext: () => void;
    onPrev: () => void;
}

/** The tour card: icon and title, body, progress dots, Back / Next (or the action hint) and the footer. */
export function TourCard({ step, steps, stepIndex, title, body, actionHint, cardRef, cardStyle, onFinish, onNext, onPrev }: TourCardProps) {
    const { t } = useTranslation();
    const total = steps.length;
    const isLast = stepIndex === total - 1;
    const isFirst = stepIndex === 0;
    const interactive = !!step.interactive;
    const showBack = !isFirst && !interactive;
    return (
        <div
            ref={cardRef}
            role="dialog"
            aria-modal={interactive ? undefined : 'true'}
            aria-labelledby="beeflow-tour-title"
            aria-describedby="beeflow-tour-body"
            tabIndex={-1}
            className="rounded-2xl border outline-none p-5"
            style={{
                position: 'fixed',
                top: cardStyle.top,
                left: cardStyle.left,
                width: CARD_WIDTH,
                maxWidth: 'calc(100vw - 32px)',
                background: 'var(--bg-card)',
                borderColor: 'var(--border-default)',
                boxShadow: 'var(--shadow-popover, 0 20px 60px rgba(0,0,0,0.45))',
                zIndex: 9999,
                animation: 'beeflowTourIn .22s cubic-bezier(0.16, 1, 0.3, 1)',
            }}
        >
            <div className="flex items-start gap-3">
                <div
                    className="w-9 h-9 rounded-xl flex items-center justify-center text-lg flex-shrink-0 [background:color-mix(in_srgb,var(--accent-primary)_14%,transparent)]"
                    aria-hidden="true"
                >
                    {step.icon}
                </div>
                <div className="flex-1 min-w-0">
                    <h2 id="beeflow-tour-title" className="text-[15px] font-bold text-[var(--text-primary)] leading-snug">
                        {title}
                    </h2>
                </div>
                <button
                    type="button"
                    onClick={onFinish}
                    aria-label={t('tour.skip', 'Skip tour')}
                    className="p-1 -mt-1 -mr-1 rounded-lg text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors flex-shrink-0"
                >
                    <X className="w-4 h-4" />
                </button>
            </div>

            <p id="beeflow-tour-body" className="mt-2.5 text-[13px] leading-relaxed text-[var(--text-secondary)]">
                {body}
            </p>

            <div className="mt-4 flex items-center justify-between gap-3">
                {/* Progress dots */}
                <div className="flex items-center gap-1.5" aria-hidden="true">
                    {steps.map((s: import('./OnboardingTour.types').TourStep, i: number) => (
                        <span
                            key={s.id}
                            className="rounded-full transition-all duration-200"
                            style={{
                                width: i === stepIndex ? 18 : 6,
                                height: 6,
                                background: i === stepIndex ? 'var(--accent-primary)' : 'var(--border-default)',
                            }}
                        />
                    ))}
                </div>

                <div className="flex items-center gap-2">
                    {showBack && (
                        <button
                            type="button"
                            onClick={onPrev}
                            className="inline-flex items-center gap-1 px-2.5 h-8 rounded-lg text-[12px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors"
                        >
                            <ArrowLeft className="w-3.5 h-3.5" />
                            {t('tour.back', 'Back')}
                        </button>
                    )}
                    {interactive ? (
                        <span
                            className="text-[12px] font-semibold text-[var(--accent-primary)] [animation:beeflowHintPulse_1.6s_ease-in-out_infinite]"
                        >
                            {actionHint}
                        </span>
                    ) : (
                        <button
                            type="button"
                            onClick={onNext}
                            className="inline-flex items-center gap-1.5 px-3.5 h-8 rounded-lg text-[12px] font-semibold transition-opacity hover:opacity-90 [background:var(--accent-primary)] [color:var(--accent-primary-fg,#fff)]!"
                        >
                            {isLast ? (
                                <>
                                    <Check className="w-3.5 h-3.5" />
                                    {t('tour.finish', 'Got it')}
                                </>
                            ) : (
                                <>
                                    {t('tour.next', 'Next')}
                                    <ArrowRight className="w-3.5 h-3.5" />
                                </>
                            )}
                        </button>
                    )}
                </div>
            </div>

            {/* Footer: step count + skip */}
            <div className="mt-3 pt-3 border-t flex items-center justify-between border-[var(--border-subtle)]">
                <span className="text-[11px] text-[var(--text-tertiary)] tabular-nums">
                    {t('tour.step_counter', 'Step {n} of {total}').replace('{n}', String(stepIndex + 1)).replace('{total}', String(total))}
                </span>
                {!isLast && (
                    <button
                        type="button"
                        onClick={onFinish}
                        className="text-[11px] font-medium text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] transition-colors"
                    >
                        {t('tour.skip', 'Skip tour')}
                    </button>
                )}
            </div>
        </div>
    );
}
