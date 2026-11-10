/**
 * The shapes the request_approval step controls write, in the form canonicalize stores them
 * (server/appStudio/canonicalize/approvals.js). A control hands its edit through one of these, so
 * what it writes is what the server keeps: no empty label, no `required: false`, no seat nobody
 * picked, no stage without an approver. A shape the server would rewrite on save is a shape the
 * editor would show differently after a reload.
 *
 * What these do NOT do is trim: a box that trims while someone types eats the space between two
 * words. The controls trim on blur; the server trims on save.
 */

export type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

// ── Approver questions ──────────────────────────────────────────────────────

/** canonicalize/approvals APPROVAL_QUESTION_TYPES: the form vocabulary without `file`. */
const APPROVAL_QUESTION_TYPES = ['text', 'textarea', 'number', 'date', 'email', 'select', 'checkbox'];
export const MAX_APPROVAL_QUESTIONS = 20;

export interface ApprovalQuestion {
    name: string;
    type: string;
    label?: string;
    help?: string;
    placeholder?: string;
    required?: boolean;
    options?: unknown[];
}

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v !== '';

/** One question as stored. `name` stays as given: a later template may already read it. */
function canonicalQuestion(raw: Obj): ApprovalQuestion {
    const type = APPROVAL_QUESTION_TYPES.includes(raw.type as string) ? (raw.type as string) : 'text';
    const q: ApprovalQuestion = { name: typeof raw.name === 'string' ? raw.name : '', type };
    if (nonEmpty(raw.label)) q.label = raw.label;
    if (nonEmpty(raw.help)) q.help = raw.help;
    if (nonEmpty(raw.placeholder)) q.placeholder = raw.placeholder;
    if (raw.required === true) q.required = true;
    if (type === 'select' && Array.isArray(raw.options)) q.options = raw.options;
    return q;
}

export function canonicalQuestions(list: unknown): ApprovalQuestion[] {
    return (Array.isArray(list) ? list : []).filter(isObj).map(canonicalQuestion).slice(0, MAX_APPROVAL_QUESTIONS);
}

// ── Stage chain ─────────────────────────────────────────────────────────────

export interface Seat { userId?: string; groupId?: string }

export interface ApprovalStage {
    key: string;
    approvers: Seat[];
    rule: string;
    name?: unknown;
    description?: unknown;
    quorum?: number;
    when?: string;
}

const STAGE_RULE_VALUES = ['all', 'first', 'quorum'];
/** core/automationModel/approvalStages MAX_SEATS_PER_STAGE. */
const MAX_STAGE_SEATS = 10;

/** A stage's name or description: a non-blank string, or a binding (App Studio allows both). */
function stageText(v: unknown): unknown {
    if (typeof v === 'string') return v.trim() ? v : undefined;
    return isObj(v) ? v : undefined;
}

/** One stage as stored, with its key untouched (votes are filed under it). Null when nobody sits in it. */
function canonicalStage(raw: Obj): ApprovalStage | null {
    const seen = new Set<string>();
    const approvers = (Array.isArray(raw.approvers) ? raw.approvers : []).filter(isObj)
        .map((s): Seat | null => (nonEmpty(s.userId) ? { userId: s.userId } : (nonEmpty(s.groupId) ? { groupId: s.groupId } : null)))
        .filter((s): s is Seat => {
            const id = s ? (s.userId ? `u:${s.userId}` : `g:${s.groupId}`) : '';
            if (!id || seen.has(id)) return false;
            seen.add(id);
            return true;
        })
        .slice(0, MAX_STAGE_SEATS);
    if (!approvers.length) return null;
    const rule = STAGE_RULE_VALUES.includes(raw.rule as string) ? (raw.rule as string) : 'all';
    const stage: ApprovalStage = { key: typeof raw.key === 'string' ? raw.key : '', approvers, rule };
    const name = stageText(raw.name);
    if (name !== undefined) stage.name = name;
    const description = stageText(raw.description);
    if (description !== undefined) stage.description = description;
    if (rule === 'quorum') {
        const n = Math.round(Number(raw.quorum));
        stage.quorum = Number.isFinite(n) ? Math.min(Math.max(n, 1), approvers.length) : Math.min(2, approvers.length);
    }
    if (typeof raw.when === 'string' && raw.when.trim()) stage.when = raw.when;
    return stage;
}

export function canonicalStages(list: unknown): ApprovalStage[] {
    return (Array.isArray(list) ? list : []).filter(isObj).map(canonicalStage).filter((s): s is ApprovalStage => !!s);
}

/** The fields a stage chain supersedes (validate/stepKindChecks: approval_stages_conflict). */
const STAGE_SUPERSEDED_FIELDS = [
    'assigneeUserId', 'assigneeGroupId', 'approverUserIds', 'approverGroupIds',
    'finalApproverUserId', 'finalApproverGroupId', 'escalateToUserId', 'escalateToGroupId',
];

/**
 * The step once its first stage is added: the superseded fields are cleared the way canonicalize
 * writes "unset" for each (null for a nullable id, absent for a list), so the step does not carry
 * an approver who would never be asked.
 */
export function withoutSupersededApprovers(step: Obj): Obj {
    const next: Obj = { ...step };
    for (const f of STAGE_SUPERSEDED_FIELDS) {
        if (f === 'approverUserIds' || f === 'approverGroupIds') delete next[f];
        else if (f in next) next[f] = null;
    }
    return next;
}

// ── onDecided hook ──────────────────────────────────────────────────────────

/** canonicalize/approvals APPROVAL_HOOK_OUTCOMES, in the order it writes them. */
export const DECISION_OUTCOMES = ['approved', 'rejected', 'expired', 'cancelled'] as const;
export const MAX_HOOK_COLUMNS = 20;

export type HookValue = string | number | boolean | null;

export interface OnDecided {
    tableId?: string;
    recordId?: unknown;
    set?: Partial<Record<(typeof DECISION_OUTCOMES)[number], Record<string, HookValue>>>;
}

const isHookValue = (v: unknown): v is HookValue => v === null || ['string', 'number', 'boolean'].includes(typeof v);

/** The hook as stored, or undefined when nothing is left of it. */
export function canonicalOnDecided(raw: unknown): OnDecided | undefined {
    if (!isObj(raw)) return undefined;
    const out: OnDecided = {};
    if (nonEmpty(raw.tableId)) out.tableId = raw.tableId;
    if (raw.recordId !== undefined) out.recordId = raw.recordId;
    const set: NonNullable<OnDecided['set']> = {};
    for (const outcome of DECISION_OUTCOMES) {
        const m = isObj(raw.set) ? raw.set[outcome] : undefined;
        if (!isObj(m)) continue;
        const cols = Object.fromEntries(Object.entries(m).filter(([col, v]) => col !== '' && isHookValue(v)).slice(0, MAX_HOOK_COLUMNS)) as Record<string, HookValue>;
        if (Object.keys(cols).length) set[outcome] = cols;
    }
    if (Object.keys(set).length) out.set = set;
    return Object.keys(out).length ? out : undefined;
}
