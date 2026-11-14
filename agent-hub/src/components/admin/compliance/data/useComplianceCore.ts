/**
 * useComplianceCore — the hub's spine data: overview, checks, score history,
 * the run/rerun/auto-fix actions, the audit trail loader, settings and the
 * setup path. Lifted verbatim from the pre-redesign index.jsx so every toast
 * key keeps the one English sentence index.test.jsx pins.
 *
 * `refresh()` re-reads the three core endpoints (one query) and, when the org has not
 * finished setup, flips `setupOpen` — the Overview page renders the inline
 * setup card from it (the redesign has ONE setup path: no banner, no modal).
 * `onChanged` is called after every mutation so the hub can bump the counts.
 */
import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';
import { API, fetchJson, json, jsonInit } from '@/api/complianceApi';
import { useComplianceCoreQuery } from '@/api/queries/complianceCore';
import useAdjustOnChange from '@/hooks/useAdjustOnChange';
import { useTranslation } from '@/hooks/useTranslation';
import { toast } from '@/components/shared/Toast';
import type { CheckRecord } from '../pages/framework/checkSort';
import type { SetupSettings } from '../setup/SetupSteps';
import type { HistoryRow } from '../shared/miniBarsMath';
import { logger } from '@/utils/logger';

interface ScoreHistoryRow extends HistoryRow {
    captured_at: string;
    overall_score: number;
    gdpr_score: number;
    aia_score: number;
    iso_score: number;
}

interface FrameworkScore {
    score: number;
    total: number;
    pass: number;
    warn: number;
    fail?: number;
    na?: number;
}

interface VerificationSummary {
    automated: { total: number; pass: number };
    attestation: { total: number; pass: number };
    hybrid: { total: number; pass: number };
}

/** GET /api/compliance/overview, as far as the hub's pages read it. */
interface ComplianceOverview {
    onboarded?: boolean;
    first_scan_ran?: boolean;
    settings?: (SetupSettings & { org_name?: string | null }) | null;
    organization_name?: string | null;
    last_run_at?: string | null;
    frameworks_detail?: Record<string, (FrameworkScore & { checks_count?: number }) | null | undefined> | null;
    gdpr?: FrameworkScore | null;
    aia?: FrameworkScore | null;
    iso?: FrameworkScore | null;
    verification_summary_by_framework?: Record<string, VerificationSummary | null | undefined> | null;
}

type DecisionBody = Record<string, unknown> | null | undefined;

interface UseComplianceCoreArgs {
    onChanged?: (() => void) | null;
}

const NO_CHECKS: CheckRecord[] = [];
const NO_HISTORY: ScoreHistoryRow[] = [];

/**
 * The three core reads (one query), the setup card's open state and what each
 * answer sets off: a setup still to finish opens the card, a first scan says
 * so, and the hub's counts are bumped after every read, failed ones too.
 */
function useCoreRead(t: ReturnType<typeof useTranslation>['t'], bump: () => void) {
    const [setupOpen, setSetupOpen] = useState(false);
    const core = useComplianceCoreQuery<ComplianceOverview | null, CheckRecord, ScoreHistoryRow>();
    const overview = core.data?.overview ?? null;
    const checks = core.data?.checks ?? NO_CHECKS;
    const scoreHistory = core.data?.scoreHistory ?? NO_HISTORY;
    const loading = core.isPending;
    useAdjustOnChange([core.dataUpdatedAt], () => {
        if (core.data?.overview?.onboarded === false) setSetupOpen(true);
    });
    const onAnswer = useEffectEvent(() => {
        if (core.data?.overview?.first_scan_ran) {
            toast.success(t('compliance.toast_first_scan', 'First compliance scan complete — review the score and open items below.'));
        }
        bump();
    });
    const onFailure = useEffectEvent(() => {
        console.error('[ComplianceHub] refresh error:', core.error?.message);
        bump();
    });
    // Answers read since this mount only: a cached one from an earlier visit has had its toast.
    const [cachedAt] = useState(() => ({ data: core.dataUpdatedAt, error: core.errorUpdatedAt }));
    useEffect(() => { if (core.dataUpdatedAt > cachedAt.data) onAnswer(); }, [core.dataUpdatedAt, cachedAt]);
    useEffect(() => { if (core.errorUpdatedAt > cachedAt.error) onFailure(); }, [core.errorUpdatedAt, cachedAt]);
    const refetchCore = core.refetch;
    const refresh = useCallback(async () => { await refetchCore(); }, [refetchCore]);

    return { overview, checks, scoreHistory, loading, setupOpen, setSetupOpen, refresh };
}

export default function useComplianceCore({ onChanged = null }: UseComplianceCoreArgs = {}) {
    const { t } = useTranslation();
    const [running, setRunning] = useState(false);
    const [rerunningId, setRerunningId] = useState<string | null>(null);
    const [autoFixingId, setAutoFixingId] = useState<string | null | undefined>(null);
    const changed = useRef(onChanged);
    useEffect(() => { changed.current = onChanged; });
    const bump = () => { try { changed.current?.(); } catch (err) { logger.debug('counts are best-effort', err); } };

    const { overview, checks, scoreHistory, loading, setupOpen, setSetupOpen, refresh } = useCoreRead(t, bump);

    const runNow = async () => {
        setRunning(true);
        try {
            const r = await fetchJson(`${API}/checks/run`, { method: 'POST' });
            await refresh();
            toast.success(t('compliance.toast_scan_complete', { score: r?.score?.score ?? '' }) ||
                `Compliance scan complete (score: ${r?.score?.score ?? '—'}/100)`);
        } catch (e) {
            console.error('[ComplianceHub] run error:', (e as Error).message);
            toast.error(t('compliance.toast_scan_failed', 'Scan failed — see server logs'));
        } finally { setRunning(false); }
    };

    const rerun = async (checkId: string) => {
        setRerunningId(checkId);
        try {
            await fetchJson(`${API}/checks/${encodeURIComponent(checkId)}/run`, { method: 'POST' });
            await refresh();
            toast.success(t('compliance.toast_check_rerun', 'Check re-run complete'));
        } catch (e) {
            console.error('[ComplianceHub] rerun error:', (e as Error).message);
            toast.error(t('compliance.toast_check_failed', 'Could not re-run this check'));
        } finally { setRerunningId(null); }
    };

    const autoFix = async (checkId: string | undefined) => {
        setAutoFixingId(checkId);
        try {
            const r = await fetchJson(`${API}/checks/${encodeURIComponent(String(checkId))}/auto-fix`, json({}));
            await refresh();
            toast.success(r?.result?.summary || t('compliance.toast_auto_fixed', 'Automatic fix applied'));
        } catch (e) {
            console.error('[ComplianceHub] auto-fix error:', (e as Error).message);
            toast.error(t('compliance.toast_auto_fix_failed', 'Automatic fix failed — see server logs'));
        } finally { setAutoFixingId(null); }
    };

    // An admin's decision about one open finding (acknowledge / accept risk /
    // snooze / re-open). No toast: the row's chip is the confirmation, and a
    // refusal is thrown back to the control that asked, which says it inline.
    const decideFinding = useCallback(async (checkId: string, scopeId: string | null | undefined, body: DecisionBody) => {
        const r = await fetchJson(
            `${API}/checks/${encodeURIComponent(checkId)}/state`,
            jsonInit('POST', { ...(body || {}), scope_id: scopeId ?? null }),
        );
        await refresh();
        return r;
    }, [refresh]);

    // Audit trail per row — status timeline + hashed evidence rows. Fetched
    // on demand when a row's "History & evidence" column opens. A per-subject
    // row asks for its own subject's history only (`scope_id`).
    const loadTrail = useCallback(async (checkId: string, scopeId: string | null = null) => {
        const enc = encodeURIComponent(checkId);
        const scope = scopeId ? `?scope_id=${encodeURIComponent(scopeId)}` : '';
        const [history, evidence] = await Promise.all([
            fetchJson(`${API}/checks/${enc}/history${scope}`).catch(() => []),
            fetchJson(`${API}/evidence/${enc}`).catch(() => []),
        ]);
        return { history, evidence };
    }, []);

    const saveSettings = async (body: unknown) => {
        try {
            const saved = await fetchJson(`${API}/settings`, jsonInit('PUT', body));
            await refresh();
            toast.success(t('compliance.toast_settings_saved', 'Settings saved — running checks again…'));
            return saved;
        } catch (e) {
            toast.error(t('compliance.toast_settings_failed', 'Could not save settings'));
            throw e;
        }
    };

    // Read-only pre-fill for setup — synthesised server-side from the org's
    // live config (providers → residency, admins → breach recipients).
    const autoDetect = useCallback(() => fetchJson(`${API}/auto-detect-settings`, { method: 'POST' }), []);

    const finishSetup = async (body: unknown) => {
        try {
            await fetchJson(`${API}/settings/onboarded`, json(body));
            setSetupOpen(false);
            await refresh();
            toast.success(t('compliance.toast_wizard_done', 'Setup complete — your first compliance scan is running'));
        } catch (e) {
            toast.error(t('compliance.toast_wizard_failed', 'Could not save setup — try again'));
            throw e;
        }
    };

    return {
        overview, checks, scoreHistory, loading, running, rerunningId, autoFixingId,
        onboarded: overview ? overview.onboarded !== false : null,
        settings: overview?.settings || null,
        setupOpen, openSetup: () => setSetupOpen(true), closeSetup: () => setSetupOpen(false),
        refresh, runNow, rerun, autoFix, decideFinding, loadTrail, saveSettings, autoDetect, finishSetup,
    };
}
