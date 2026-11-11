import { ChevronLeft, ChevronRight } from 'lucide-react';
import React, { useState } from 'react';
import useTranslation from '@/hooks/useTranslation';
import { useRuntime } from '../RuntimeContext';
import type { NodeProps } from './appNode.types';
import { selectedChildIndex, type SlotChildDef } from './slotNodes';

/**
 * App Studio runtime - 'carousel' (schema 3). Spec: server/appStudio/componentSpecs/types/carousel.js.
 *
 * Slides shown one at a time; every child is one slide. The first slide shows at first and
 * nothing moves by itself: no autoplay, so a headless render, a screenshot and a viewer who
 * wants to read all see the same slide. Previous and next are labelled buttons, the dots are
 * buttons too, and every slide is a labelled group ("Slide 2 of 5").
 *
 * All slides stay mounted and the others are `hidden`, the way tabs keep their panels, so a
 * field on a slide that is not showing still belongs to its form.
 */
interface CarouselProps {
    loop?: boolean;
    showDots?: boolean;
}

const BUTTON_CLS = 'inline-flex items-center justify-center rounded-full p-1.5 border disabled:opacity-40 [background:var(--bg-card)] [border-color:var(--border-default)] text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--text-secondary)]';

export default function AppCarousel({ node, children }: NodeProps<CarouselProps>) {
    const { t } = useTranslation();
    const { selectedNodeId } = useRuntime();
    const slides = React.Children.toArray(children);
    const defs = (Array.isArray(node.children) ? node.children : []) as SlotChildDef[];
    const loop = node.props?.loop === true;
    const showDots = node.props?.showDots !== false;
    const [index, setIndex] = useState(0);
    const total = slides.length;

    if (total === 0) {
        return <div className="text-sm py-2 text-[var(--text-muted)]">{t('studio_apps_lk21a.carousel.empty', 'Add slides to this carousel.')}</div>;
    }
    // In the editor the slide holding the selected node shows, so the inspector edits what was clicked.
    const selectedIdx = selectedChildIndex(defs, selectedNodeId);
    const current = selectedIdx >= 0 ? selectedIdx : Math.min(index, total - 1);
    const go = (to: number) => setIndex(loop ? (to + total) % total : Math.min(total - 1, Math.max(0, to)));

    return (
        <div
            role="region"
            aria-roledescription="carousel"
            aria-label={t('studio_apps_lk21a.carousel.label', 'Carousel')}
            className="w-full min-w-0 flex flex-col gap-2 bfa-carousel__root"
            data-app-carousel="true"
        >
            <div className="flex items-center gap-2">
                {total > 1 ? (
                    <button
                        type="button"
                        aria-label={t('studio_apps_lk21a.carousel.previous', 'Previous slide')}
                        disabled={!loop && current === 0}
                        onClick={() => go(current - 1)}
                        className={`${BUTTON_CLS} bfa-carousel__previous`}
                    >
                        <ChevronLeft className="w-4 h-4" aria-hidden="true" />
                    </button>
                ) : null}
                <div className="flex-1 min-w-0 bfa-carousel__viewport">
                    {slides.map((slide, i) => (
                        <div
                            key={defs[i]?.id ?? i}
                            role="group"
                            aria-roledescription="slide"
                            aria-label={t('studio_apps_lk21a.carousel.slide', 'Slide {n} of {total}', { n: i + 1, total })}
                            hidden={i !== current}
                            className="bfa-carousel__slide"
                            data-app-carousel-slide={i === current ? 'active' : 'inactive'}
                        >
                            {slide}
                        </div>
                    ))}
                </div>
                {total > 1 ? (
                    <button
                        type="button"
                        aria-label={t('studio_apps_lk21a.carousel.next', 'Next slide')}
                        disabled={!loop && current === total - 1}
                        onClick={() => go(current + 1)}
                        className={`${BUTTON_CLS} bfa-carousel__next`}
                    >
                        <ChevronRight className="w-4 h-4" aria-hidden="true" />
                    </button>
                ) : null}
            </div>
            {showDots && total > 1 ? (
                <div role="group" aria-label={t('studio_apps_lk21a.carousel.slides', 'Slides')} className="flex justify-center gap-1.5 bfa-carousel__dots">
                    {slides.map((_, i) => (
                        <button
                            key={defs[i]?.id ?? i}
                            type="button"
                            aria-label={t('studio_apps_lk21a.carousel.go_to', 'Go to slide {n}', { n: i + 1 })}
                            aria-current={i === current ? 'true' : undefined}
                            onClick={() => go(i)}
                            className={`h-2 w-2 rounded-full border-0 p-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--text-secondary)] ${i === current ? '[background:var(--app-primary)]' : '[background:var(--border-default)]'} bfa-carousel__dot`}
                        />
                    ))}
                </div>
            ) : null}
        </div>
    );
}
