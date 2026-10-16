import type { ReactNode } from 'react';
import type { StepAdvanceOn } from './lessons.types';

// What a tour step may wait for before it advances on its own.
export type TourAdvanceOn = StepAdvanceOn;

export interface TourStep {
    id: string;
    target?: string;
    titleKey?: string;
    titleFallback?: string;
    bodyKey?: string;
    bodyFallback?: string;
    actionHintKey?: string;
    actionHintFallback?: string;
    interactive?: boolean;
    placement?: string;
    navigateTo?: string;
    ensureSidebarOpen?: boolean;
    revealSection?: string;
    requiresAgentCreated?: boolean;
    optional?: boolean;
    timeoutMs?: number;
    advanceOn?: TourAdvanceOn;
    icon?: ReactNode;
}

export interface TargetRect {
    top: number;
    left: number;
    width: number;
    height: number;
}

// The detail of a TOUR_START_EVENT: which lesson to run and where to return.
export interface TourStartDetail {
    lessonId?: string;
    returnTo?: string;
}

export interface OnboardingTourProps {
    user?: { id?: string } | null;
    onNavigate?: (page: string) => void;
    currentPage?: string;
}
