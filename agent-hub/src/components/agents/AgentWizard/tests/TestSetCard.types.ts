import type { TranslateFn } from '@/hooks/useTranslation';
import type { Refusal, RunSummary, RunProgress, TestItem, AgentTest, TestRun } from './testSetFacts';
import type { RelativeTimeInput } from '@/hooks/useRelativeTime';
import type React from 'react';

export interface StatusDotProps {
    status: string;
}

/** The refusal, with the button for trying again if that makes sense. */
export interface RefusalNoticeProps {
    t: TranslateFn;
    refusal: Refusal;
    onRetry?: (() => void) | null;
}

/**
  * "11 / 12 passed", or the reason there is no number.
  *
  * ORDER: a run you just watched go by comes before the stored run. Otherwise,
  * after an unsaved run (a "Test as" simulation, or a run whose save failed), the
  * headline shows the count of the PREVIOUS run, while the failure line and the
  * question lines below it are about the run that just ran — and the refusal
  * "…so this score is not kept" then reads as a statement about exactly the
  * number that WAS in fact kept.
 */
export interface ScoreLineProps {
    t: TranslateFn;
    summary: RunSummary;
    progress: RunProgress | null;
    questionCount: number;
}

/**
  * What the result was about: which version, how many questions, and how old.
  *
  * `justRan` is the run that just finished. If that one was NOT saved, the
  * headline is about that run and this line would be about an older one: "about
  * v3" above a score that has nothing to do with v3. Better nothing: of this run
  * we only know the version once it is saved.
 */
export interface AboutLineProps {
    t: TranslateFn;
    summary: RunSummary;
    justRan?: { passed: number; total: number | null; kept: boolean; notStored: string | null } | null;
}

/** The failure line: the most urgent non-green result, with why. */
export interface FailLineProps {
    t: TranslateFn;
    items: TestItem[];
}

/** One question with the verdict the last run gave on it, or no verdict. */
export interface TestRowProps {
    t: TranslateFn;
    test: AgentTest;
    item: TestItem | null;
}

export interface TestSetCardProps {
    t: TranslateFn;
    rel?: ((dateLike: RelativeTimeInput) => string) | null;
    tests?: AgentTest[];
    onRetryTests?: (() => void) | null;
    lastRun?: TestRun | null;
    onOpenDetail?: (() => void) | null;
    progress?: RunProgress | null;
    onRetryRun?: (() => void) | null;
    onRun?: (() => void) | null;
    onAddFromChat?: React.MouseEventHandler<HTMLButtonElement> | null;
    ro?: boolean;
    testsState?: string;
    readRefusal?: Refusal | null;
    lastRunUnknown?: boolean;
    runs?: TestRun[];
    runsState?: string;
    runsUnknown?: boolean;
    runsKeep?: number;
    refusal?: Refusal | null;
    running?: boolean;
    canAddFromChat?: boolean;
}
