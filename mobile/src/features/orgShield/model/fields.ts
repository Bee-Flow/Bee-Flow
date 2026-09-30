/**
 * The shield document ↔ the editor's fields ↔ the PUT body. A port of the
 * web's useOrgShield.js `normaliseDoc`/`buildPayload` and orgShieldDirty.js.
 *
 * The PUT handler REBUILDS the row from the body, so a key left out comes back
 * as its default. The body is therefore the loaded document with the edited
 * fields laid over it, never an allow-list — minus the keys the GET adds and
 * the server writes itself (routes/orgPrivacyShield.js ECHOED).
 */

import { PII_IDS } from './piiCatalog';
import type { CustomTerm, DlpMode, ShieldFields, ToolPiiPolicy } from './types';

const DLP_MODES: readonly DlpMode[] = ['ask', 'auto_redact', 'block'];

/** Response-only keys a save must not echo (routes/orgPrivacyShield.js ECHOED). */
export const ECHOED_KEYS = [
    'stalenessWarnings',
    'clamped_fields',
    'clamped_tier',
    'updatedAt',
    'updatedBy',
    'implicitDefault',
] as const;

const isRecord = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === 'object' && !Array.isArray(v);

const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

function knownCategories(v: unknown): string[] {
    return strings(v).filter((id) => PII_IDS.has(id));
}

function blockList(v: unknown): { blockCategories: string[] } {
    return { blockCategories: knownCategories(isRecord(v) ? v.blockCategories : undefined) };
}

/** Older rows hold `{ term }` objects; the editor edits bare, trimmed strings. */
function allowTerms(v: unknown): string[] {
    if (!Array.isArray(v)) return [];
    return v
        .map((x) => (typeof x === 'string' ? x : isRecord(x) ? x.term : undefined))
        .filter((x): x is string => typeof x === 'string' && x.trim() !== '')
        .map((x) => x.trim());
}

/** A stored term, its extra keys (createdAt, createdBy) kept. */
export function readTerm(raw: unknown, index: number): CustomTerm {
    const r = isRecord(raw) ? raw : {};
    return {
        ...r,
        id: typeof r.id === 'string' && r.id ? r.id : `term-${index}`,
        label: typeof r.label === 'string' ? r.label : '',
        pattern: typeof r.pattern === 'string' ? r.pattern : '',
        // An absent type is a row from before literals existed: the server reads it as regex.
        type: r.type === 'literal' ? 'literal' : 'regex',
        caseSensitive: r.caseSensitive === true,
    };
}

/** The web's `normaliseDoc`: the server document → the values this editor edits. */
export function normaliseDoc(doc: Record<string, unknown>): ShieldFields {
    const tpp = isRecord(doc.toolPiiPolicy) ? doc.toolPiiPolicy : {};
    const threshold = doc.piiDetectionConfidenceThreshold;
    return {
        enabled: doc.enabled === true,
        euModeEnabled: doc.euModeEnabled === true,
        webSearchGuard: doc.webSearchGuardEnabled === true,
        disableSearchOnUpload: doc.disableSearchOnUpload === true,
        monitorIntegrations: doc.monitorIntegrations === true,
        applyToAutomations: doc.applyToAutomations !== false,
        dlpEnabled: doc.dlpEnabled === true,
        dlpMode: DLP_MODES.includes(doc.dlpMode as DlpMode) ? (doc.dlpMode as DlpMode) : 'ask',
        dlpAlwaysReview: doc.dlpAlwaysReview === true,
        customSensitiveTerms: Array.isArray(doc.customSensitiveTerms)
            ? doc.customSensitiveTerms.map(readTerm)
            : [],
        piiAllowTerms: allowTerms(doc.piiAllowTerms),
        // Absent means ON, like the server and the runtime matcher.
        piiAllowPublicOrgs: doc.piiAllowPublicOrgs !== false,
        toolPiiPolicy: { external: blockList(tpp.external), internal: blockList(tpp.internal) },
        piiCategories: knownCategories(doc.piiDetectionCategories),
        piiConfidenceThreshold: typeof threshold === 'number' && Number.isFinite(threshold) ? threshold : 0.7,
        piiAction: typeof doc.piiDetectionAction === 'string' && doc.piiDetectionAction ? doc.piiDetectionAction : 'block',
        piiFailureMode: doc.piiFailureMode === 'fail_open' ? 'fail_open' : 'fail_closed',
        // Defaults ON, like core/kb/ingestPrivacy.scanEnabledFor.
        scanKnowledgeBases: doc.privacy_scan_knowledge_bases !== false,
        showRawPayload: doc.showRawPayload === true,
    };
}

/** The web's `buildPayload`: the loaded document with this editor's fields over it. */
export function buildPayload(doc: Record<string, unknown>, f: ShieldFields): Record<string, unknown> {
    const base: Record<string, unknown> = { ...doc };
    for (const key of ECHOED_KEYS) delete base[key];
    return {
        ...base,
        enabled: f.enabled,
        euModeEnabled: f.euModeEnabled,
        webSearchGuardEnabled: f.webSearchGuard,
        disableSearchOnUpload: f.disableSearchOnUpload,
        monitorIntegrations: f.monitorIntegrations,
        applyToAutomations: f.applyToAutomations,
        toolPiiPolicy: f.toolPiiPolicy,
        piiDetectionCategories: f.piiCategories,
        piiDetectionConfidenceThreshold: f.piiConfidenceThreshold,
        piiDetectionAction: f.piiAction,
        piiFailureMode: f.piiFailureMode,
        privacy_scan_knowledge_bases: f.scanKnowledgeBases,
        // Save-gated: the switch is hidden unless the action is tokenize, and a
        // hidden transparency panel must not stay on after switching to Block.
        showRawPayload: f.piiAction === 'tokenize' ? f.showRawPayload : false,
        dlpEnabled: f.dlpEnabled,
        dlpMode: f.dlpMode,
        dlpAlwaysReview: f.dlpAlwaysReview,
        customSensitiveTerms: f.customSensitiveTerms,
        piiAllowTerms: f.piiAllowTerms,
        piiAllowPublicOrgs: f.piiAllowPublicOrgs,
    };
}

/** Structural equality over JSON-shaped values; arrays compare in order, like the web's deepEqual. */
export function deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (Array.isArray(a) || Array.isArray(b)) {
        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
        return a.every((x, i) => deepEqual(x, b[i]));
    }
    if (!isRecord(a) || !isRecord(b)) return false;
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

export type StageId = 'overview' | 'detection' | 'processing' | 'outbound';

/** Payload key → the tab that owns its control (orgShieldDirty.js FIELD_STAGE). */
export const FIELD_STAGE: Readonly<Record<string, StageId>> = {
    enabled: 'overview',
    piiDetectionCategories: 'detection',
    piiDetectionConfidenceThreshold: 'detection',
    customSensitiveTerms: 'detection',
    piiAllowTerms: 'detection',
    piiAllowPublicOrgs: 'detection',
    toolPiiPolicy: 'detection',
    piiDetectionAction: 'processing',
    showRawPayload: 'processing',
    privacy_scan_knowledge_bases: 'processing',
    applyToAutomations: 'processing',
    // Not on the web's list (it does not expose the switch); the phone does.
    piiFailureMode: 'processing',
    dlpEnabled: 'outbound',
    dlpMode: 'outbound',
    dlpAlwaysReview: 'outbound',
    webSearchGuardEnabled: 'outbound',
    disableSearchOnUpload: 'outbound',
    monitorIntegrations: 'outbound',
    euModeEnabled: 'outbound',
};

const STAGE_ORDER: readonly StageId[] = ['overview', 'detection', 'processing', 'outbound'];

/** Which tabs hold unsaved edits, in pipeline order, each with how many fields changed. */
export function dirtyStages(
    current: Record<string, unknown> | null,
    snapshot: Record<string, unknown> | null,
): { id: StageId; count: number }[] {
    if (!current || !snapshot) return [];
    const counts = new Map<StageId, number>();
    for (const [field, stage] of Object.entries(FIELD_STAGE)) {
        if (!deepEqual(current[field], snapshot[field])) counts.set(stage, (counts.get(stage) ?? 0) + 1);
    }
    return STAGE_ORDER.filter((id) => counts.has(id)).map((id) => ({ id, count: counts.get(id) ?? 0 }));
}

/** Toggle one id in a list, keeping order and never duplicating. */
export function toggleId(list: readonly string[], id: string, on: boolean): string[] {
    if (on) return list.includes(id) ? [...list] : [...list, id];
    return list.filter((x) => x !== id);
}

export function withToolCategories(policy: ToolPiiPolicy, cls: keyof ToolPiiPolicy, ids: string[]): ToolPiiPolicy {
    return { ...policy, [cls]: { blockCategories: ids } };
}
