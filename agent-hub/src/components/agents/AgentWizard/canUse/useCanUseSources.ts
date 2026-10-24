import { useCallback, useEffect, useState } from 'react';
import { READ, datatableGrantsOf } from './canUseFacts';
import { API_BASE, authFetch } from '../../../../utils/helpers';
import type { ReadState } from '../agentEditor.types';
import { logger } from '../../../../utils/logger';

/** `GET /api/skills/usage-summary`: per skill id how many agents link it. */
type SkillUsageSummary = Record<string, { agents?: number | null }>;

/**
 * The two EXTRA reads that the "Can use" tab needs and that the editor did not yet do (A2 step 2):
 *
 *   `GET /api/datatables`            the NAMES of the table grants from `config.tools.datatables`;
 *   `GET /api/skills/usage-summary`  "also used by k other agents".
 *
 * ── ONLY READ WHAT THERE IS TO ASK ABOUT ───────────────────────────
 * Both reads only go out the door if there is something to ask about. That is not only frugal, it also keeps the card
 * honest: `/api/datatables` sits behind `requireModule('automation')` + `requireLicenseFeature('automations')`, and
 * `/api/skills` behind `requireCapability('skills')`. So in an organisation without those modules a 403 is the NORMAL
 * answer. An agent without table grants would get a warning there about something it does not have, and a warning that
 * always stands teaches people to ignore it. No grants ⇒ no read ⇒ `READ.OK` with zero rows, which is the truth.
 *
 * ── AND OTHERWISE: SAY THE ERROR, DO NOT SWALLOW IT ─────────────────
 * If there ARE grants and the read fails, that is news: the agent reads those tables, and we cannot say which. Then
 * `READ.ERROR`, with `refetch` attached. The pattern of `hooks/useUsage.js`: never a silent empty list where a failed
 * read belongs.
 */
export default function useCanUseSources({ enabled = true, toolsConfig = null, attachedSkillIds = [], savedSkillIds = [] }: {
    enabled?: boolean;
    toolsConfig?: unknown;
    attachedSkillIds?: string[];
    savedSkillIds?: string[];
}) {
    const [tables, setTables] = useState<Array<{ id?: string; name?: string }> | null>(null);
    const [tablesState, setTablesState] = useState<ReadState>(READ.LOADING);
    const [usage, setUsage] = useState<SkillUsageSummary | null>(null);
    const [usageState, setUsageState] = useState<ReadState>(READ.LOADING);
    // A counter that rises on every refetch: the effect hangs on it, so trying again is one setState and not a second copy
    // of the fetch.
    const [tablesNonce, setTablesNonce] = useState(0);
    const [usageNonce, setUsageNonce] = useState(0);

    const grantCount = datatableGrantsOf(toolsConfig).grants.length;
    const skillIds = Array.isArray(attachedSkillIds) ? attachedSkillIds.filter(id => typeof id === 'string' && id) : [];
    const savedIds = Array.isArray(savedSkillIds) ? savedSkillIds.filter(id => typeof id === 'string' && id) : [];
    /**
     * The id lists as keys, so that the effect reacts to CONTENT and not to the new array identity that every render of the
     * parent produces.
     *
     * There are TWO of them, and the second is the reason the subtraction is correct. The summary counts the SAVED config of
     * every agent. If you tick a skill, the live list changes and we fetch the count again, but the save is still on its way,
     * so this agent is not in it yet. As soon as the save lands, the saved list changes, and only then does the server count
     * this agent. Without that second read, `skillRows` would subtract one from a count that did not yet contain that one:
     * "also used by 2 other agents" where there are 3.
     */
    const skillKey = `${skillIds.join(',')}|${savedIds.join(',')}`;

    useEffect(() => {
        if (!enabled) return undefined;
        // Nothing granted? Then "no tables" is a read fact, not a guess.
        if (grantCount === 0) { setTables([]); setTablesState(READ.OK); return undefined; }
        const ctrl = new AbortController();
        let alive = true;
        setTablesState(READ.LOADING);
        (async () => {
            try {
                const res = await authFetch(`${API_BASE}/api/datatables`, { signal: ctrl.signal });
                if (!alive || ctrl.signal.aborted) return;
                if (!res.ok) throw new Error(`datatables ${res.status}`);
                const body = await res.json();
                if (!alive || ctrl.signal.aborted) return;
                setTables(Array.isArray(body?.datatables) ? body.datatables : []);
                setTablesState(Array.isArray(body?.datatables) ? READ.OK : READ.ERROR);
            } catch (_) {
                if (!alive || ctrl.signal.aborted) return;
                setTables(null);
                setTablesState(READ.ERROR);
            }
        })();
        return () => { alive = false; try { ctrl.abort(); } catch (err) { logger.debug('noop', err); } };
    }, [enabled, grantCount, tablesNonce]);

    useEffect(() => {
        if (!enabled) return undefined;
        // Nothing linked, neither now nor saved: then there is nothing to count, and `{}` is a read answer.
        if (skillIds.length === 0) { setUsage({}); setUsageState(READ.OK); return undefined; }
        const ctrl = new AbortController();
        let alive = true;
        setUsageState(READ.LOADING);
        (async () => {
            try {
                const res = await authFetch(`${API_BASE}/api/skills/usage-summary`, { signal: ctrl.signal });
                if (!alive || ctrl.signal.aborted) return;
                if (!res.ok) throw new Error(`usage-summary ${res.status}`);
                const body = await res.json();
                if (!alive || ctrl.signal.aborted) return;
                const summary = body && typeof body.summary === 'object' && body.summary ? body.summary : null;
                setUsage(summary);
                setUsageState(summary ? READ.OK : READ.ERROR);
            } catch (_) {
                if (!alive || ctrl.signal.aborted) return;
                setUsage(null);
                setUsageState(READ.ERROR);
            }
        })();
        return () => { alive = false; try { ctrl.abort(); } catch (err) { logger.debug('noop', err); } };
    }, [enabled, skillKey, skillIds.length, usageNonce]);

    const refetchTables = useCallback(() => setTablesNonce(n => n + 1), []);
    const refetchUsage = useCallback(() => setUsageNonce(n => n + 1), []);

    return { tables, tablesState, refetchTables, usage, usageState, refetchUsage };
}
