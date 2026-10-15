/** Typen van de testset-feiten (testSetFacts). Alleen types. */

import type { REFUSAL, refusalFor } from './testSetFacts';

/** De resultaatregels van een run. */
export interface RunResults {
    items?: unknown;
    source?: unknown;
    testCount?: unknown;
    unpublishedChanges?: unknown;
}

/** Een run zoals de server hem levert, of net afgerond. */
export interface TestRun {
    total?: unknown;
    passed?: unknown;
    ranAt?: unknown;
    version?: unknown;
    results?: RunResults | null;
}

/** Een test uit de lijst, voor de verouderings-controle. */
export interface TestRow {
    id?: unknown;
    createdAt?: unknown;
    updatedAt?: unknown;
}

/** Eén testresultaat uit een run. */
export interface TestItem {
    testId?: unknown;
    name?: string | null;
    status?: unknown;
    forbiddenHits?: unknown;
    toolsMissing?: unknown;
    toolsWithheld?: unknown;
    reason?: unknown;
    decidedBy?: unknown;
}

/** De kinds van een weigering, zoals `refusalFor` ze teruggeeft. */
export type RefusalKind = (typeof REFUSAL)[keyof typeof REFUSAL];

/** Wat `refusalFor` leest: de HTTP-status, het lichaam en/of een code. */
export interface RefusalInput {
    status?: unknown;
    body?: { code?: unknown; error?: unknown } | null;
    code?: string | null;
}

/** Wat `summariseRun` leest. */
export interface SummariseInput {
    lastRun?: TestRun | null;
    lastRunUnknown?: boolean;
    tests?: TestRow[] | null;
}

/** De voortgang van één druk op Run. */
export interface RunProgress {
    status: 'running' | 'complete' | 'unfinished';
    total: number | null;
    done: number;
    items: unknown[];
    passed: number | null;
    notStored: string | null;
    run?: TestRun | null;
    refusal?: ReturnType<typeof refusalFor>;
}
