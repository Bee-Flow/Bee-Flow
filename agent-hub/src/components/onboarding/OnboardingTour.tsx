import { useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from '../../hooks/useTranslation';
import { TourCard } from './TourCard';
import { TourSpotlight, TourStyles } from './TourSpotlight';
import { useTourCardStyle } from './useTourCardStyle';
import { useTourRun } from './useTourRun';
import { useTourStepInteraction } from './useTourStepInteraction';
import { useTourStepTracking } from './useTourStepTracking';
import type { OnboardingTourProps } from './OnboardingTour.types';

/**
 * OnboardingTour — a lightweight, dependency-free guided tour for new users.
 *
 * Spotlights real elements (sidebar nav, settings, the agent creator), drives
 * navigation where a stop lives on another view, and runs INTERACTIVE steps that
 * wait for the user to actually do something (type / submit) before advancing.
 * Completion is stored per-user, server-side (the database), via
 * POST /ai/user-settings; a localStorage flag is kept only as a same-browser
 * flash-guard so the tour doesn't briefly re-appear before the server responds.
 *
 * Reliability: the active step runs a requestAnimationFrame resolve+measure loop
 * that re-queries the selector every frame and only locks onto a node that is
 * actually showable (in the DOM, visible, non-zero box, on screen). This tracks
 * elements that mount late (lazy panels), move (sidebar width animation), get
 * replaced on re-render, or are duplicated off-screen (sidebar compact strip).
 * If a target can't be shown it falls back to a centered card.
 *
 * Props:
 *   user        — current user ({ id, permissions, orgRole, isAdmin, … })
 *   onNavigate  — App's navigateToPage(pageKey)
 *   currentPage — active page key; auto-start only fires on the chat home
 */

export default function OnboardingTour({ user, onNavigate, currentPage }: OnboardingTourProps) {
    const { t } = useTranslation();
    const { active, steps, stepIndex, rect, setRect, step, targetElRef, navigatedRef, agentCreatedRef, finish, goNext, goPrev } = useTourRun({ user, onNavigate, currentPage });
    const cardRef = useRef<HTMLDivElement>(null);

    useTourStepTracking({ active, step, stepIndex, onNavigate, goNext, setRect, targetElRef, navigatedRef, agentCreatedRef });
    useTourStepInteraction({ active, step, stepIndex, finish, goNext, goPrev, cardRef });
    const cardStyle = useTourCardStyle(rect, step);

    if (!active || !step) return null;

    const interactive = !!step.interactive;
    const title = t(step.titleKey, step.titleFallback);
    const body = t(step.bodyKey, step.bodyFallback);
    const actionHint = interactive ? t(step.actionHintKey as string, step.actionHintFallback) : null;

    return createPortal(
        <div aria-live="polite">
            {/* Click-catcher — blocks the app behind the tour, EXCEPT on
                interactive steps where the user must touch the real element. */}
            {!interactive && <div style={{ position: 'fixed', inset: 0, zIndex: 9997 }} />}

            {/* Dimmer: spotlight cutout when we have a target, else a flat scrim. */}
            <TourSpotlight rect={rect} />

            {/* Card */}
            <TourCard
                step={step}
                steps={steps}
                stepIndex={stepIndex}
                title={title}
                body={body}
                actionHint={actionHint}
                cardRef={cardRef}
                cardStyle={cardStyle}
                onFinish={finish}
                onNext={goNext}
                onPrev={goPrev}
            />

            <TourStyles />
        </div>,
        document.body,
    );
}
