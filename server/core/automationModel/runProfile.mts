/**
 * The RUN PROFILE: one record of what kind of run this is and what it may do.
 *
 * Three loose facts (mode, is_test, trigger_kind) are not enough for a surface
 * to decide what a run may do, and a resumed run must not re-derive them from
 * whatever is on its row: a partial run would lose its bound on a pause and run
 * the rest of the flow live, and a test run would hold the production running
 * marker and write the automation's last status. So the profile is
 * decided ONCE, when a run starts (profileFor), stored on the run row
 * (automation_runs.run_profile) and read back on resume and in every view
 * (profileOfRun). A resumed run keeps its profile: a resume never changes kind.
 *
 *   kind          production | test | dry
 *   copy          live | working: which copy ran. Still DECIDED by
 *                 core/automationRunner/definitionForRun.js (a managed automation
 *                 runs its live copy, test runs included); the profile records it.
 *   effects       real | simulated (a dry run synthesises its writes)
 *   pauses        real: an approval or form page pauses the run for a person;
 *                 synthesise: a headless dry run hands blanks downstream (marked);
 *                 harness: a scenario or golden supplies the answers
 *   approverSeat  configured (the step's own approvers) | tester (the sandbox
 *                 seat: the person who started the run decides alone)
 *   notify        outcome (success / failure to the owner's policy), approvers
 *                 (the approval request), tester (a "Test:" bell to the starter)
 *   answers       production: a form submission lands in the answers table;
 *                 none: a test never shows on the Answers dashboard
 *   stopAfterStepId  the step a partial run ends after ('only' and 'upTo' on a
 *                 root-graph target), kept across a pause so the continuation
 *                 stops where the author asked
 *   holdsMarker   the run claims the automation's running marker and writes its
 *                 lastStatus / lastRunAt (production only)
 *   pauseTtlMs    how long a test or dry pause waits; null = the step's own
 *                 deadline (env AUTOMATION_TEST_PAUSE_TTL_MS, default 24 h, 0 = the
 *                 step's own deadline)
 *   origin        who started it: trigger | builder | builder_step | test_link | mcp | api
 *
 * Legacy rows (no run_profile) derive a profile that reproduces the behaviour
 * they were started with: configured approvers, the marker for a live run, no
 * stop bound. isTestRun's legacy rule is TEST_TRIGGER_KINDS below.
 *
 * Pure: requires nothing (lint:scc-ratchet), reads the environment only through
 * the `env` argument (process.env by default).
 */

export type RunKind = 'production' | 'test' | 'dry';
export type RunCopy = 'live' | 'working';
export type RunOrigin = 'trigger' | 'builder' | 'builder_step' | 'test_link' | 'mcp' | 'api';
export type PauseHandling = 'real' | 'synthesise' | 'harness';
export type ApproverSeat = { kind: 'configured' } | { kind: 'tester'; userId: string | null };
export type PartialMode = 'only' | 'from' | 'upTo';

export type RunProfile = {
    v: 1;
    kind: RunKind;
    copy: RunCopy;
    effects: 'real' | 'simulated';
    pauses: PauseHandling;
    approverSeat: ApproverSeat;
    notify: { outcome: boolean; approvers: boolean; tester: boolean };
    answers: 'production' | 'none';
    stopAfterStepId: string | null;
    holdsMarker: boolean;
    pauseTtlMs: number | null;
    origin: RunOrigin;
};

/** A partial builder run (▶ Execute, retry-from, "Run up to here"). */
export type PartialScope = {
    mode: PartialMode;
    targetStepId: string | null;
    /** Where the target lives: the root graph (default), a loop body or a flowlet. */
    scope?: 'root' | 'loop' | 'layer';
};

/** What is known when a run starts. Everything is optional; the defaults are a plain live run. */
export type ProfileFacts = {
    mode?: string | null;
    triggerKind?: string | null;
    isTest?: boolean | null;
    startedByUserId?: string | null;
    /** The automation's owner: the sandbox seat when nobody is recorded as the starter. */
    ownerUserId?: string | null;
    partial?: PartialScope | null;
    origin?: string | null;
    /** A test harness (scenario, golden) supplies the pause answers. */
    harness?: unknown;
    /** The caller (the web builder) asks a dry run to pause for real at approvals and form pages. */
    pausesRequested?: boolean | null;
    /** Managed by a Solution stage: always the live copy. */
    managed?: boolean | null;
    /** The copy definitionForRun actually chose (wins over the derived one). */
    copy?: RunCopy | null;
};

type Env = Record<string, string | undefined>;

/** Trigger kinds that make a live-mode run a test (the legacy rule of isTestRun). */
export const TEST_TRIGGER_KINDS: ReadonlySet<string> = new Set(['manual_step', 'dry_run']);

const ORIGINS: ReadonlySet<string> = new Set(['trigger', 'builder', 'builder_step', 'test_link', 'mcp', 'api']);
const KINDS: ReadonlySet<string> = new Set(['production', 'test', 'dry']);
const PAUSES: ReadonlySet<string> = new Set(['real', 'synthesise', 'harness']);

export const DEFAULT_TEST_PAUSE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * AUTOMATION_TEST_PAUSE_TTL_MS: how long a test or dry pause waits, in ms.
 * Unset or unreadable: 24 h. 0: the step's own deadline (returned as null).
 */
export function testPauseTtlMs(env: Env = process.env): number | null {
    const raw = env.AUTOMATION_TEST_PAUSE_TTL_MS;
    if (raw === undefined || raw.trim() === '') return DEFAULT_TEST_PAUSE_TTL_MS;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return DEFAULT_TEST_PAUSE_TTL_MS;
    return n === 0 ? null : Math.floor(n);
}

/** The kind of run these facts describe. isTestRun(x) is `kindOf(x) !== 'production'`. */
export function kindOf(facts: Pick<ProfileFacts, 'mode' | 'triggerKind' | 'isTest'> = {}): RunKind {
    if (facts.mode === 'dry_run') return 'dry';
    if (facts.isTest) return 'test';
    if (typeof facts.triggerKind === 'string' && TEST_TRIGGER_KINDS.has(facts.triggerKind)) return 'test';
    return 'production';
}

function originOf(kind: RunKind, facts: ProfileFacts): RunOrigin {
    if (typeof facts.origin === 'string' && ORIGINS.has(facts.origin)) return facts.origin as RunOrigin;
    if (facts.triggerKind === 'manual_step') return 'builder_step';
    return kind === 'production' ? 'trigger' : 'builder';
}

/** The step a partial run stops after: the target of 'only' / 'upTo' in the root graph. */
export function stopAfterFor(partial: PartialScope | null | undefined): string | null {
    if (!partial || typeof partial !== 'object') return null;
    if (partial.mode !== 'only' && partial.mode !== 'upTo') return null;
    if (partial.scope && partial.scope !== 'root') return null;
    return typeof partial.targetStepId === 'string' && partial.targetStepId ? partial.targetStepId : null;
}

function testerSeat(facts: ProfileFacts): ApproverSeat {
    return { kind: 'tester', userId: facts.startedByUserId || facts.ownerUserId || null };
}

function copyOf(kind: RunKind, facts: ProfileFacts): RunCopy {
    if (facts.copy === 'live' || facts.copy === 'working') return facts.copy;
    if (facts.managed) return 'live';
    return kind === 'production' ? 'live' : 'working';
}

/** The profile of a run that starts now. */
export function profileFor(facts: ProfileFacts = {}, env: Env = process.env): RunProfile {
    const kind = kindOf(facts);
    const base = {
        v: 1 as const,
        kind,
        copy: copyOf(kind, facts),
        stopAfterStepId: stopAfterFor(facts.partial),
        origin: originOf(kind, facts),
    };
    if (kind === 'production') {
        return {
            ...base,
            effects: 'real',
            pauses: 'real',
            approverSeat: { kind: 'configured' },
            notify: { outcome: true, approvers: true, tester: false },
            answers: 'production',
            holdsMarker: true,
            pauseTtlMs: null,
        };
    }
    if (kind === 'test') {
        return {
            ...base,
            effects: 'real',
            pauses: 'real',
            approverSeat: testerSeat(facts),
            notify: { outcome: false, approvers: false, tester: true },
            answers: 'none',
            holdsMarker: false,
            pauseTtlMs: testPauseTtlMs(env),
        };
    }
    const hasHarness = facts.harness !== undefined && facts.harness !== null && facts.harness !== false;
    return {
        ...base,
        effects: 'simulated',
        pauses: hasHarness ? 'harness' : (facts.pausesRequested ? 'real' : 'synthesise'),
        approverSeat: testerSeat(facts),
        notify: { outcome: false, approvers: false, tester: false },
        answers: 'none',
        holdsMarker: false,
        pauseTtlMs: testPauseTtlMs(env),
    };
}

/** A run row as far as its profile goes: the mapped row (camelCase) or the raw one. */
export type ProfileRow = {
    profile?: unknown;
    runProfile?: unknown;
    run_profile?: unknown;
    mode?: string | null;
    isTest?: boolean | null;
    is_test?: boolean | null;
    triggerKind?: string | null;
    trigger_kind?: string | null;
    startedByUserId?: string | null;
    started_by_user_id?: string | null;
};

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => !!x && typeof x === 'object' && !Array.isArray(x);
const bool = (x: unknown, fallback: boolean): boolean => (typeof x === 'boolean' ? x : fallback);
const str = (x: unknown): string | null => (typeof x === 'string' && x ? x : null);

function seatOf(x: unknown, fallback: ApproverSeat): ApproverSeat {
    if (!isObj(x)) return fallback;
    if (x.kind === 'configured') return { kind: 'configured' };
    if (x.kind === 'tester') return { kind: 'tester', userId: str(x.userId) };
    return fallback;
}

/**
 * A stored profile, completed field by field from the preset of its kind (a
 * value of the wrong type falls back to the preset). Null when it is not a v1
 * profile at all.
 */
export function normalizeProfile(raw: unknown): RunProfile | null {
    let x: unknown = raw;
    if (typeof x === 'string') {
        try { x = JSON.parse(x); } catch { return null; }
    }
    if (!isObj(x) || x.v !== 1 || typeof x.kind !== 'string' || !KINDS.has(x.kind)) return null;
    const kind = x.kind as RunKind;
    const preset = profileFor({ mode: kind === 'dry' ? 'dry_run' : 'live', isTest: kind === 'test' }, {});
    const notify = isObj(x.notify) ? x.notify : {};
    const ttl = x.pauseTtlMs;
    return {
        v: 1,
        kind,
        copy: x.copy === 'live' || x.copy === 'working' ? x.copy : preset.copy,
        effects: x.effects === 'real' || x.effects === 'simulated' ? x.effects : preset.effects,
        pauses: typeof x.pauses === 'string' && PAUSES.has(x.pauses) ? x.pauses as PauseHandling : preset.pauses,
        approverSeat: seatOf(x.approverSeat, preset.approverSeat),
        notify: {
            outcome: bool(notify.outcome, preset.notify.outcome),
            approvers: bool(notify.approvers, preset.notify.approvers),
            tester: bool(notify.tester, preset.notify.tester),
        },
        answers: x.answers === 'production' || x.answers === 'none' ? x.answers : preset.answers,
        stopAfterStepId: str(x.stopAfterStepId),
        holdsMarker: bool(x.holdsMarker, preset.holdsMarker),
        pauseTtlMs: typeof ttl === 'number' && Number.isFinite(ttl) && ttl > 0 ? ttl : null,
        origin: typeof x.origin === 'string' && ORIGINS.has(x.origin) ? x.origin as RunOrigin : preset.origin,
    };
}

/**
 * The profile of a LEGACY row (no run_profile): exactly the behaviour it was
 * started with. Approvals went to the configured approvers, a live-mode run held
 * the marker, a dry run synthesised its pauses, the owner heard about a
 * production outcome only, and nothing remembered a partial run's bound.
 */
export function legacyProfile(facts: Pick<ProfileFacts, 'mode' | 'triggerKind' | 'isTest'>): RunProfile {
    const kind = kindOf(facts);
    return {
        v: 1,
        kind,
        copy: kind === 'production' ? 'live' : 'working',
        effects: kind === 'dry' ? 'simulated' : 'real',
        pauses: kind === 'dry' ? 'synthesise' : 'real',
        approverSeat: { kind: 'configured' },
        notify: { outcome: kind === 'production', approvers: true, tester: false },
        answers: 'production',
        stopAfterStepId: null,
        holdsMarker: (facts.mode ?? 'live') === 'live',
        pauseTtlMs: null,
        origin: originOf(kind, { triggerKind: facts.triggerKind }),
    };
}

/** The profile of a recorded run: its stored profile, else the one its legacy columns imply. */
export function profileOfRun(row: ProfileRow | null | undefined): RunProfile {
    const r: ProfileRow = row || {};
    const stored = normalizeProfile(r.profile ?? r.runProfile ?? r.run_profile ?? null);
    if (stored) return stored;
    return legacyProfile({
        mode: r.mode ?? 'live',
        triggerKind: r.triggerKind ?? r.trigger_kind ?? null,
        isTest: !!(r.isTest ?? r.is_test),
    });
}

/** True when the facts describe a run of the working copy (test or dry); see definitionForRun.isTestRun. */
export function isTestRun(facts: Pick<ProfileFacts, 'mode' | 'triggerKind' | 'isTest'> = {}): boolean {
    return profileFor(facts, {}).kind !== 'production';
}
