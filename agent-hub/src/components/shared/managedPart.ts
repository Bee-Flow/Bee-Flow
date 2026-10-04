/**
 * A part managed by a Solution stage (design 9, "Managed banner"): pure helpers
 * for the builders that show one read-only.
 *
 * The data comes from the SERVER, never from a client-side pipeline fetch (a
 * part only knows its stage project id, and `/:id/pipeline` answers 404 for a
 * stage id). Every part GET carries `managed: null | { solutionId, solutionName,
 * stage, releaseSeq, devRef }` (stores/solutionStage/managedPayload.js), and a
 * write the stage refuses answers 409 `managed_part` (or, for a run or a
 * publish of a part no release has reached yet, `managed_part_not_deployed`).
 * This module reads exactly those two shapes and nothing else.
 */

export type ManagedStage = 'uat' | 'prd';

export interface ManagedDevRef {
    kind: string;
    id: string;
}

/** What a part GET says about the stage that manages it. */
export interface ManagedPart {
    solutionId: string;
    solutionName: string | null;
    stage: ManagedStage;
    releaseSeq: number | null;
    devRef: ManagedDevRef | null;
}

export type ManagedReason = 'managed' | 'not_deployed';

/**
 * A refused write, in the shape the banner takes. `managed` is whatever the
 * refusal body could say about the stage: the 409 `managed_part` body carries
 * `details: { solutionId, stage }` only, so the name, release and Dev part are
 * null there. A `managed_part_not_deployed` body names no Solution at all.
 */
export interface ManagedBannerInfo {
    reason: ManagedReason;
    code: 'managed_part' | 'managed_part_not_deployed';
    message: string;
    managed: ManagedPart | null;
}

const STAGES: ReadonlySet<string> = new Set(['uat', 'prd']);

/**
 * The payload wrappers a part route may put the part in. `managed` itself sits
 * either beside the part (`{ automation, managed }`, `{ app, readOnly,
 * managed }`) or inside it (`{ document: { managed } }`, `{ datatable: {
 * managed } }`, an agent or skill row that carries it directly).
 */
const WRAPPERS = ['automation', 'step', 'app', 'webpage', 'page', 'agent', 'skill', 'datatable', 'knowledgeBase', 'kb', 'document', 'form'] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
    return typeof v === 'string' && v ? v : null;
}

function seqOf(v: unknown): number | null {
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

function devRefOf(v: unknown): ManagedDevRef | null {
    if (!isRecord(v)) return null;
    const kind = str(v.kind);
    const id = str(v.id);
    return kind && id ? { kind, id } : null;
}

/** One `managed` value as the server sends it, or null when it is not one. */
export function parseManaged(value: unknown): ManagedPart | null {
    if (!isRecord(value)) return null;
    const solutionId = str(value.solutionId);
    const stage = typeof value.stage === 'string' && STAGES.has(value.stage) ? (value.stage as ManagedStage) : null;
    if (!solutionId || !stage) return null;
    return {
        solutionId,
        solutionName: str(value.solutionName),
        stage,
        releaseSeq: seqOf(value.releaseSeq),
        devRef: devRefOf(value.devRef),
    };
}

/**
 * The `managed` field of a part payload (a GET answer, a row, a PUT answer), or
 * null for an unmanaged part and for a payload that says nothing. A malformed
 * `managed` is treated as absent rather than guessed at.
 */
export function managedOf(payload: unknown): ManagedPart | null {
    if (!isRecord(payload)) return null;
    if ('managed' in payload) return parseManaged(payload.managed);
    for (const key of WRAPPERS) {
        const inner = payload[key];
        if (isRecord(inner) && 'managed' in inner) return parseManaged(inner.managed);
    }
    return null;
}

export function isManaged(payload: unknown): boolean {
    return managedOf(payload) !== null;
}

/**
 * Whether `payload` says anything about management at all, `managed: null`
 * included. A caller that keeps the last known state across answers which
 * carry no such field (an activate or PUT answer) needs to tell "this part is
 * not managed" from "this answer did not say".
 */
export function declaresManaged(payload: unknown): boolean {
    if (!isRecord(payload)) return false;
    if ('managed' in payload) return true;
    return WRAPPERS.some((key) => isRecord(payload[key]) && 'managed' in (payload[key] as Record<string, unknown>));
}

const CODES = {
    managed_part: 'managed',
    managed_part_not_deployed: 'not_deployed',
} as const;

/**
 * A refusal body (or an Error that carries one) as banner info; null when it
 * is not one of the two managed refusals.
 *
 * Accepts the parsed JSON body `{ error, code, details }`, an Error with `.code`
 * and `.message` and optionally `.body` / `.details` (the shape every client
 * wrapper in this app throws), and tolerates `details` being an array (the
 * validator's records) or absent.
 */
export function fromError(source: unknown): ManagedBannerInfo | null {
    if (!isRecord(source)) return null;
    // An Error from a client wrapper keeps the parsed body on `.body`.
    const body = isRecord(source.body) ? source.body : source;
    const code = str(body.code) ?? str(source.code);
    if (code !== 'managed_part' && code !== 'managed_part_not_deployed') return null;
    const message = str(body.error) ?? str(body.message) ?? str(source.message) ?? '';
    const details = isRecord(body.details) ? body.details : (isRecord(source.details) ? source.details : null);
    return {
        reason: CODES[code],
        code,
        message,
        managed: parseManaged(details ? { solutionId: details.solutionId, stage: details.stage } : null),
    };
}

/** The banner info of an Error thrown by a client wrapper, or null. */
export function managedRefusalOf(err: unknown): ManagedBannerInfo | null {
    if (isRecord(err) && isRecord(err.managed) && (err.managed.code === 'managed_part' || err.managed.code === 'managed_part_not_deployed')) {
        return err.managed as unknown as ManagedBannerInfo;
    }
    return fromError(err);
}

// ── Links ──────────────────────────────────────────────────────────────────

/** Studio URL segment per stamped part kind (studioApps.jsx `urlSegment`). */
const DEV_SEGMENT: Readonly<Record<string, string>> = {
    automation: 'automations',
    app: 'apps',
    webpage: 'webpages',
    datatable: 'datatables',
    agent: 'agents',
    knowledge_base: 'knowledge',
    skill: 'skills',
    document: 'documents',
};

const enc = encodeURIComponent;

/**
 * Where "Open in Dev" goes, as the in-app route `onNavigate` takes: the Dev
 * part when the server named it, else the Solution (its Dev view is the
 * default one).
 */
export function devTarget(managed: ManagedPart): string {
    const ref = managed.devRef;
    const segment = ref ? DEV_SEGMENT[ref.kind] : undefined;
    if (ref && segment) return `studio/${segment}/${enc(ref.id)}`;
    return `studio/solutions/${enc(managed.solutionId)}`;
}

/** Where "Stage settings" goes: the Solution on this stage, at its Settings tab. */
export function stageSettingsTarget(managed: ManagedPart): string {
    return `studio/solutions/${enc(managed.solutionId)}?stage=${managed.stage}&tab=settings`;
}

/** The pipeline of a Solution (the Dev view of it, on its Pipeline tab). */
export function pipelineTarget(solutionId: string): string {
    return `studio/solutions/${enc(solutionId)}?tab=pipeline`;
}

/** The in-app route as a real link (opens in a new tab too). */
export function hrefOf(target: string): string {
    return `/app/${target}`;
}
