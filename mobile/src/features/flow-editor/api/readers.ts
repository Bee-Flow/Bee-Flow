/**
 * Contract readers for the routine row as the editor holds it, and for what
 * the save paths and the test runs answer.
 *
 * The row is the automations feature's reader (rowToAutomation's allow-list);
 * the only difference is the definition, which goes through
 * `asDefinition` so `steps` and `edges` are always arrays — a stored `{}`
 * (BFSF-318) arrives here as an empty graph, never as a crash in the outline.
 */

import { field, nullable, pick } from '@/core/api/contract';
import { readAutomation, readIssues, readRun, readRunStep } from '@/features/automations';

import type { AnswersOutcome, FlowAutomation, FlowExport, RestoreResult, SaveResult, StepRunResult, TestRunResult } from './types';
import { asDefinition } from '../model/normalize';

export function readFlowAutomation(raw: unknown): FlowAutomation {
    const row = readAutomation(raw);
    return { ...row, definition: asDefinition(row.definition) };
}

const readRow = nullable(readFlowAutomation);

function readAnswers(raw: unknown): AnswersOutcome | null {
    return field.recordOrNull(pick(raw, 'answers'));
}

/**
 * POST /import and the template installs: the row, the
 * findings that did not block (draft-stage completeness checks, knowledge-base
 * links, pinned samples) and what the form's answers table did.
 */
export function readSaveResult(raw: unknown): SaveResult {
    return {
        automation: readRow(pick(raw, 'automation')),
        warnings: readIssues(pick(raw, 'warnings'), 'warning'),
        answers: readAnswers(raw),
    };
}

/** POST /:id/versions/:vid/restore. */
export function readRestoreResult(raw: unknown): RestoreResult {
    return {
        automation: readRow(pick(raw, 'automation')),
        restoredFromVersion: field.numOrNull(pick(raw, 'restoredFromVersion')),
        answers: readAnswers(raw),
    };
}

const readRunOrNull = nullable(readRun);
const readStepOrNull = nullable(readRunStep);

/** POST /:id/dry-run — the run and every step row it recorded. */
export function readTestRun(raw: unknown): TestRunResult {
    return {
        run: readRunOrNull(pick(raw, 'run')),
        steps: field.list(readRunStep)(pick(raw, 'steps')).filter((s) => s.stepId !== ''),
    };
}

/** POST /:id/steps/:stepId/run — as a dry run, plus the asked-for step's own row. */
export function readStepRun(raw: unknown): StepRunResult {
    return { ...readTestRun(raw), stepRecord: readStepOrNull(pick(raw, 'stepRecord')) };
}

/** GET /:id/export. The warnings are sentences (portability.js pushes strings). */
export function readExport(raw: unknown): FlowExport {
    return {
        envelope: field.recordOrNull(pick(raw, 'envelope')),
        warnings: field.strArray(pick(raw, 'warnings')),
    };
}
