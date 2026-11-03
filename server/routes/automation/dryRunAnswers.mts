/**
 * "Restart with my answers": POST /:id/dry-run { answersFromRunId } plays a new
 * dry run with the answers an earlier run of the same automation was given, so
 * an author who typed three form pages and hit a failing step after page 3 can
 * fix the step and try again without typing them (pauses F12).
 *
 * The earlier run is read through the one door the test-data features share
 * (automation/journeyReader.js via runDataAccess): the caller must be able to
 * read its data. A journey that used its starter's own connections is refused
 * (409 caller_run_not_capturable): its answers belong to that person, and the
 * new dry run's rows are read by every editor. Nothing is saved; the answers
 * live only in the dry run's harness (core/automationRunner/testHarness.js).
 *
 * What is played, by the rules of the saved scenarios: typed form answers
 * (automation/testing/formAnswers.js) and the approval decisions with their
 * declared answers (automation/testing/approvalAnswers.mts), never an uploaded
 * file, a record picked from an app or who decided. A finished, failed or
 * still paused journey all count: the answers given so far are what an author
 * wants back.
 *
 *   404 run_not_found              no such run, a run of another automation, or
 *                                  one the caller cannot see at all
 *   403                            the caller may not read this run's data
 *   409 caller_run_not_capturable  a leg used its starter's own connections
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type Req = { session?: unknown };
type Res = unknown;
type RunRow = { id: string; automationId: string; version?: number; triggerPayload?: unknown; connectionsMode?: string | null };
type Found = { run: RunRow; root: RunRow; legs: RunRow[]; runIds: string[] };

export type RunAnswersHarness = {
    triggerPayload: unknown;
    harness: {
        source: { kind: 'run'; id: string };
        formAnswers: { pages: Record<string, Record<string, unknown>> };
        approvals: Record<string, { decision: 'approve' | 'reject'; answers: Record<string, unknown> }>;
        aiAnswers: 'live';
    };
};

export interface DryRunAnswersDeps {
    store: () => {
        getVersionDefinition: (automationId: string, version: number | undefined) => Promise<unknown>;
        getRunStepsForChain: (runId: string) => Promise<Array<{ runId?: string }>>;
    };
    readableRun: (req: Req, res: Res, runId: string, what?: string) => Promise<Found | null>;
}

function httpError(status: number, code: string, message: string): Error {
    const { HttpError } = nodeRequire('../../core/http/errors') as { HttpError: new (s: number, c: string, m: string) => Error };
    return new HttpError(status, code, message);
}

function defaultDeps(): DryRunAnswersDeps {
    const store = () => nodeRequire('../../stores/automationStore');
    const { makeRunDataAccess } = nodeRequire('../../automation/testing/runDataAccess') as {
        makeRunDataAccess: () => { readableRun: DryRunAnswersDeps['readableRun'] };
    };
    const access = makeRunDataAccess();
    return { store, readableRun: (req, res, runId, what) => access.readableRun(req, res, runId, what) };
}

/**
 * The trigger payload and harness of a dry run that replays run `runId`'s
 * answers, or null after the read guard answered 403.
 */
export async function answersFromRun(
    req: Req, res: Res, automation: { id: string; definition?: unknown }, runId: string,
    deps: DryRunAnswersDeps = defaultDeps(),
): Promise<RunAnswersHarness | null> {
    const found = await deps.readableRun(req, res, runId, 'restart with its answers');
    if (!found) return null;
    if (found.run.automationId !== automation.id) throw httpError(404, 'run_not_found', 'Not found');
    if ([found.run, ...found.legs].some((leg) => leg.connectionsMode === 'caller')) {
        throw httpError(409, 'caller_run_not_capturable',
            'This run used the connections of the person who started it, so its answers cannot be replayed.');
    }
    const definition = (await deps.store().getVersionDefinition(found.run.automationId, found.run.version)) || automation.definition;
    const readable = new Set(found.runIds);
    const steps = (await deps.store().getRunStepsForChain(found.root.id)).filter((s) => typeof s.runId === 'string' && readable.has(s.runId));
    const { answersFromJourney } = nodeRequire('../../automation/testing/formAnswers') as {
        answersFromJourney: (i: { definition: unknown; rootRun: unknown; steps: unknown[] }) => { trigger: Record<string, unknown> | null; pages: Record<string, Record<string, unknown>> };
    };
    const { approvalAnswersFromJourney } = nodeRequire('../../automation/testing/approvalAnswers.mts') as typeof import('../../automation/testing/approvalAnswers.mts');
    const answers = answersFromJourney({ definition, rootRun: found.root, steps });
    return {
        // A form trigger replays its typed answers only; another trigger the payload it entered with.
        triggerPayload: answers.trigger ?? found.root.triggerPayload ?? null,
        harness: {
            source: { kind: 'run', id: found.root.id },
            formAnswers: { pages: answers.pages },
            approvals: approvalAnswersFromJourney({ definition, steps }),
            aiAnswers: 'live',
        },
    };
}
