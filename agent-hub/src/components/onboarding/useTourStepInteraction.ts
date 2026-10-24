import { useEffect } from 'react';
import type { RefObject } from 'react';
import type { TourStep } from './OnboardingTour.types';
import { logger } from '../../utils/logger';

interface StepInteractionDeps {
    active: boolean;
    step: TourStep | null;
    stepIndex: number;
    finish: () => void;
    goNext: () => void;
    goPrev: () => void;
    cardRef: RefObject<HTMLDivElement | null>;
}

/** What moves a step on or closes it: input, a window event or a timeout, the keyboard, and card focus. */
export function useTourStepInteraction({ active, step, stepIndex, finish, goNext, goPrev, cardRef }: StepInteractionDeps) {
    // ── Interactive auto-advance (input typed / window event / fallback) ──
    useEffect(() => {
        if (!active || !step?.advanceOn) return undefined;
        const { input, event, predicate, timeoutMs } = step.advanceOn;
        const cleanups: Array<() => void> = [];
        let advanced = false;
        const advance = () => { if (advanced) return; advanced = true; goNext(); };

        if (input) {
            const minLen = input.minLength || 1;
            const onInput = (e: Event) => {
                const tgt = e.target as HTMLInputElement | null;
                try {
                    if (tgt && tgt.matches && tgt.matches(step.target as string) && String(tgt.value || '').trim().length >= minLen) {
                        advance();
                    }
                } catch (err) { logger.debug('ignore', err); }
            };
            document.addEventListener('input', onInput, true);
            cleanups.push(() => document.removeEventListener('input', onInput, true));
        }
        if (event) {
            const onEvt = (e: CustomEvent) => { if (!predicate || predicate(e.detail)) advance(); };
            window.addEventListener(event, onEvt as EventListener);
            cleanups.push(() => window.removeEventListener(event, onEvt as EventListener));
        }
        if (timeoutMs) {
            const to = setTimeout(advance, timeoutMs);
            cleanups.push(() => clearTimeout(to));
        }
        return () => cleanups.forEach((fn) => fn());
    }, [active, stepIndex, step, goNext]);

    // ── Keyboard (Next/Back disabled on interactive steps so typing works) ──
    useEffect(() => {
        if (!active) return undefined;
        const interactive = !!step?.interactive;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') { e.preventDefault(); finish(); return; }
            if (interactive) return; // let Enter / arrows reach the field
            if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); goNext(); }
            else if (e.key === 'ArrowLeft') { e.preventDefault(); goPrev(); }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [active, step, finish, goNext, goPrev]);

    // ── Focus the card on each step (but not interactive steps) ─────────
    useEffect(() => {
        if (active && !step?.interactive) {
            const id = setTimeout(() => { try { cardRef.current?.focus(); } catch (e) { logger.debug('ignore', e); } }, 60);
            return () => clearTimeout(id);
        }
        return undefined;
    }, [active, stepIndex, step, cardRef]);
}
