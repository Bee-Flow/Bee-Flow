/**
 * useComplianceCore — the hub's spine data: overview, checks, score history,
 * the run/rerun/auto-fix actions, the audit trail loader, settings and the
 * setup path. Lifted verbatim from the pre-redesign index.jsx so every toast
 * key keeps the one English sentence index.test.jsx pins.
 *
 * `refresh()` re-reads the three core endpoints and, when the org has not
 * finished setup, flips `setupOpen` — the Overview page renders the inline
 * setup card from it (the redesign has ONE setup path: no banner, no modal).
 * `onChanged` is called after every mutation so the hub can bump the counts.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';
import { toast } from '../../../shared/Toast';
import { API, fetchJson, json, jsonInit } from './api';

export default function useComplianceCore({ onChanged = null } = {}) {
    const { t } = useTranslation();
    const [overview, setOverview] = useState(null);
    const [checks, setChecks] = useState([]);
    const [scoreHistory, setScoreHistory] = useState([]);
    const [loading, setLoading] = useState(true);
    const [running, setRunning] = useState(false);
    const [rerunningId, setRerunningId] = useState(null);
    const [autoFixingId, setAutoFixingId] = useState(null);
    const [setupOpen, setSetupOpen] = useState(false);
    const changed = useRef(onChanged);
    useEffect(() => { changed.current = onChanged; });
    const bump = () => { try { changed.current?.(); } catch { /* counts are best-effort */ } };

    const refresh = useCallback(async () => {
        try {
            const [o, c, hist] = await Promise.all([
                fetchJson(`${API}/overview`),
                fetchJson(`${API}/checks`),
                fetchJson(`${API}/score-history?days=90`).catch(() => []),
            ]);
            setOverview(o);
            setChecks(Array.isArray(c) ? c : []);
            setScoreHistory(Array.isArray(hist) ? hist : []);
            if (o && o.onboarded === false) setSetupOpen(true);
            if (o?.first_scan_ran) {
                toast.success(t('compliance.toast_first_scan', 'First compliance scan complete — review the score and open items below.'));
            }
        } catch (e) {
            console.error('[ComplianceHub] refresh error:', e.message);
        } finally {
            setLoading(false);
        }
        bump();
    }, [t]);

    useEffect(() => { refresh(); }, [refresh]);

    const runNow = async () => {
        setRunning(true);
        try {
            const r = await fetchJson(`${API}/checks/run`, { method: 'POST' });
            await refresh();
            toast.success(t('compliance.toast_scan_complete', { score: r?.score?.score ?? '' }) ||
                `Compliance scan complete (score: ${r?.score?.score ?? '—'}/100)`);
        } catch (e) {
            console.error('[ComplianceHub] run error:', e.message);
            toast.error(t('compliance.toast_scan_failed', 'Scan failed — see server logs'));
        } finally { setRunning(false); }
    };

    const rerun = async (checkId) => {
        setRerunningId(checkId);
        try {
            await fetchJson(`${API}/checks/${encodeURIComponent(checkId)}/run`, { method: 'POST' });
            await refresh();
            toast.success(t('compliance.toast_check_rerun', 'Check re-run complete'));
        } catch (e) {
            console.error('[ComplianceHub] rerun error:', e.message);
            toast.error(t('compliance.toast_check_failed', 'Could not re-run this check'));
        } finally { setRerunningId(null); }
    };

    const autoFix = async (checkId) => {
        setAutoFixingId(checkId);
        try {
            const r = await fetchJson(`${API}/checks/${encodeURIComponent(checkId)}/auto-fix`, json({}));
            await refresh();
            toast.success(r?.result?.summary || t('compliance.toast_auto_fixed', 'Automatic fix applied'));
        } catch (e) {
            console.error('[ComplianceHub] auto-fix error:', e.message);
            toast.error(t('compliance.toast_auto_fix_failed', 'Automatic fix failed — see server logs'));
        } finally { setAutoFixingId(null); }
    };

    // An admin's decision about one open finding (acknowledge / accept risk /
    // snooze / re-open). No toast: the row's chip is the confirmation, and a
    // refusal is thrown back to the control that asked, which says it inline.
    const decideFinding = useCallback(async (checkId, scopeId, body) => {
        const r = await fetchJson(
            `${API}/checks/${encodeURIComponent(checkId)}/state`,
            jsonInit('POST', { ...(body || {}), scope_id: scopeId ?? null }),
        );
        await refresh();
        return r;
    }, [refresh]);

    // Audit trail per check — status timeline + hashed evidence rows. Fetched
    // on demand when a row's "History & evidence" column opens.
    const loadTrail = useCallback(async (checkId) => {
        const enc = encodeURIComponent(checkId);
        const [history, evidence] = await Promise.all([
            fetchJson(`${API}/checks/${enc}/history`).catch(() => []),
            fetchJson(`${API}/evidence/${enc}`).catch(() => []),
        ]);
        return { history, evidence };
    }, []);

    const saveSettings = async (body) => {
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

    const finishSetup = async (body) => {
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
