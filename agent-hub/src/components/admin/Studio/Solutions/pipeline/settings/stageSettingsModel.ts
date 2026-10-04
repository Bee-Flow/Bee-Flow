import type { ApiResult, StageKey } from '../stagesApi';
import { seatOf, seatShapeHasSeat } from './seatShapes';

/**
 * The stage settings page, decided: slot grouping, what a failed write means,
 * which variable a person may edit, when a policy would deadlock. No React, no
 * fetch, no sentences: every function returns a STATE or a CODE and the
 * component turns it into words through t().
 *
 * UNKNOWN IS NOT EMPTY: a binding the caller may not read (`binding` is
 * owner-only on the wire) is never "empty", and a failed read is never "this
 * stage has no parts".
 */

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

// ── What GET /:id/stages/:stage sends ────────────────────────────────────────

export interface SettingsPart {
    ref: string; kind: string; name: string | null; entityId: string;
    /** null = this kind has no switch, or its state could not be read. */
    active: boolean | null; retired: boolean; drift: boolean;
}

export interface StageSettings {
    stage: StageKey; projectId: string; settingsVersion: number;
    enabled: boolean; paused: boolean; newPartsActive: boolean;
    runAs: { userId: string | null; name: string | null };
    requiresApproval: boolean; approvalPolicy: ApprovalPolicy | null; rollbackNeedsApproval: boolean;
    bindingsPending: boolean;
    currentRelease: { id: string; seq: number | null } | null;
    role: string; parts: SettingsPart[];
    inbound: Array<{ kind: string; label: string; url: string }>;
}

export interface ApprovalStage {
    key?: string; name?: string; description?: string;
    approvers?: Array<{ userId?: string; groupId?: string } | null>;
    rule?: string; quorum?: number; when?: string;
}
export interface ApprovalPolicy { stages: ApprovalStage[] }

/** Tolerant reader: a body without a settings version is not a settings read. */
export function readSettings(body: unknown): StageSettings | null {
    if (!isObject(body) || typeof body.settingsVersion !== 'number') return null;
    const runAs = isObject(body.runAs) ? body.runAs : {};
    const policy = isObject(body.approvalPolicy) && Array.isArray(body.approvalPolicy.stages)
        ? (body.approvalPolicy as unknown as ApprovalPolicy) : null;
    const release = isObject(body.currentRelease) && typeof body.currentRelease.id === 'string'
        ? { id: body.currentRelease.id, seq: typeof body.currentRelease.seq === 'number' ? body.currentRelease.seq : null } : null;
    return {
        stage: body.stage === 'prd' ? 'prd' : 'uat',
        projectId: text(body.projectId),
        settingsVersion: body.settingsVersion,
        enabled: body.enabled !== false,
        paused: body.paused === true,
        newPartsActive: body.newPartsActive === true,
        runAs: { userId: nonEmpty(runAs.userId) ? runAs.userId : null, name: nonEmpty(runAs.name) ? runAs.name : null },
        requiresApproval: body.requiresApproval === true,
        approvalPolicy: policy,
        rollbackNeedsApproval: body.rollbackNeedsApproval === true,
        bindingsPending: body.bindingsPending === true,
        currentRelease: release,
        role: text(body.role),
        parts: Array.isArray(body.parts) ? (body.parts as unknown[]).filter(isObject).map(p => ({
            ref: text(p.ref), kind: text(p.kind), name: nonEmpty(p.name) ? p.name : null, entityId: text(p.entityId),
            active: typeof p.active === 'boolean' ? p.active : null, retired: p.retired === true, drift: p.drift === true,
        })).filter(p => p.ref) : [],
        inbound: Array.isArray(body.inbound)
            ? (body.inbound as unknown[]).filter(isObject).filter(a => nonEmpty(a.url)).map(a => ({ kind: text(a.kind), label: text(a.label), url: text(a.url) }))
            : [],
    };
}

export const isOwnerRole = (role: string | null | undefined): boolean => role === 'owner';
export const canOperate = (role: string | null | undefined): boolean => role === 'owner' || role === 'editor';

// ── Bindings: grouping, status, problems ─────────────────────────────────────

export type SlotKind = 'connection' | 'approver_seats' | 'table' | 'knowledge_base' | 'document' | 'webpage_slug' | 'integration_grant' | 'mirror_source';
export type SlotGroup = 'connections' | 'approvers' | 'notify' | 'data' | 'exposure';
export const SLOT_GROUPS: readonly SlotGroup[] = ['connections', 'approvers', 'notify', 'data', 'exposure'];

export interface Requirement {
    slot: string; kind: string; label: string; neededBy: string[]; bound: boolean;
    /** Owner-only on the wire: undefined = not allowed to see, null = nothing. */
    suggested?: unknown; binding?: unknown;
}

export function readRequirements(body: unknown): { release: { id: string; seq: number | null } | null; requirements: Requirement[] } | null {
    if (!isObject(body) || !Array.isArray(body.requirements)) return null;
    const release = isObject(body.release) && typeof body.release.id === 'string'
        ? { id: body.release.id, seq: typeof body.release.seq === 'number' ? body.release.seq : null } : null;
    const requirements = (body.requirements as unknown[]).filter(isObject).filter(r => nonEmpty(r.slot)).map(r => ({
        slot: text(r.slot), kind: text(r.kind), label: text(r.label) || text(r.slot),
        neededBy: Array.isArray(r.neededBy) ? (r.neededBy as unknown[]).filter(nonEmpty) : [],
        bound: r.bound === true,
        ...('suggested' in r ? { suggested: r.suggested } : {}),
        ...('binding' in r ? { binding: r.binding } : {}),
    }));
    return { release, requirements };
}

export function groupOf(req: Pick<Requirement, 'slot' | 'kind'>): SlotGroup {
    switch (req.kind) {
        case 'connection': return 'connections';
        case 'approver_seats': return req.slot.startsWith('notify:') ? 'notify' : 'approvers';
        case 'webpage_slug': case 'integration_grant': return 'exposure';
        default: return 'data';
    }
}

export function groupRequirements(list: Requirement[]): Array<{ group: SlotGroup; items: Requirement[] }> {
    return SLOT_GROUPS
        .map(group => ({ group, items: list.filter(r => groupOf(r) === group) }))
        .filter(g => g.items.length > 0);
}

/** The part names a slot is needed by, falling back to the ref itself. */
export function neededByNames(req: Requirement, parts: SettingsPart[]): string[] {
    return req.neededBy.map(ref => parts.find(p => p.ref === ref)?.name || ref);
}

/** slot -> value, or null to clear. A slot absent from the draft is untouched. */
export type Draft = Record<string, unknown>;

export type BindingStatus = 'missing' | 'bound' | 'changed' | 'cleared';

export function bindingStatus(req: Requirement, draft: Draft): BindingStatus {
    if (req.slot in draft) return draft[req.slot] === null ? 'cleared' : 'changed';
    if (!req.bound) return 'missing';
    return 'bound';
}

export const effectiveValue = (req: Requirement, draft: Draft): unknown => (req.slot in draft ? draft[req.slot] : req.binding ?? null);

/** Hostnames from free text ("a.com, https://b.org/x"), lower-cased, unique; null when an entry is not a host. */
export function parseHosts(input: string): string[] | null {
    const out: string[] = [];
    for (const raw of input.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean)) {
        let host = '';
        try { host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`).hostname.toLowerCase(); } catch { return null; }
        if (!host || !/^[a-z0-9.-]+$|^\[[0-9a-f:.]+\]$/.test(host)) return null;
        if (!out.includes(host)) out.push(host);
    }
    return out;
}

export type BindingProblem =
    | 'connection_missing' | 'hosts_required' | 'hosts_invalid' | 'no_seat' | 'no_recipient' | 'slug_invalid' | 'id_missing';


/** The reason a draft value cannot be saved, or null. The server checks again (binding_invalid). */
export function bindingProblem(req: Pick<Requirement, 'slot' | 'kind'>, value: unknown, stage: StageKey): BindingProblem | null {
    if (value === null || value === undefined) return null;
    const o = isObject(value) ? value : {};
    switch (req.kind) {
        case 'connection': {
            if (!nonEmpty(o.connectionId)) return 'connection_missing';
            const hosts = Array.isArray(o.allowedHosts) ? o.allowedHosts : [];
            if (parseHosts(hosts.map(String).join(' ')) === null) return 'hosts_invalid';
            return stage === 'prd' && hosts.length === 0 ? 'hosts_required' : null;
        }
        case 'approver_seats': {
            if (req.slot.startsWith('notify:')) {
                const any = ['onError', 'onApproval', 'onSuccess'].some(ev => {
                    const e = o[ev];
                    return isObject(e) && ((Array.isArray(e.recipients) && e.recipients.length > 0) || nonEmpty(e.talkRoom));
                });
                return any ? null : 'no_recipient';
            }
            return seatShapeHasSeat(o) ? null : 'no_seat';
        }
        case 'webpage_slug': return /^[a-z0-9-]{1,128}$/.test(text(o.slug).trim().toLowerCase()) ? null : 'slug_invalid';
        case 'table': return nonEmpty(o.datatableId) ? null : 'id_missing';
        case 'document': return nonEmpty(o.documentId) ? null : 'id_missing';
        case 'knowledge_base': return Array.isArray(o.kbIds) && o.kbIds.some(nonEmpty) ? null : 'id_missing';
        default: return null;
    }
}

/** First problem among the changed slots, so the save button can say what to fix. */
export function draftProblems(reqs: Requirement[], draft: Draft, stage: StageKey): Array<{ slot: string; problem: BindingProblem }> {
    const out: Array<{ slot: string; problem: BindingProblem }> = [];
    for (const r of reqs) {
        if (!(r.slot in draft)) continue;
        const p = bindingProblem(r, draft[r.slot], stage);
        if (p) out.push({ slot: r.slot, problem: p });
    }
    return out;
}

// ── The PRD gate ─────────────────────────────────────────────────────────────

export type PolicyProblem = { stageKey: string; why: 'empty' | 'owner_only' };

/**
 * Stages that would deadlock a deployment: nobody in them, or only the person
 * who asks (four-eyes: the Solution owner can never decide their own request).
 * A group seat counts as someone else; the server resolves its members.
 */
export function policyProblems(policy: ApprovalPolicy | null | undefined, ownerId: string | null): PolicyProblem[] {
    const stages = policy && Array.isArray(policy.stages) ? policy.stages : [];
    if (stages.length === 0) return [{ stageKey: '', why: 'empty' }];
    const out: PolicyProblem[] = [];
    stages.forEach((st, i) => {
        const key = st.key || `s${i + 1}`;
        const seats = (st.approvers || []).filter(seatOf) as Array<{ userId?: string; groupId?: string }>;
        if (seats.length === 0) out.push({ stageKey: key, why: 'empty' });
        else if (!seats.some(s => !!s.groupId || (s.userId && s.userId !== ownerId))) out.push({ stageKey: key, why: 'owner_only' });
    });
    return out;
}

export type GateOutcome = 'saved' | 'approval_requested';
/** PATCH answers 202 with a `settings` deployment when the gate was on (D19). */
export const gateOutcome = (status: number): GateOutcome => (status === 202 ? 'approval_requested' : 'saved');

// ── Variables ────────────────────────────────────────────────────────────────

export const VARIABLE_TYPES = ['text', 'number', 'boolean', 'url', 'email', 'choice'] as const;
export type VariableType = typeof VARIABLE_TYPES[number];

export interface VariableDecl {
    name: string; type: VariableType; choices: string[] | null; description: string; required: boolean; steering: boolean;
}
export interface VariableValue { name: string; value: unknown; appliedValue: unknown; updatedAt?: string | null }

export function readDecls(list: unknown): VariableDecl[] {
    return (Array.isArray(list) ? list : []).filter(isObject).filter(d => nonEmpty(d.name)).map(d => ({
        name: text(d.name),
        type: (VARIABLE_TYPES as readonly string[]).includes(text(d.type)) ? (d.type as VariableType) : 'text',
        choices: Array.isArray(d.choices) ? (d.choices as unknown[]).filter(nonEmpty) : null,
        description: text(d.description),
        required: d.required !== false,
        steering: d.steering === true,
    }));
}

export function readValues(list: unknown): VariableValue[] {
    return (Array.isArray(list) ? list : []).filter(isObject).filter(v => nonEmpty(v.name)).map(v => ({
        name: text(v.name), value: v.value ?? null, appliedValue: v.appliedValue ?? null,
        updatedAt: typeof v.updatedAt === 'string' ? v.updatedAt : null,
    }));
}

// Mirrors CONNECTOR_SECRET_KEY_RE (server/core/dataEngine/dataModel/vocabulary.js).
const SECRET_NAME_RE = /secret|passwo?rd|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|bearer|authorization/i;
const NAME_RE = /^[a-z][a-z0-9_]{0,62}$/;

export type NameProblem = 'empty' | 'invalid' | 'secret' | 'duplicate';

/** Refused inline: a secret does not belong in a variable ("store this in a connection"). */
export function variableNameProblem(name: string, others: string[] = []): NameProblem | null {
    const n = name.trim();
    if (!n) return 'empty';
    if (SECRET_NAME_RE.test(n)) return 'secret';
    if (!NAME_RE.test(n)) return 'invalid';
    return others.includes(n) ? 'duplicate' : null;
}

export const isSteering = (d: Pick<VariableDecl, 'type' | 'steering'>): boolean => d.steering || d.type === 'url' || d.type === 'email';

/** Steering values change where data or mail goes: only the Solution owner may edit them. */
export function canEditValue(decl: Pick<VariableDecl, 'type' | 'steering'>, role: string | null | undefined): boolean {
    if (isSteering(decl)) return isOwnerRole(role);
    return canOperate(role);
}

/** A steering value that was entered but is not applied yet: it goes live with the next redeploy. */
export function valuePending(decl: Pick<VariableDecl, 'type' | 'steering'>, v: VariableValue | undefined): boolean {
    return !!v && isSteering(decl) && JSON.stringify(v.value ?? null) !== JSON.stringify(v.appliedValue ?? null);
}

/** What the input sends: a number, a boolean, text; empty clears (null). */
export function valueFromInput(decl: Pick<VariableDecl, 'type'>, input: string): string | number | boolean | null {
    const s = input.trim();
    if (s === '') return null;
    if (decl.type === 'number') { const n = Number(s); return Number.isFinite(n) ? n : s; }
    if (decl.type === 'boolean') return s === 'true' ? true : s === 'false' ? false : s;
    return s;
}

export const valueToInput = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

// ── Errors: the CAS conflict and the rest ────────────────────────────────────

export type SettingsError =
    | { kind: 'stale'; settingsVersion: number | null }
    | { kind: 'binding_invalid'; slot: string | null; why: string | null }
    | { kind: 'not_deployed' } | { kind: 'steering_owner_only'; name: string | null }
    | { kind: 'policy_needs_approver'; stageKey: string | null }
    | { kind: 'variable'; code: string; name: string | null }
    | { kind: 'licence' } | { kind: 'forbidden' } | { kind: 'network' } | { kind: 'other'; code: string | null };

/** Every write sends settingsVersion; the answer to a lost race is 409 `settings_stale`. */
export function settingsError(res: Pick<Extract<ApiResult<unknown>, { ok: false }>, 'status' | 'code' | 'body'>): SettingsError {
    const details = res.body && isObject(res.body.details) ? res.body.details : {};
    const code = res.code;
    if (res.status === 0 || code === 'network') return { kind: 'network' };
    if (code === 'settings_stale') return { kind: 'stale', settingsVersion: typeof details.settingsVersion === 'number' ? details.settingsVersion : null };
    if (code === 'binding_invalid') return { kind: 'binding_invalid', slot: nonEmpty(details.slot) ? details.slot : null, why: nonEmpty(details.why) ? details.why : null };
    if (code === 'managed_part_not_deployed') return { kind: 'not_deployed' };
    if (code === 'steering_owner_only' || code === 'steering_not_here') return { kind: 'steering_owner_only', name: nonEmpty(details.name) ? details.name : null };
    if (code === 'approval_policy_needs_approver') return { kind: 'policy_needs_approver', stageKey: nonEmpty(details.stageKey) ? details.stageKey : null };
    if (code && /^variable_/.test(code)) return { kind: 'variable', code, name: nonEmpty(details.name) ? details.name : null };
    // The licence gate answers 403 `{ error: 'feature_locked' }` with no `code`.
    if (res.status === 403 && res.body && res.body.error === 'feature_locked') return { kind: 'licence' };
    if (res.status === 403) return { kind: 'forbidden' };
    return { kind: 'other', code: code || null };
}

// ── Danger zone ──────────────────────────────────────────────────────────────

export type RemoveMode = 'detach' | 'delete';
export const confirmMatches = (typed: string, name: string): boolean => name.trim() !== '' && typed.trim() === name.trim();

/** The DELETE body: delete mode carries deleteData only when it was asked for. */
export function removeBody(mode: RemoveMode, confirm: string, deleteData: boolean) {
    return { confirm: confirm.trim(), mode, ...(mode === 'delete' ? { deleteData } : {}) };
}

/** Switches exist for automations, apps, webpages and agents only. */
export const isSwitchable = (kind: string): boolean => ['automation', 'app', 'webpage', 'agent'].includes(kind);

/** PRD with the gate on: every redeploy needs approval (D19). */
export const applyNeedsApproval = (stage: StageKey, s: Pick<StageSettings, 'requiresApproval'>): boolean => stage === 'prd' && s.requiresApproval;
