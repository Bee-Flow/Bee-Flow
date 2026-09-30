/**
 * The Test tab's rules, as the web's TestTab.jsx states them.
 *
 * `POST /api/skills/:id/test` runs one agent turn with this skill and grades
 * the answer step by step. The stream sends `answer` first and the verdict
 * (`done { run }`) after. Three things are never smoothed over:
 *   - a run that could not be graded shows the failure, not an empty list;
 *   - an unknown step status is drawn as a warning, never as a pass;
 *   - a stream that ENDED without `done` or `error` is a cut stream, not a
 *     clean run that found nothing.
 */

import type { TranslateFn } from '@/core/i18n';

import type { SkillStep, StepRef, StepResult, TestRun } from './types';

export type StepStatus = 'ok' | 'warning' | 'error';

/** An unknown status is a warning — the direction the server clamps in too. */
export function stepStatus(status: string | undefined): StepStatus {
    return status === 'ok' || status === 'warning' || status === 'error' ? status : 'warning';
}

/** Codes the server answers with, mapped to the web's copy. */
export function testErrorMessage(t: TranslateFn, code: string | undefined, message?: string): string {
    switch (code) {
        case 'no_steps': return t('skills_studio.test.no_steps', 'Add steps first — a test grades one step at a time.');
        case 'empty_skill': return t('skills_studio.test.err_empty', 'This skill has nothing to follow yet — write the steps first.');
        case 'grading_failed': return t('skills_studio.test.err_grading', 'The answer came back, but it could not be graded. Try again.');
        case 'no_answer': return t('skills_studio.test.err_no_answer', 'The model returned no answer, so there is nothing to grade.');
        case 'no_model': return t('skills_studio.test.err_no_model', 'No AI model is configured for this workspace.');
        case 'agent_check_failed': return t('skills_studio.test.err_agents', 'Could not check which agents you may use. Try again.');
        case 'kb_check_failed':
            return t('skills_studio.test.err_kb_check', 'Could not check which knowledge bases this skill may use, so no test was run. Try again.');
        case 'stream_cut':
            return t('skills_studio.test.err_stream_cut', 'The test stopped before a verdict came back, so nothing was graded or saved. Try again.');
        default: return message || t('skills_studio.test.err_generic', 'Could not run this test.');
    }
}

/** The first flagged step's first reference — what the advice is about. */
export function adviceRef(run: TestRun | null, steps: readonly SkillStep[]): StepRef | null {
    const flagged = run?.results.find((r: StepResult) => r.status && r.status !== 'ok');
    if (!flagged) return null;
    return steps.find((s) => s.id === flagged.stepId)?.refs[0] ?? null;
}

/** Where a reference opens on the phone, or null for a kind with no screen. */
export function refHref(ref: StepRef): string | null {
    if (ref.kind === 'kb') return `/knowledge/${encodeURIComponent(ref.id)}`;
    if (ref.kind === 'automation') return `/automations/${encodeURIComponent(ref.id)}`;
    return null;
}
