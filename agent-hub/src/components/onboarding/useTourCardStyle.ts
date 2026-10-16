import { useMemo } from 'react';
import { CARD_WIDTH, EDGE } from './tourDom';
import type { TargetRect, TourStep } from './OnboardingTour.types';

/** Where the card goes: beside the target on the step's side, or centred, always inside the viewport. */
export function useTourCardStyle(rect: TargetRect | null, step: TourStep | null) {
    // ── Card position (clamped to the viewport) ────────────────────────
    return useMemo(() => {
        const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
        const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
        const estH = 210;
        const clamp = (v: number, max: number) => Math.max(EDGE, Math.min(v, max - EDGE));

        if (!rect || (step && step.placement === 'center')) {
            return { top: Math.round(vh / 2 - estH / 2), left: Math.round(vw / 2 - CARD_WIDTH / 2) };
        }
        const placement = step?.placement || 'right';
        let top: number;
        let left: number;
        switch (placement) {
            case 'left': left = rect.left - CARD_WIDTH - 16; top = rect.top; break;
            case 'top': left = rect.left; top = rect.top - estH - 16; break;
            case 'bottom': left = rect.left; top = rect.top + rect.height + 16; break;
            case 'right':
            default: left = rect.left + rect.width + 16; top = rect.top - 8; break;
        }
        return { top: Math.round(clamp(top, vh - estH)), left: Math.round(clamp(left, vw - CARD_WIDTH)) };
    }, [rect, step]);
}
