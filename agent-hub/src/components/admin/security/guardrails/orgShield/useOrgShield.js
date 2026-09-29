import { useState, useEffect, useEffectEvent, useCallback, useMemo, useRef } from 'react';
import { describeClampsOnLoad, describeSaveResult } from './orgShieldClamps';
import { dirtyStages as computeDirtyStages } from './orgShieldDirty';
import { buildPayload, normaliseDoc } from './orgShieldDoc';
import { piiCategoriesLocalized } from '../../../../../config/piiCategories';
import { useTranslation } from '../../../../../hooks/useTranslation';
import { deepEqual } from '../../../../../utils/deepEqual';
import { API_BASE, authFetch } from '../../../../../utils/helpers';
import useConfirm from '../../../../shared/useConfirm';

/**
 * State + I/O for one organisation's Privacy Shield.
 *
 * Extracted verbatim from GuardrailsPanel's `orgshield` tab so the same editor
 * can be embedded in org settings and in the admin console without two copies
 * drifting apart. Behaviour is deliberately unchanged by the extraction.
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
 *
 * @param {object}  opts
 * @param {string}  [opts.orgId]           Pinned organisation. Wins over everything.
 * @param {boolean} [opts.allowOrgPicker]  May default to the first org (admin view only).
 */
export function useOrgShield({ orgId: pinnedOrgId = null, allowOrgPicker = false } = {}) {
    const { confirm, confirmDialog } = useConfirm();
    const { t } = useTranslation();

    const [loading, setLoading] = useState(true);
    const [orgList, setOrgList] = useState([]);
    const [selectedOrgId, setSelectedOrgId] = useState('');

    // Environment flags that decide which cards are relevant at all.
    const [hasEuModelsConfigured, setHasEuModelsConfigured] = useState(false);
    const [hasWebSearchEnabled, setHasWebSearchEnabled] = useState(false);

    // Is the PII Guard installed and answering?
    //
    // The dependency this screen never admitted to. With the sidecar missing or
    // down, category detection does not run at all — so every category tick,
    // both sensitivity presets and both tool lists on this page are decoration.
    // (Custom terms and patterns keep working; they need no model.) Until now
    // the only place that said so was a platform-admin console an org admin
    // cannot open, and `derivePosture` has had a `guard` row defined but never
    // fed. This is the feed.
    //
    // `null` means "have not heard back yet" and is NOT "healthy" — nothing
    // renders a claim either way until the probe answers.
    const [guardStatus, setGuardStatus] = useState(null);
    // When that answer arrived (ms). The probe is not repeated, so this is
    // "checked N minutes ago", never a live heartbeat.
    const [guardCheckedAt, setGuardCheckedAt] = useState(null);

    // ── The shield document ──────────────────────────────────────────────
    //
    // The server's document, verbatim, exactly as it was loaded. Every save is
    // layered ON TOP of this rather than assembled from the fields below.
    //
    // Why: the PUT handler rebuilds the whole row from the request body, so a
    // key this page does not send comes back as its default. This page did not
    // send `customSensitiveTerms`, `dlpScope`, `dlpFailureMode`,
    // `dlpAllowlistedHosts` or `attachmentLargeInputPolicy` — so every admin
    // save silently wiped the org's own sensitive terms and reset four
    // policies nobody touched. Keeping the raw document means a field this
    // page has never heard of (including one added in a future release)
    // survives a save it was never part of.
    //
    // `null` also doubles as "we do not have a trustworthy document" — see
    // `canSave`.
    const loadedDocRef = useRef(null);
    // The payload as it was at load / last successful save. Dirty-tracking
    // compares against this; nothing else may write it.
    const snapshotRef = useRef(null);
    const [loadError, setLoadError] = useState(null);

    const [enabled, setEnabled] = useState(false);
    const [euModeEnabled, setEuModeEnabled] = useState(false);
    const [webSearchGuard, setWebSearchGuard] = useState(false);
    const [disableSearchOnUpload, setDisableSearchOnUpload] = useState(false);
    const [monitorIntegrations, setMonitorIntegrations] = useState(false);
    const [applyToAutomations, setApplyToAutomations] = useState(true);
    const [dlpEnabled, setDlpEnabled] = useState(false);
    const [dlpMode, setDlpMode] = useState('ask');
    const [dlpAlwaysReview, setDlpAlwaysReview] = useState(false);
    // The org's own kinds of data ("Your own data"), and their test sets.
    // Tests are `null` when the server did not send them (not an admin, or no
    // licence): then they are left out of the save entirely, never emptied.
    const [customDataTypes, setCustomDataTypes] = useState([]);
    const [customDataTests, setCustomDataTests] = useState(null);
    // Terms that must NEVER be redacted. Previously loaded by nobody and
    // destroyed on every save.
    const [piiAllowTerms, setPiiAllowTerms] = useState([]);
    // `!== false`: an absent value means ON, matching the server and the
    // runtime matcher. Defaulting to `false` here would render "off" for a
    // list that is actually active.
    const [piiAllowPublicOrgs, setPiiAllowPublicOrgs] = useState(true);
    const [toolPiiPolicy, setToolPiiPolicy] = useState({
        external: { blockCategories: [] },
        internal: { blockCategories: [] },
    });
    const [piiCategories, setPiiCategories] = useState([]);
    const [piiConfidenceThreshold, setPiiConfidenceThreshold] = useState(0.7);
    const [piiAction, setPiiAction] = useState('block');
    // Not exposed in the UI: stays at its safe default so a degraded detector
    // never silently sends unmasked text to the model (BFSF-269).
    const [piiFailureMode, setPiiFailureMode] = useState('fail_closed');
    const [scanKnowledgeBases, setScanKnowledgeBases] = useState(true);
    const [showRawPayload, setShowRawPayload] = useState(false);

    const [saving, setSaving] = useState(false);
    const [shieldLoading, setShieldLoading] = useState(false);
    const [message, setMessage] = useState(null);
    // Provenance the server writes and this page only reads: who last saved
    // this policy and when. State rather than a read through `loadedDocRef`,
    // because a ref does not re-render and the line would go stale after a save.
    const [meta, setMeta] = useState({ updatedAt: null, updatedBy: null });
    // Bumped whenever `snapshotRef` or `loadedDocRef` is written. Both are
    // refs, so without this a memo keyed on form state alone would keep the
    // old answer after a save that changed the baseline but no field.
    const [snapshotVersion, setSnapshotVersion] = useState(0);

    const categories = useMemo(() => piiCategoriesLocalized(t), [t]);

    // ── Dirty state ──────────────────────────────────────────────────────
    // Declared BEFORE the callbacks that read it: `selectOrg` guards on
    // `isDirty`, and a const referenced above its declaration is a temporal
    // dead zone throw on first render, not a lint warning.
    //
    // The payload as it stands right now — and the dirty comparand, so "what
    // changed" and "what we would send" can never diverge.
    const currentPayload = useMemo(() => (
        loadedDocRef.current === null ? null : buildPayload(loadedDocRef.current, {
            enabled, euModeEnabled, webSearchGuard, disableSearchOnUpload,
            monitorIntegrations, applyToAutomations, dlpEnabled, dlpMode, dlpAlwaysReview,
            customDataTypes, customDataTests, piiAllowTerms, piiAllowPublicOrgs, toolPiiPolicy,
            piiCategories, piiConfidenceThreshold, piiAction, piiFailureMode, showRawPayload,
            scanKnowledgeBases,
        })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- snapshotVersion stands in for the two refs
    ), [enabled, euModeEnabled, webSearchGuard, disableSearchOnUpload, monitorIntegrations,
        applyToAutomations, dlpEnabled, dlpMode, dlpAlwaysReview, customDataTypes, customDataTests,
        piiAllowTerms, piiAllowPublicOrgs, toolPiiPolicy, piiCategories, piiConfidenceThreshold,
        piiAction, piiFailureMode, showRawPayload, scanKnowledgeBases, snapshotVersion]);

    // Memoised: the payload is a deep structure (every custom type and its
    // test sentences), and this ran a full deep compare on every render.
    const isDirty = useMemo(
        () => !!currentPayload && !!snapshotRef.current && !deepEqual(currentPayload, snapshotRef.current),
        // eslint-disable-next-line react-hooks/exhaustive-deps -- snapshotVersion stands in for the ref
        [currentPayload, snapshotVersion],
    );

    // The settings as last loaded or saved: what the evidence on screen was
    // produced under, where the draft may already say something else.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- snapshotVersion stands in for the ref
    const saved = useMemo(() => snapshotRef.current, [snapshotVersion]);

    // WHICH panes hold the pending edits — so the save bar can name them and
    // an admin who touched two panes can get back to both. Recomputed from the
    // payload, never from the form state, so it cannot disagree with `isDirty`.
    const dirtyStages = useMemo(
        () => (isDirty ? computeDirtyStages(currentPayload, snapshotRef.current) : []),
        [isDirty, currentPayload],
    );

    // Save is only meaningful when we hold a document we trust.
    const canSave = !!selectedOrgId && !loadError && !shieldLoading && currentPayload !== null;

    // Refresh / close with pending edits. In-app navigation cannot be guarded —
    // there is no router to hook — so this covers what it can and nothing
    // pretends otherwise.
    useEffect(() => {
        if (!isDirty) return undefined;
        const onBeforeUnload = (e) => { e.preventDefault(); e.returnValue = ''; };
        window.addEventListener('beforeunload', onBeforeUnload);
        return () => window.removeEventListener('beforeunload', onBeforeUnload);
    }, [isDirty]);

    /**
     * Push one normalised document into the form state.
     *
     * Shared by the load path and `discard`, so "what the form shows after a
     * reload" and "what it shows after discarding" can never drift apart.
     */
    const applyFields = useCallback((f) => {
        setEnabled(f.enabled);
        setEuModeEnabled(f.euModeEnabled);
        setWebSearchGuard(f.webSearchGuard);
        setDisableSearchOnUpload(f.disableSearchOnUpload);
        setMonitorIntegrations(f.monitorIntegrations);
        setApplyToAutomations(f.applyToAutomations);
        setDlpEnabled(f.dlpEnabled);
        setDlpMode(f.dlpMode);
        setDlpAlwaysReview(f.dlpAlwaysReview);
        setCustomDataTypes(f.customDataTypes);
        setCustomDataTests(f.customDataTests);
        setPiiAllowTerms(f.piiAllowTerms);
        setPiiAllowPublicOrgs(f.piiAllowPublicOrgs);
        setToolPiiPolicy(f.toolPiiPolicy);
        setPiiCategories(f.piiCategories);
        setPiiConfidenceThreshold(f.piiConfidenceThreshold);
        setPiiAction(f.piiAction);
        setPiiFailureMode(f.piiFailureMode);
        setScanKnowledgeBases(f.scanKnowledgeBases);
        setShowRawPayload(f.showRawPayload);
    }, []);

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
    }, [applyFields, categories]);

    const fetchShield = useCallback(async (orgId) => {
        if (!orgId) return;
        setShieldLoading(true);
        setLoadError(null);
        try {
            const res = await authFetch(`${API_BASE}/api/org-privacy-shield/${orgId}`);
            if (!res.ok) {
                // A failed load used to leave every field at its constructor
                // default — "shield off, no categories, action block" — while
                // Save stayed live. One click then persisted that blank config
                // over the org's real one. Refusing to save is the only honest
                // state: we do not know what the configuration is.
                loadedDocRef.current = null;
                snapshotRef.current = null;
                setLoadError({ status: res.status });
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
            setSnapshotVersion(v => v + 1);
        }
    }, [categories, applyFields, t]);

    // Mount: environment flags + the org list.
    // `pinnedOrgId` is handled by its own effect — the embedding page resolves
    // its org asynchronously and usually has not done so yet at this point.
    const pickInitialOrg = useEffectEvent((orgs) => {
        if (orgs.length === 0 || pinnedOrgId) return;
        if (allowOrgPicker) {
            setSelectedOrgId(orgs[0].id);
            fetchShield(orgs[0].id);
        } else {
            console.warn('[OrgShield] no orgId and no visible picker — refusing to guess which organisation to edit');
            setShieldLoading(false);
        }
    });
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const res = await authFetch(`${API_BASE}/ai/config`);
                if (res.ok && !cancelled) {
                    const data = await res.json();
                    setHasWebSearchEnabled(!!(data.searchProvider && data.searchProvider !== 'disabled'));
                }

                const euRes = await authFetch(`${API_BASE}/ai/config/chat-models-eu`);
                if (euRes.ok && !cancelled) {
                    const euModels = await euRes.json();
                    setHasEuModelsConfigured(
                        Object.values(euModels).some(tier => tier && tier.modelId && tier.modelId.trim() !== ''),
                    );
                }

                // Self-scoped and cheap (the route memoises its health probe
                // for 15s). A failure here leaves the status `null`, which
                // renders nothing — an unreachable *status endpoint* is not
                // evidence of an unreachable guard.
                try {
                    const guardRes = await authFetch(`${API_BASE}/api/org-privacy-shield/user/guard-status`);
                    if (guardRes.ok && !cancelled) {
                        const status = await guardRes.json();
                        setGuardStatus({
                            configured: status.configured !== false,
                            reachable: status.reachable !== false,
                        });
                        setGuardCheckedAt(Date.now());
                    }
                } catch { /* stays null — see above */ }

                const orgRes = await authFetch(`${API_BASE}/auth/organizations`);
                if (orgRes.ok && !cancelled) {
                    const orgs = await orgRes.json();
                    setOrgList(orgs);
                    pickInitialOrg(orgs);
                }
            } catch (e) {
                console.error('[OrgShield] Failed to fetch config', e);
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, []);

    // Follow an explicitly-supplied organisation, including one that arrives
    // after mount. Guarded on `pinnedOrgId` alone so a picker selection in the
    // admin view is never overridden by a stale prop.
    const followPinnedOrg = useEffectEvent(() => {
        if (!pinnedOrgId || pinnedOrgId === selectedOrgId) return;
        setSelectedOrgId(pinnedOrgId);
        fetchShield(pinnedOrgId);
    });
    useEffect(() => { followPinnedOrg(); }, [pinnedOrgId]);

    // Switching organisation reloads the form, discarding edits. It is the one
    // in-component navigation that can silently throw away work, so it is the
    // one place a confirm is honest rather than annoying.
    const selectOrg = useCallback(async (orgId) => {
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
    const adoptSaved = useCallback((config, sentPayload) => {
        if (config) {
            loadedDocRef.current = config;
            setMeta({ updatedAt: config.updatedAt || null, updatedBy: config.updatedBy || null });
            const saved = normaliseDoc(config, new Set(categories.map(c => c.id)));
            snapshotRef.current = buildPayload(config, saved);
            setCustomDataTypes(saved.customDataTypes);
            setCustomDataTests(saved.customDataTests);
        } else {
            snapshotRef.current = sentPayload;
        }
        setSnapshotVersion(v => v + 1);
    }, [categories]);

    const save = useCallback(async () => {
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
            const res = await authFetch(`${API_BASE}/api/org-privacy-shield/${selectedOrgId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(currentPayload),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                const text = data.error || 'Failed to save.';
                setMessage({ type: 'error', text });
                return { ok: false, error: text };
            }

            // The save succeeded, so the server's row is the new baseline:
            // including any value it clamped or rejected.
            adoptSaved(data.config, currentPayload);
            const outcome = describeSaveResult(data, t);
            // A clamped field means the stored value differs from what was
            // submitted. Reflect the stored value rather than a bare "saved"
            // that hides the override.
            if (outcome.clampedAction) setPiiAction(outcome.clampedAction);
            setMessage(outcome.message);
            return outcome.result;
        } catch {
            setMessage({ type: 'error', text: 'Error saving.' });
            return { ok: false, error: 'Error saving.' };
        } finally {
            setSaving(false);
        }
    }, [selectedOrgId, currentPayload, adoptSaved, t]);

    // Toggle one PII category in a tool-class block list (external | internal).
    const toggleToolPiiCat = useCallback((cls, id, checked) => setToolPiiPolicy(prev => ({
        ...prev,
        [cls]: {
            blockCategories: checked
                ? [...new Set([...(prev[cls]?.blockCategories || []), id])]
                : (prev[cls]?.blockCategories || []).filter(x => x !== id),
        },
    })), []);

    const setToolPiiCats = useCallback((cls, ids) => setToolPiiPolicy(prev => ({
        ...prev,
        [cls]: { blockCategories: ids },
    })), []);

    return {
        loading, shieldLoading, saving, message, setMessage,
        loadError, isDirty, dirtyStages, canSave, saved,
        orgList, selectedOrgId, selectOrg,
        hasEuModelsConfigured, hasWebSearchEnabled,
        guardStatus, guardCheckedAt, meta,
        categories,
        save, discard,
        toggleToolPiiCat, setToolPiiCats,
        confirmDialog,
        fields: {
            enabled, setEnabled,
            euModeEnabled, setEuModeEnabled,
            webSearchGuard, setWebSearchGuard,
            disableSearchOnUpload, setDisableSearchOnUpload,
            monitorIntegrations, setMonitorIntegrations,
            applyToAutomations, setApplyToAutomations,
            dlpEnabled, setDlpEnabled,
            dlpMode, setDlpMode,
            dlpAlwaysReview, setDlpAlwaysReview,
            customDataTypes, setCustomDataTypes,
            customDataTests, setCustomDataTests,
            piiAllowTerms, setPiiAllowTerms,
            piiAllowPublicOrgs, setPiiAllowPublicOrgs,
            toolPiiPolicy,
            piiCategories, setPiiCategories,
            piiConfidenceThreshold, setPiiConfidenceThreshold,
            piiAction, setPiiAction,
            showRawPayload, setShowRawPayload,
            scanKnowledgeBases, setScanKnowledgeBases,
        },
    };
}

export default useOrgShield;
