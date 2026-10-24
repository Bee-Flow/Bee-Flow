import { useCallback, useEffect, useState } from 'react';
import { READ } from './canUseFacts';
import { API_BASE, authFetch } from '../../../../utils/helpers';
import type { ReadState } from '../agentEditor.types';
import type { ToolApp } from './toolCatalogTypes';
import { logger } from '../../../../utils/logger';

/** What `GET /agents/tool-catalog` answers, narrowed to what the card reads. */
interface CatalogAnswer {
    apps: ToolApp[];
    degraded: boolean;
    providersKnown: boolean;
    lendingEnabled: boolean;
}

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
export default function useToolCatalog({ enabled = true, agentId = null }: { enabled?: boolean; agentId?: string | number | null } = {}) {
    const [catalog, setCatalog] = useState<CatalogAnswer | null>(null);
    const [catalogState, setCatalogState] = useState<ReadState>(READ.LOADING);
    const [lentApps, setLentApps] = useState<Set<string> | null>(null);
    const [lentState, setLentState] = useState<ReadState>(READ.LOADING);
    // Whether the agent IS CURATED as the RUNTIME reads it (`null` = unknown). It comes from the same route, because it is the
    // same question: what happens now when someone runs this agent. The editor has only the draft.
    const [runtimeCurated, setRuntimeCurated] = useState<boolean | null>(null);
    const [catalogNonce, setCatalogNonce] = useState(0);
    const [lentNonce, setLentNonce] = useState(0);

    useEffect(() => {
        if (!enabled) return undefined;
        const ctrl = new AbortController();
        let alive = true;
        setCatalogState(READ.LOADING);
        // Unknown narrows, also during a RE-READ: leaving the old catalogue in place while another agent is loaded makes the card
        // calculate with someone else's answer.
        setCatalog(null);
        (async () => {
            try {
                const res = await authFetch(`${API_BASE}/agents/tool-catalog`, { signal: ctrl.signal });
                if (!alive || ctrl.signal.aborted) return;
                if (!res.ok) throw new Error(`tool-catalog ${res.status}`);
                const body = await res.json();
                if (!alive || ctrl.signal.aborted) return;
                if (!Array.isArray(body?.apps)) throw new Error('tool-catalog: no apps');
                setCatalog({
                    apps: body.apps,
                    // The server itself says whether it could calculate the availability. `degraded` means that every `available` is at
                    // `null`, so the card may not draw "not available", because that would be an assertion.
                    degraded: body.degraded === true,
                    providersKnown: body.providersKnown !== false,
                    lendingEnabled: body.lendingEnabled === true,
                });
                setCatalogState(READ.OK);
            } catch (_) {
                if (!alive || ctrl.signal.aborted) return;
                setCatalog(null);
                setCatalogState(READ.ERROR);
            }
        })();
        return () => { alive = false; try { ctrl.abort(); } catch (err) { logger.debug('noop', err); } };
    }, [enabled, catalogNonce]);

    useEffect(() => {
        if (!enabled) return undefined;
        // An agent that has not been saved yet cannot have lent grants: grants hang on a resource id. That is a read zero.
        if (!agentId) {
            setLentApps(new Set());
            setLentState(READ.OK);
            setRuntimeCurated(null);
            return undefined;
        }
        const ctrl = new AbortController();
        let alive = true;
        setLentState(READ.LOADING);
        // The same reason as with the catalogue: while loading, the answer is UNKNOWN, and the previous value is the answer about
        // a DIFFERENT agent. If it stays, the owner switch in that window opens on the basis of someone else's lending.
        setLentApps(null);
        setRuntimeCurated(null);
        (async () => {
            try {
                const url = `${API_BASE}/agents/${encodeURIComponent(String(agentId))}/tool-lending`;
                const res = await authFetch(url, { signal: ctrl.signal });
                if (!alive || ctrl.signal.aborted) return;
                if (!res.ok) throw new Error(`tool-lending ${res.status}`);
                const body = await res.json();
                if (!alive || ctrl.signal.aborted) return;
                // `readable: false` is the narrow answer of the server: no owner, a probe that is broken, an attribution that is broken.
                // That is not an empty list. It is not a list at all.
                if (body?.readable !== true) throw new Error('tool-lending: not readable');
                if (!Array.isArray(body?.apps)) throw new Error('tool-lending: no list');
                setLentApps(new Set(body.apps.filter((id: unknown) => typeof id === 'string' && id)));
                setRuntimeCurated(typeof body.runtimeCurated === 'boolean' ? body.runtimeCurated : null);
                setLentState(READ.OK);
            } catch (_) {
                if (!alive || ctrl.signal.aborted) return;
                // `null`, not an empty Set: "I could not check" is not "nothing is lent". `toolRows` refuses the owner option on both, but
                // only the first deserves an explanation on the screen.
                setLentApps(null);
                setRuntimeCurated(null);
                setLentState(READ.ERROR);
            }
        })();
        return () => { alive = false; try { ctrl.abort(); } catch (err) { logger.debug('noop', err); } };
    }, [enabled, agentId, lentNonce]);

    const refetchCatalog = useCallback(() => setCatalogNonce(n => n + 1), []);
    const refetchLent = useCallback(() => setLentNonce(n => n + 1), []);

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
