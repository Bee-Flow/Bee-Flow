import { useEffect } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { revealForTarget } from './tourAnchors';
import { TOUR_ENSURE_SIDEBAR_EVENT, TOUR_OPEN_DESIGNER_SECTION } from './tourSteps';
import { DEFAULT_TIMEOUT, NAV_TIMEOUT, isShowable, pickShowable } from './tourDom';
import type { OnboardingTourProps, TargetRect, TourStep } from './OnboardingTour.types';

interface StepTrackingDeps {
    active: boolean;
    step: TourStep | null;
    stepIndex: number;
    onNavigate: OnboardingTourProps['onNavigate'];
    goNext: () => void;
    setRect: Dispatch<SetStateAction<TargetRect | null>>;
    targetElRef: MutableRefObject<Element | null>;
    navigatedRef: MutableRefObject<boolean>;
    agentCreatedRef: MutableRefObject<boolean>;
}

/** Navigate for the current step, then keep its target spotlighted (measure loop, scroll and resize). */
export function useTourStepTracking({ active, step, stepIndex, onNavigate, goNext, setRect, targetElRef, navigatedRef, agentCreatedRef }: StepTrackingDeps) {
    // ── Per-step: navigate, then a rAF resolve+measure loop ────────────
    useEffect(() => {
        if (!active || !step) return undefined;

        // Steps that need a precondition.
        if (step.requiresAgentCreated && !agentCreatedRef.current) { goNext(); return undefined; }

        // Reveal the context an anchor needs BEFORE we try to target it. The
        // registry knows which Designer section / sidebar each anchor lives in, so
        // a step pointing at e.g. [data-tour="agent-system-prompt"] auto-opens the
        // Identity section first (the core reliability fix). An explicit
        // step.revealSection / ensureSidebarOpen still works for ad-hoc anchors.
        const reveal: { sidebar?: boolean; designerSection?: string } = revealForTarget(step.target) || {};
        const wantSidebar = step.ensureSidebarOpen || reveal.sidebar;
        const wantSection = step.revealSection || reveal.designerSection;
        if (wantSidebar) {
            try { window.dispatchEvent(new CustomEvent(TOUR_ENSURE_SIDEBAR_EVENT)); } catch (e) { /* ignore */ }
        }
        if (wantSection) {
            try { window.dispatchEvent(new CustomEvent(TOUR_OPEN_DESIGNER_SECTION, { detail: { section: wantSection } })); } catch (e) { /* ignore */ }
        }
        if (step.navigateTo && onNavigate) { navigatedRef.current = true; onNavigate(step.navigateTo); }

        // Centered step (no spotlight target).
        if (!step.target) { setRect(null); targetElRef.current = null; return undefined; }

        let cancelled = false;
        let raf: number | null = null;
        let acquired = false;
        const deadline = performance.now() + (step.timeoutMs || (step.navigateTo ? NAV_TIMEOUT : DEFAULT_TIMEOUT));

        const measure = (el: Element) => {
            const r = el.getBoundingClientRect();
            setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
        };

        const frame = () => {
            if (cancelled) return;
            const el = pickShowable(step.target);

            if (el) {
                if (targetElRef.current !== el) {
                    targetElRef.current = el;
                    if (!acquired) {
                        acquired = true;
                        try { el.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e) { /* ignore */ }
                    }
                }
                measure(el);
                raf = requestAnimationFrame(frame);
                return;
            }

            // Not currently showable.
            const stillExists = (() => { try { return !!document.querySelector(step.target as string); } catch (e) { return false; } })();

            // Interactive "targetGone": the element we were showing left the DOM
            // (e.g. the prompt box once the agent was created) → advance.
            if (acquired && step.advanceOn?.targetGone && !stillExists) {
                agentCreatedRef.current = true;
                goNext();
                return;
            }

            // Before lock-on, honour the resolve deadline.
            if (!acquired && performance.now() > deadline) {
                if (step.optional) { goNext(); return; }
                setRect(null); targetElRef.current = null; return; // graceful centered fallback
            }
            // Once acquired we keep tracking (the element may be re-mounting).
            raf = requestAnimationFrame(frame);
        };

        raf = requestAnimationFrame(frame);
        return () => { cancelled = true; if (raf) cancelAnimationFrame(raf); };
    }, [active, stepIndex, step, onNavigate, goNext]);

    // ── Keep glued on scroll / resize ──────────────────────────────────
    useEffect(() => {
        if (!active) return undefined;
        let frame: number | null = null;
        const reposition = () => {
            if (frame) cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => {
                const el = targetElRef.current;
                if (el && isShowable(el)) {
                    const r = el.getBoundingClientRect();
                    setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
                }
            });
        };
        window.addEventListener('resize', reposition);
        window.addEventListener('scroll', reposition, true);
        return () => {
            if (frame) cancelAnimationFrame(frame);
            window.removeEventListener('resize', reposition);
            window.removeEventListener('scroll', reposition, true);
        };
    }, [active]);
}
