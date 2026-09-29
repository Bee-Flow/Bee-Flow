import type { CustomDataType, TestsDoc } from './ownData/ownDataModel';
import { isCustomTypeId } from './ownData/ownDataModel';

/**
 * The org shield document ⇄ the fields this page edits. Pure.
 *
 * Extracted from useOrgShield so the two directions can be tested without a
 * render, and so the hook stays about state and I/O.
 */

type Doc = Record<string, unknown>;

export interface ToolPiiPolicy {
    external: { blockCategories: string[] };
    internal: { blockCategories: string[] };
}

export interface ShieldFields {
    enabled: boolean;
    euModeEnabled: boolean;
    webSearchGuard: boolean;
    disableSearchOnUpload: boolean;
    monitorIntegrations: boolean;
    applyToAutomations: boolean;
    dlpEnabled: boolean;
    dlpMode: 'ask' | 'auto_redact' | 'block';
    dlpAlwaysReview: boolean;
    customDataTypes: CustomDataType[];
    /** `null` when the server did not send the tests: a non-admin, or a plan without the feature. */
    customDataTests: TestsDoc | null;
    piiAllowTerms: string[];
    piiAllowPublicOrgs: boolean;
    toolPiiPolicy: ToolPiiPolicy;
    piiCategories: string[];
    piiConfidenceThreshold: number;
    piiAction: string;
    piiFailureMode: 'fail_open' | 'fail_closed';
    scanKnowledgeBases: boolean;
    showRawPayload: boolean;
}

const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Stored types, keeping only entries that carry a usable id. */
function typesOf(data: Doc): CustomDataType[] {
    return asList(data.customDataTypes)
        .filter((t): t is CustomDataType => !!t && typeof t === 'object' && isCustomTypeId((t as CustomDataType).id));
}

function testsOf(data: Doc): TestsDoc | null {
    const v = data.customDataTests;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as TestsDoc) : null;
}

/**
 * The server document → the field values this page edits.
 *
 * Shared by the state-setting path and the dirty-state snapshot so the two can
 * never disagree about what "unchanged" means. If a snapshot were built from
 * the raw document while state came from a normalised copy, the form would read
 * as dirty the instant it loaded.
 *
 * `builtInIds` filters the category lists, so a typo or a retired category
 * never renders as a tick that does nothing. The org's OWN type ids are kept
 * as well: they are how "Your own data" switches travel, and filtering them
 * out here would delete every one of them on the next save.
 */
export function normaliseDoc(data: Doc, builtInIds: ReadonlySet<string>): ShieldFields {
    const tpp = (data.toolPiiPolicy || {}) as Partial<ToolPiiPolicy>;
    const customDataTypes = typesOf(data);
    const ownIds = new Set(customDataTypes.map(t => t.id));
    const keep = (id: unknown): id is string => typeof id === 'string' && (builtInIds.has(id) || ownIds.has(id));
    return {
        enabled: !!data.enabled,
        euModeEnabled: !!data.euModeEnabled,
        webSearchGuard: !!data.webSearchGuardEnabled,
        disableSearchOnUpload: !!data.disableSearchOnUpload,
        monitorIntegrations: !!data.monitorIntegrations,
        applyToAutomations: data.applyToAutomations !== false,
        dlpEnabled: !!data.dlpEnabled,
        dlpMode: (['ask', 'auto_redact', 'block'] as const).find(m => m === data.dlpMode) || 'ask',
        dlpAlwaysReview: !!data.dlpAlwaysReview,
        customDataTypes,
        customDataTests: testsOf(data),
        // Older rows may hold `{ term }` objects; the UI edits bare strings.
        piiAllowTerms: asList(data.piiAllowTerms)
            .map(v => (typeof v === 'string' ? v : (v as { term?: unknown })?.term))
            .filter((v): v is string => typeof v === 'string' && !!v.trim())
            .map(v => v.trim()),
        piiAllowPublicOrgs: data.piiAllowPublicOrgs !== false,
        toolPiiPolicy: {
            external: { blockCategories: asList(tpp.external?.blockCategories).filter(keep) },
            internal: { blockCategories: asList(tpp.internal?.blockCategories).filter(keep) },
        },
        piiCategories: asList(data.piiDetectionCategories).filter(keep),
        piiConfidenceThreshold: typeof data.piiDetectionConfidenceThreshold === 'number' ? data.piiDetectionConfidenceThreshold : 0.7,
        piiAction: typeof data.piiDetectionAction === 'string' && data.piiDetectionAction ? data.piiDetectionAction : 'block',
        piiFailureMode: data.piiFailureMode === 'fail_open' ? 'fail_open' : 'fail_closed',
        // Defaults ON, like the server (core/kb/ingestPrivacy.scanEnabledFor):
        // switching Privacy Shield on did not mean "except the documents you
        // keep forever and quote to customers". `undefined` is a row saved
        // before this setting existed, not a deliberate off.
        scanKnowledgeBases: data.privacy_scan_knowledge_bases !== false,
        showRawPayload: !!data.showRawPayload,
    };
}

/**
 * The PUT body: the loaded document with this page's fields laid over it.
 *
 * The spread of `base` is the whole point (see `loadedDocRef` in the hook):
 * a key this page has never heard of survives a save it was never part of.
 * Response-only keys are stripped first: echoing `clamped_fields` back would
 * persist a transient plan note into the row, and `updatedAt`/`updatedBy`
 * are the server's to write.
 *
 * ── Your own data ─────────────────────────────────────────────────────────
 * A server that knows `customDataTypes` always sends it. Against such a
 * server the page sends its types and stops sending `customSensitiveTerms`:
 * the server writes that key itself as a mirror of the words and patterns,
 * and echoing the old mirror back beside the new list would ask it to
 * migrate the same terms a second time. Against an older server (no
 * `customDataTypes` in the document) the old key rides through untouched,
 * exactly as before.
 *
 * `customDataTests` is sent only when the server sent it: absent means
 * "unchanged", and a caller who may not read the tests must not overwrite
 * them with an empty object.
 */
export function buildPayload(doc: Doc | null, f: ShieldFields): Doc {
    const {
        clamped_fields: _cf, clamped_tier: _ct, stalenessWarnings: _sw,
        updatedAt: _ua, updatedBy: _ub,
        ...base
    } = doc || {};
    const payload: Doc = {
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
        // SAVE-gated, not merely edit-gated. The control is hidden when the
        // action is not `tokenize`, but the value used to be sent regardless,
        // so an org that enabled it and then switched to Block kept a hidden
        // transparency panel switched on for every one of its users.
        showRawPayload: f.piiAction === 'tokenize' ? f.showRawPayload : false,
        dlpEnabled: f.dlpEnabled,
        dlpMode: f.dlpMode,
        dlpAlwaysReview: f.dlpAlwaysReview,
        piiAllowTerms: f.piiAllowTerms,
        piiAllowPublicOrgs: f.piiAllowPublicOrgs,
    };
    if (Array.isArray(base.customDataTypes)) {
        payload.customDataTypes = f.customDataTypes;
        delete payload.customSensitiveTerms;
    }
    if (f.customDataTests !== null) payload.customDataTests = f.customDataTests;
    else delete payload.customDataTests;
    return payload;
}
