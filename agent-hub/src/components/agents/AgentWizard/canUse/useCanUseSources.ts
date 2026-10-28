import { useCallback } from 'react';
import { READ, datatableGrantsOf } from './canUseFacts';
import { useAgentDatatableNames, useSkillUsageSummary } from '@/api/queries/agentWizardFacts';
import type { ReadState } from '../agentEditor.types';

const NO_TABLES: Array<{ id?: string; name?: string }> = [];
const NO_USAGE: Record<string, { agents?: number | null }> = {};

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
type TablesQuery = ReturnType<typeof useAgentDatatableNames>;
type UsageQuery = ReturnType<typeof useSkillUsageSummary>;

/** What the tables card sees: no grants is a read zero, a refused or unreadable answer is ERROR with no rows. */
function tablesView(enabled: boolean, grantCount: number, active: boolean, q: TablesQuery) {
    if (enabled && grantCount === 0) return { tables: NO_TABLES, tablesState: READ.OK as ReadState };
    if (!active) return { tables: null, tablesState: READ.LOADING as ReadState };
    let tablesState: ReadState = READ.LOADING;
    if (!q.isFetching) {
        if (q.isError) tablesState = READ.ERROR;
        else if (q.data) tablesState = q.data.valid ? READ.OK : READ.ERROR;
    }
    return { tables: q.isError ? null : (q.data?.rows ?? null), tablesState };
}

/** What the usage count sees: no linked skills is a read `{}`, a refused or unreadable answer is ERROR with no summary. */
function usageView(enabled: boolean, skillCount: number, active: boolean, q: UsageQuery) {
    if (enabled && skillCount === 0) return { usage: NO_USAGE, usageState: READ.OK as ReadState };
    if (!active) return { usage: null, usageState: READ.LOADING as ReadState };
    let usageState: ReadState = READ.LOADING;
    if (!q.isFetching) {
        if (q.isError) usageState = READ.ERROR;
        else if (q.data !== undefined) usageState = q.data ? READ.OK : READ.ERROR;
    }
    return { usage: q.isError ? null : (q.data ?? null), usageState };
}

export default function useCanUseSources({ enabled = true, toolsConfig = null, attachedSkillIds = [], savedSkillIds = [] }: {
    enabled?: boolean;
    toolsConfig?: unknown;
    attachedSkillIds?: string[];
    savedSkillIds?: string[];
}) {
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

    // Nothing granted? Then "no tables" is a read fact, not a guess. Nothing linked, neither now nor saved: then there is
    // nothing to count, and `{}` is a read answer.
    const tablesActive = enabled && grantCount > 0;
    const usageActive = enabled && skillIds.length > 0;
    const tablesQuery = useAgentDatatableNames(tablesActive, grantCount);
    const usageQuery = useSkillUsageSummary(usageActive, skillKey);

    const { tables, tablesState } = tablesView(enabled, grantCount, tablesActive, tablesQuery);
    const { usage, usageState } = usageView(enabled, skillIds.length, usageActive, usageQuery);

    const { refetch: refetchTablesQuery } = tablesQuery;
    const { refetch: refetchUsageQuery } = usageQuery;
    const refetchTables = useCallback(() => { if (tablesActive) void refetchTablesQuery(); }, [tablesActive, refetchTablesQuery]);
    const refetchUsage = useCallback(() => { if (usageActive) void refetchUsageQuery(); }, [usageActive, refetchUsageQuery]);

    return { tables, tablesState, refetchTables, usage, usageState, refetchUsage };
}
