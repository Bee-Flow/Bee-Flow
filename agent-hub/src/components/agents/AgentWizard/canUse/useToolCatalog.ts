import { useCallback, useMemo } from 'react';
import { READ } from './canUseFacts';
import { useToolCatalogQuery, useToolLendingQuery } from '@/api/queries/agentWizardFacts';
import type { ReadState } from '../agentEditor.types';
import type { ToolApp } from './toolCatalogTypes';

const NO_LENT: Set<string> = new Set();

/**
 * The two reads that the Tools card needs (A2 step 3).
 *
 *   `GET /agents/tool-catalog`
 *       which apps there are, which actions they have, what each action DOES (`reads|writes|sends`), and whether this
 *       user may use the app.
 *
 *   `GET /agents/:id/tool-lending`
 *       for which apps this agent may borrow the connection of its OWNER: the only basis on which the card may offer
 *       "in the name of the owner".
 *
 * ── WHY NOT /api/integrations/connections/grants ───────────────────
 * Because that route scopes unconditionally to the LOGGED-IN user (`grantorUserId: userId`, server/routes/integrations/
 * connections.js), and the runtime lends from `agent.owner_id` (toolPolicy.resolveLentProviders, called with the owner in
 * routes/agents/crud.js and stores/agent/agentCrud.js). An agent may also be edited by the super admin, and by an org member
 * with `manage_agents`, and then those are two different people. The screen then offered "as you" on the basis of the grants
 * of the EDITOR, while the runtime looked at those of the OWNER. Wrong in both directions.
 *
 * The server therefore answers the question itself, about the owner, and gives back precisely one thing: yes or no per app.
 * Not which connection there is. The editor does not have to be the owner, and then that would be a look into someone
 * else's integrations.
 *
 * ── WHY NOT /api/automation/catalog ─────────────────────────────────
 * Because that route hangs behind `requireModule('automation')` + `requireLicenseFeature('automations')` +
 * `requireBetaFeature('automations')` (server/index.js r693, routes/automation.js), and agent tool grants have nothing to do
 * with automations. An organisation without that module would get a 403 there, and the card would then show an EMPTY tools
 * list to precisely the customers whose agents do have tools. Therefore a second, UNGATED source was built
 * (`server/routes/agents/toolCatalog.js`), which draws its answers from the same primitives as the runtime.
 *
 * ── THREE STATES, AND THE NARROW SIDE IN DOUBT ──────────────────────
 * Both reads carry a `READ` state. A failed catalogue is not "this agent has no tools": the GRANTS are in the config and we
 * always have those, so the rows stay, and only the counts and the effects are missing. What then happens is the narrow
 * reading, exactly as the runtime takes it: an unknown effect counts as "it sends" (locked on confirm), and an unreadable
 * lending answer counts as "not lent" (no owner option). See `toolGrants.toolRows`.
 *
 * The lending read only goes out the door if the agent ALREADY EXISTS: without an id there is no resource to have grants
 * on, and then "nothing lent" is a read fact instead of a failure.
 */
type CatalogQuery = ReturnType<typeof useToolCatalogQuery<ToolApp>>;
type LendingQuery = ReturnType<typeof useToolLendingQuery>;

/**
 * Unknown narrows, also during a RE-READ: leaving the old catalogue in place while another agent is loaded makes the card
 * calculate with someone else's answer. So fetching or failed = no catalogue.
 */
function catalogView(enabled: boolean, q: CatalogQuery) {
    const catalog = q.isFetching || q.isError ? null : (q.data ?? null);
    let catalogState: ReadState = READ.LOADING;
    if (enabled && !q.isFetching) catalogState = q.isError ? READ.ERROR : q.data ? READ.OK : READ.LOADING;
    return { catalog, catalogState };
}

/**
 * An agent that has not been saved yet cannot have lent grants: grants hang on a resource id. That is a read zero.
 * While loading, the answer is UNKNOWN (the previous value is the answer about a DIFFERENT agent), and a failed read is
 * `null`, not an empty Set: "I could not check" is not "nothing is lent".
 */
function lendingView(enabled: boolean, noAgent: boolean, q: LendingQuery) {
    const lending = q.isFetching || q.isError ? null : (q.data ?? null);
    let lentState: ReadState = READ.LOADING;
    if (noAgent) lentState = READ.OK;
    else if (enabled && !q.isFetching) lentState = q.isError ? READ.ERROR : q.data ? READ.OK : READ.LOADING;
    return { lending, lentState };
}

export default function useToolCatalog({ enabled = true, agentId = null }: { enabled?: boolean; agentId?: string | number | null } = {}) {
    const catalogQuery = useToolCatalogQuery<ToolApp>(enabled);
    const lendingQuery = useToolLendingQuery(enabled, agentId);

    const { catalog, catalogState } = catalogView(enabled, catalogQuery);
    const noAgent = enabled && !agentId;
    const { lending, lentState } = lendingView(enabled, noAgent, lendingQuery);
    const lendingApps = lending?.apps;
    const lentApps = useMemo<Set<string> | null>(() => (noAgent ? NO_LENT : lendingApps ? new Set(lendingApps) : null), [noAgent, lendingApps]);
    // Whether the agent IS CURATED as the RUNTIME reads it (`null` = unknown). It comes from the same route, because it is the
    // same question: what happens now when someone runs this agent. The editor has only the draft.
    const runtimeCurated = noAgent ? null : (lending?.runtimeCurated ?? null);

    const { refetch: refetchCatalogQuery } = catalogQuery;
    const { refetch: refetchLendingQuery } = lendingQuery;
    const refetchCatalog = useCallback(() => { if (enabled) void refetchCatalogQuery(); }, [enabled, refetchCatalogQuery]);
    const refetchLent = useCallback(() => { if (enabled && agentId) void refetchLendingQuery(); }, [enabled, agentId, refetchLendingQuery]);

    return {
        apps: catalog?.apps ?? null,
        catalogDegraded: catalog?.degraded === true,
        providersKnown: catalogState === READ.OK && catalog?.providersKnown === true,
        lendingEnabled: catalog?.lendingEnabled === true,
        catalogState,
        refetchCatalog,
        lentApps,
        lentState,
        refetchLent,
        runtimeCurated,
    };
}
