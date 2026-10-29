import { useState, useEffect, useEffectEvent, useCallback, useMemo, useRef, type Dispatch, type SetStateAction } from 'react';
import { describeClampsOnLoad, describeSaveResult } from './orgShieldClamps';
import { dirtyStages as computeDirtyStages } from './orgShieldDirty';
import { buildPayload, normaliseDoc } from './orgShieldDoc';
import type { ShieldFields, ToolPiiPolicy } from './orgShieldDoc';
import useShieldEnvironment from './useShieldEnvironment';
import type { ShieldOrg } from './useShieldEnvironment';
import useShieldFields, { type ShieldFieldsState } from './useShieldFields';
import { piiCategoriesLocalized } from '@/config/piiCategories';
import { useTranslation, type TranslateFn } from '@/hooks/useTranslation';
import { deepEqual } from '@/utils/deepEqual';
import { API_BASE } from '@/utils/helpers';
import useConfirm from '@/components/shared/useConfirm';
import { request, RefusedError, mutate, errorBody } from '@/api/mutate';

type Doc = Record<string, unknown>;

/** The save bar's line; `tabs` names the panes a warning concerns. */
interface ShieldMessage {
    type: 'success' | 'warning' | 'error';
    text: string;
    tabs?: string[];
}

/** What a save resolves to, for the caller that wants to react to it. */
interface ShieldSaveResult {
    ok: boolean;
    error?: string;
    clamped?: string[];
    termErrors?: unknown[];
    typeErrors?: unknown[];
}

/** Who last saved this policy and when (server-written provenance). */
type ShieldMeta = { updatedAt: string | null; updatedBy: string | null };

interface UseOrgShieldOptions {
    /** Pinned organisation. Wins over everything. */
    orgId?: string | null;
    /** May default to the first org (admin view only). */
    allowOrgPicker?: boolean;
}

/**
 * The shield document and its baseline. `loadedDoc` is the server's document,
 * verbatim, exactly as it was loaded: every save is layered ON TOP of it
 * rather than assembled from the form fields.
 *
 * Why: the PUT handler rebuilds the whole row from the request body, so a key
 * this page does not send comes back as its default. This page did not send
 * `customSensitiveTerms`, `dlpScope`, `dlpFailureMode`, `dlpAllowlistedHosts`
 * or `attachmentLargeInputPolicy` — so every admin save silently wiped the
 * org's own sensitive terms and reset four policies nobody touched. Keeping
 * the raw document means a field this page has never heard of (including one
 * added in a future release) survives a save it was never part of. `null`
 * also doubles as "we do not have a trustworthy document" — see `canSave`.
 *
 * `snapshot` is the payload as it was at load / last successful save; dirty
 * tracking compares against it and nothing else may write it. `version` is
 * bumped whenever either ref is written: both are refs, so without it a memo
 * keyed on form state alone would keep the old answer after a save that
 * changed the baseline but no field.
 */
function useShieldBaseline() {
    const loadedDocRef = useRef<Doc | null>(null);
    const snapshotRef = useRef<Doc | null>(null);
    const [snapshotVersion, setSnapshotVersion] = useState(0);
    const bump = useCallback(() => setSnapshotVersion(v => v + 1), []);
    return { loadedDocRef, snapshotRef, snapshotVersion, bump };
}

type Baseline = ReturnType<typeof useShieldBaseline>;

/**
 * Refresh / close with pending edits. In-app navigation cannot be guarded —
 * there is no router to hook — so this covers what it can and nothing
 * pretends otherwise.
 */
function useBeforeUnloadWhileDirty(isDirty: boolean) {
    useEffect(() => {
        if (!isDirty) return undefined;
        const onBeforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
        window.addEventListener('beforeunload', onBeforeUnload);
        return () => window.removeEventListener('beforeunload', onBeforeUnload);
    }, [isDirty]);
}

interface FetchShieldArgs {
    categories: ReturnType<typeof piiCategoriesLocalized>;
    applyFields: ShieldFieldsState['applyFields'];
    t: TranslateFn;
    bump: Baseline['bump'];
    loadedDocRef: Baseline['loadedDocRef'];
    snapshotRef: Baseline['snapshotRef'];
    setShieldLoading: Dispatch<SetStateAction<boolean>>;
    setLoadError: Dispatch<SetStateAction<{ status: number } | null>>;
    setMeta: Dispatch<SetStateAction<ShieldMeta>>;
    setMessage: Dispatch<SetStateAction<ShieldMessage | null>>;
}

/** Load one organisation's shield: the document becomes the baseline and the form; a refusal or failure leaves no document to save over. */
function useFetchShield({ categories, applyFields, t, bump, loadedDocRef, snapshotRef, setShieldLoading, setLoadError, setMeta, setMessage }: FetchShieldArgs) {
    return useCallback(async (orgId: string) => {
        if (!orgId) return;
        setShieldLoading(true);
        setLoadError(null);
        try {
            let res: Response;
            try {
                res = await request(`${API_BASE}/api/org-privacy-shield/${orgId}`);
            } catch (err) {
                if (!(err instanceof RefusedError)) throw err;
                loadedDocRef.current = null;
                snapshotRef.current = null;
                setLoadError({ status: err.status });
                return;
            }
            const data = await res.json();
            const f = normaliseDoc(data, new Set(categories.map(c => c.id)));

            loadedDocRef.current = data;
            snapshotRef.current = buildPayload(data, f);

            applyFields(f);
            setMeta({ updatedAt: data.updatedAt || null, updatedBy: data.updatedBy || null });

            // The server clamps fields the org's plan doesn't allow and reports
            // them in `clamped_fields`. Surface WHY the shown value differs from
            // what was picked — otherwise the setting looks like it "didn't save".
            if (Array.isArray(data.clamped_fields) && data.clamped_fields.length > 0) {
                setMessage({ type: 'warning', text: describeClampsOnLoad(data.clamped_fields, t) });
            } else {
                setMessage(null);
            }
        } catch (e) {
            console.error('[OrgShield] Failed to fetch shield', e);
            loadedDocRef.current = null;
            snapshotRef.current = null;
            setLoadError({ status: 0 });
        } finally {
            setShieldLoading(false);
            bump();
        }
    }, [categories, applyFields, t, bump, loadedDocRef, snapshotRef, setShieldLoading, setLoadError, setMeta, setMessage]);
}

/**
 * Follow an explicitly-supplied organisation, including one that arrives
 * after mount. Guarded on `pinnedOrgId` alone so a picker selection in the
 * admin view is never overridden by a stale prop.
 */
function useFollowPinnedOrg(pinnedOrgId: string | null, selectedOrgId: string, setSelectedOrgId: (id: string) => void, fetchShield: (orgId: string) => Promise<void>) {
    const followPinnedOrg = useEffectEvent(() => {
        if (!pinnedOrgId || pinnedOrgId === selectedOrgId) return;
        setSelectedOrgId(pinnedOrgId);
        fetchShield(pinnedOrgId);
    });
    useEffect(() => { followPinnedOrg(); }, [pinnedOrgId]);
}

/**
 * State + I/O for one organisation's Privacy Shield.
 *
 * Extracted verbatim from GuardrailsPanel's `orgshield` tab so the same editor
 * can be embedded in org settings and in the admin console without two copies
 * drifting apart. Behaviour is deliberately unchanged by the extraction. The
 * form fields live in useShieldFields, the mount-time reads in
 * useShieldEnvironment.
 *
 * ── The invariant this hook exists to protect ─────────────────────────────
 * It must NEVER guess which organisation it is editing. The panel used to fall
 * back to `orgs[0]` from /auth/organizations whenever no id was supplied — and
 * in embedded mode the org picker is hidden, so a super-admin opening org B's
 * settings page silently read, and on save WROTE, org A's shield. An explicit
 * id is the only way this code can know which tenant it is looking at.
 *
 * So there are exactly two legitimate modes:
 *   - `orgId` supplied      → follow it, never deviate, no picker.
 *   - `allowOrgPicker`      → the caller renders a VISIBLE picker, so defaulting
 *                             to the first org is something the admin can see
 *                             and change. Only then may we choose one.
 * Neither → fetch nothing and say so. Pinned by OrgShieldEditor.orgscope.test.jsx.
 */
function useOrgShield({ orgId: pinnedOrgId = null, allowOrgPicker = false }: UseOrgShieldOptions = {}) {
    const { confirm, confirmDialog } = useConfirm();
    const { t } = useTranslation();
    const [selectedOrgId, setSelectedOrgId] = useState('');
    const { loadedDocRef, snapshotRef, snapshotVersion, bump } = useShieldBaseline();
    const [loadError, setLoadError] = useState<{ status: number } | null>(null);
    const { values, fields, applyFields, toggleToolPiiCat, setToolPiiCats } = useShieldFields();
    const { setCustomDataTypes, setCustomDataTests, setPiiAction } = fields;
    const [saving, setSaving] = useState(false);
    const [shieldLoading, setShieldLoading] = useState(false);
    const [message, setMessage] = useState<ShieldMessage | null>(null);
    // Provenance the server writes and this page only reads: who last saved
    // this policy and when. State rather than a read through `loadedDocRef`,
    // because a ref does not re-render and the line would go stale after a save.
    const [meta, setMeta] = useState<ShieldMeta>({ updatedAt: null, updatedBy: null });

    const categories = useMemo(() => piiCategoriesLocalized(t), [t]);

    // ── Dirty state ──────────────────────────────────────────────────────
    // Declared BEFORE the callbacks that read it: `selectOrg` guards on
    // `isDirty`. The payload as it stands right now is also the dirty
    // comparand, so "what changed" and "what we would send" can never diverge.
    const v = values;
    const currentPayload = useMemo(() => (
        loadedDocRef.current === null ? null : buildPayload(loadedDocRef.current, v)
    // Deps: snapshotVersion stands in for the two refs; the fields below are what `v` holds
    ), [v.enabled, v.euModeEnabled, v.webSearchGuard, v.disableSearchOnUpload, v.monitorIntegrations,
        v.applyToAutomations, v.dlpEnabled, v.dlpMode, v.dlpAlwaysReview, v.customDataTypes, v.customDataTests,
        v.piiAllowTerms, v.piiAllowPublicOrgs, v.toolPiiPolicy, v.piiCategories, v.piiConfidenceThreshold,
        v.piiAction, v.piiFailureMode, v.showRawPayload, v.scanKnowledgeBases, snapshotVersion]);

    // Memoised: the payload is a deep structure (every custom type and its
    // test sentences), and this ran a full deep compare on every render.
    const isDirty = useMemo(
        () => !!currentPayload && !!snapshotRef.current && !deepEqual(currentPayload, snapshotRef.current),
        // Deps: snapshotVersion stands in for the ref
        [currentPayload, snapshotVersion],
    );

    // The settings as last loaded or saved: what the evidence on screen was
    // produced under, where the draft may already say something else.
    // Deps: snapshotVersion stands in for the ref
    // buildPayload writes `toolPiiPolicy` from the typed fields, so that one key has a known shape.
    const saved = useMemo(() => snapshotRef.current as (Doc & { toolPiiPolicy?: Partial<ToolPiiPolicy> }) | null, [snapshotVersion]);

    // WHICH panes hold the pending edits — so the save bar can name them and
    // an admin who touched two panes can get back to both. Recomputed from the
    // payload, never from the form state, so it cannot disagree with `isDirty`.
    const dirtyStages = useMemo(
        () => (isDirty ? computeDirtyStages(currentPayload, snapshotRef.current) : []),
        [isDirty, currentPayload],
    );

    // Save is only meaningful when we hold a document we trust.
    const canSave = !!selectedOrgId && !loadError && !shieldLoading && currentPayload !== null;

    useBeforeUnloadWhileDirty(isDirty);

    /**
     * Throw away every pending edit and go back to the last known-good
     * document. Deliberately NOT confirmed: the button only exists while there
     * is something to discard, it is next to the Save it contrasts with, and
     * the save bar names exactly which panes it will revert. A confirm on top
     * of that is the dialog nobody reads.
     */
    const discard = useCallback(() => {
        const doc = loadedDocRef.current;
        if (!doc) return;
        applyFields(normaliseDoc(doc, new Set(categories.map(c => c.id))));
        setMessage(null);
    }, [applyFields, categories, loadedDocRef]);

    const fetchShield = useFetchShield({
        categories, applyFields, t, bump, loadedDocRef, snapshotRef, setShieldLoading, setLoadError, setMeta, setMessage,
    });

    // Mount: environment flags + the org list. `pinnedOrgId` is handled by its
    // own effect — the embedding page resolves its org asynchronously and
    // usually has not done so yet at this point.
    const env = useShieldEnvironment((orgs: ShieldOrg[]) => {
        if (orgs.length === 0 || pinnedOrgId) return;
        if (allowOrgPicker) {
            setSelectedOrgId(orgs[0].id);
            fetchShield(orgs[0].id);
        } else {
            console.warn('[OrgShield] no orgId and no visible picker — refusing to guess which organisation to edit');
            setShieldLoading(false);
        }
    });

    useFollowPinnedOrg(pinnedOrgId, selectedOrgId, setSelectedOrgId, fetchShield);

    // Switching organisation reloads the form, discarding edits. It is the one
    // in-component navigation that can silently throw away work, so it is the
    // one place a confirm is honest rather than annoying.
    const selectOrg = useCallback(async (orgId: string) => {
        if (isDirty) {
            const ok = await confirm({ title: 'You have unsaved changes.', description: 'Switching organisation will discard them.', confirmLabel: 'Switch anyway', destructive: true });
            if (!ok) return;
        }
        setSelectedOrgId(orgId);
        setMessage(null);
        fetchShield(orgId);
    }, [fetchShield, isDirty, confirm]);

    /**
     * Make a saved document the new baseline.
     *
     * The server canonicalises the org's own types (trims, drops the unused
     * method blocks, stamps `updatedAt`, marks a broken pattern invalid).
     * Showing its version is what keeps the page from reading as dirty right
     * after a clean save, and what puts an `invalid` badge on the row that
     * earned it. Everything else keeps what the admin sees, so a clamp still
     * shows as a difference (see describeSaveResult).
     */
    const adoptSaved = useCallback((config: Doc | null | undefined, sentPayload: Doc) => {
        if (config) {
            loadedDocRef.current = config;
            setMeta({ updatedAt: (config.updatedAt as string) || null, updatedBy: (config.updatedBy as string) || null });
            const savedFields: ShieldFields = normaliseDoc(config, new Set(categories.map(c => c.id)));
            snapshotRef.current = buildPayload(config, savedFields);
            setCustomDataTypes(savedFields.customDataTypes);
            setCustomDataTests(savedFields.customDataTests);
        } else {
            snapshotRef.current = sentPayload;
        }
        bump();
    }, [categories, setCustomDataTypes, setCustomDataTests, bump, loadedDocRef, snapshotRef]);

    const save = useCallback(async (): Promise<ShieldSaveResult> => {
        if (!selectedOrgId) return { ok: false };
        if (!currentPayload) {
            // Belt-and-braces behind the disabled button: without a loaded
            // document a save would write constructor defaults over real config.
            const text = 'Cannot save: the current settings could not be loaded.';
            setMessage({ type: 'error', text });
            return { ok: false, error: text };
        }
        setSaving(true);
        setMessage(null);
        try {
            let res: Response;
            try {
                res = await mutate(`${API_BASE}/api/org-privacy-shield/${selectedOrgId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(currentPayload),
            });
            } catch (err) {
                if (!(err instanceof RefusedError)) throw err;
                const data = errorBody(err) ?? {};
                const text = data.error || 'Failed to save.';
                setMessage({ type: 'error', text });
                return { ok: false, error: text };
            }
            const data = await res.json().catch(() => ({}));

            // The save succeeded, so the server's row is the new baseline:
            // including any value it clamped or rejected.
            adoptSaved(data.config, currentPayload);
            const outcome = describeSaveResult(data, t);
            // A clamped field means the stored value differs from what was
            // submitted. Reflect the stored value rather than a bare "saved"
            // that hides the override.
            if (outcome.clampedAction) setPiiAction(outcome.clampedAction);
            setMessage(outcome.message as ShieldMessage);
            return outcome.result as ShieldSaveResult;
        } catch {
            setMessage({ type: 'error', text: 'Error saving.' });
            return { ok: false, error: 'Error saving.' };
        } finally {
            setSaving(false);
        }
    }, [selectedOrgId, currentPayload, adoptSaved, t, setPiiAction]);

    return {
        loading: env.loading, shieldLoading, saving, message, setMessage,
        loadError, isDirty, dirtyStages, canSave, saved,
        orgList: env.orgList, selectedOrgId, selectOrg,
        hasEuModelsConfigured: env.hasEuModelsConfigured, hasWebSearchEnabled: env.hasWebSearchEnabled,
        guardStatus: env.guardStatus, guardCheckedAt: env.guardCheckedAt, meta,
        categories,
        save, discard,
        toggleToolPiiCat, setToolPiiCats,
        confirmDialog,
        fields,
    };
}

export default useOrgShield;
