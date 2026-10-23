import type { CallableAutomation } from '../../../admin/Studio/SkillsStudio/skillModel.types';
import type { ToolApp } from './toolCatalogTypes';

/** An automation row as the Tools card reads it (list endpoint or detail). */
export interface AutomationLike extends CallableAutomation {
    id?: string;
    title?: unknown;
    name?: unknown;
    definition?: { trigger?: { kind?: string | null; parametersSchema?: unknown } | null } | null;
    trigger?: { parametersSchema?: unknown } | null;
}

/** Keys of `config.tools` that are NOT an app id (mirror of toolPolicy.js). */
/** `config.tools`: one entry per app (and the reserved sections), each read defensively. */
export type ToolsConfig = Record<string, unknown>;

export type ToolsConfigIn = ToolsConfig | null | undefined;

export type ClaimantsIndex = Map<string, string[]>;

export type SelectionMap = Map<string, Set<string> | null>;

/**
  * A2-2 — what happens to the lent connection when NOTHING is stored.
  *
  * With an empty `actAs` the capsule draws "As: the person asking", and that was
  * not true: `mayLendOwnerConnection` returned `true` for an app WITHOUT an
  * entry and the runtime lent out the OWNER's connection. That gate is now
  * closed (only a stored yes lends), but that is a behaviour change for existing
  * agents, and it belongs on the card instead of happening silently.
  *
  * `lendable` is exactly the condition under which there was something to lend:
  * a user connection, lending on, and a READABLE lending list that contains THIS
  * app. Unreadable (`lentApps === null`) does not count: then we do not know
  * whether anything changed, so we do not claim it either.
  *
  * `curated` here is the RUNTIME reading (`runtimeCurated` from the server), not
  * the draft in the editor: these two sentences are about what happens NOW when
  * someone runs the agent, and that reads `published_config`. If that answer is
  * unknown (`null`), neither notice fires: a reassurance that is not correct is
  * worse than no sentence.
  *
  * Two states, one cause ("nothing is stored"), opposite consequences, and they
  * exclude each other because `curated` is the opt-in boundary:
  *   not curated ⇒ the runtime still lends, the capsule says it does not;
  *   curated     ⇒ the runtime no longer lends, and THAT is the news.
  * Neither depends on `sends`: the lending gate does not look at that, so a
  * sending app lent (and now does not lend) just the same. Only the REMEDY
  * depends on `canActAsOwner`, and that
  * is in ToolsCard.jsx.
 */
export interface LendingNoticeOfArgs {
    actAsKind: string;
    appId: string;
    lentApps: Set<string> | null;
    lendingEnabled: boolean;
    curated: boolean | null;
    storedActAs: string | null;
}

/**
  * One row of the Tools card.
  *
  * Everything the card draws is here as a FACT, including the three narrowings
  * the card shares with the runtime:
  *   - `sends === null` ⇒ locked to confirm (unknown counts as sending);
  *   - `actAsKind === UNKNOWN` ⇒ no choice of whose name (not "Bee Flow");
  *   - no lending grant ⇒ no owner option (just like normaliseToolsConfig).
  *
  * `lentApps` is the answer of `GET /agents/:id/tool-lending`: for which apps
  * the OWNER of this agent has lent out a connection. It is deliberately no
  * longer a provider list: the server makes that translation, with the same map
  * as `normaliseToolsConfig` (toolPolicy.lentAppsFor), so the card and the
  * runtime cannot disagree. And it is deliberately the OWNER: the editor can be
  * someone else, and their own grants say nothing about what this agent lends.
  *
  * `curated` is `hasCuratedGrants(toolsConfig)`, computed once in `toolRows`
  * because it is a property of the AGENT and not of the row. It belongs here
  * because the runtime hangs the lending gate on it: as long as it is false,
  * `mayLendOwnerConnection` does not look at the map and lends as it
  * always did.
 */
export interface ToolRowArgs {
    appId: string;
    label: string | null;
    toolsConfig: ToolsConfigIn;
    app: ToolApp | null;
    lentApps: Set<string> | null;
    apps?: ToolApp[] | null;
    claimants?: ClaimantsIndex | null;
    lendingEnabled: boolean;
    curated?: boolean | null;
}

/**
  * The rows of the Tools card: every app this agent has ON.
  *
  * The source is `enabledIntegrations` — the app-level on/off list the runtime
  * reads — supplemented with every app that has an entry in `config.tools` but
  * is not in that list. That second group is no side issue: a grant on a
  * switched-off app is a grant that does nothing, and you must not hide it —
  * otherwise you cannot remove it.
  *
  * `enabledIntegrations === null` is the LEGACY meaning "everything available
  * is on"; that is a list we do not have here, so the rows then come from the
  * catalogue (and otherwise from the config alone).
  *
  * `labels` is an id→name map that does NOT come from the catalogue (the
  * frontend's static `INTEGRATION_CATALOG`). The NAME of an app is not a
  * question a server needs to answer, and without this fallback the row falls
  * back to the bare id when a catalogue fails: "google-drive" instead of
  * "Drive", exactly when the user is already missing something.
  *
 * @param {{toolsConfig: object|null, enabledIntegrations: string[]|null,
 *          apps: Array|null, catalogState: string, providersKnown: boolean,
 *          labels: object|Map|null,
 *          lentApps: Set|null, lendingEnabled: boolean}} p
 */
export interface ToolRowsArgs {
    toolsConfig?: ToolsConfigIn;
    labels?: Map<string, string> | Record<string, unknown> | null;
    lentApps?: Set<string> | null;
    enabledIntegrations?: string[] | null;
    apps?: ToolApp[] | null;
    catalogState?: string;
    providersKnown?: boolean;
    lendingEnabled?: boolean;
    runtimeCurated?: boolean | null;
}

/**
  * The rows of the "Automations as a tool" band.
  *
  * The GRANT comes from the config (always readable), the rest from the routine
  * list, which hangs behind the automations module and so is often missing. A
  * grant without an automation stays with `readable: false`: it does something,
  * even if we cannot say WHAT.
  *
  * An automation that has NO (more) `agent_call` trigger is not silently omitted
  * but marked (`callable: false`): the runtime does not offer it, and that is
  * news for whoever chose it.
  *
  * Offering also REQUIRES that the automation is linked to this agent
  * (automation_agent_bindings; the server only offers linked ones). `linkedIds`
  * is that list (Set or array), or null when it could not be read: then we say
  * nothing about it (`linked: null`) instead of "not linked". A grant without a
  * link is `linked: false`, just as silent as `callable: false`.
 */
export interface AutomationRowsArgs {
    toolsConfig?: ToolsConfigIn;
    automations?: AutomationLike[] | null;
    state?: string;
    linkedIds?: string[] | null;
}
