/**
 * The tool catalog the Tools card and the tool chooser read (useToolCatalog): `GET
 * /agents/tool-catalog` (server/routes/agents/toolCatalog.js). Every field is
 * optional because the client reads them defensively (a degraded answer sets
 * `available` and `provider` to null, an old server omits the newer fields).
 */

/** One action (tool) of an app. */
interface ToolAction {
    name?: string;
    label?: string;
    description?: string;
    /** 'reads' | 'writes' | 'sends'; anything else means "not known". */
    effect?: string;
}

/** One app of the catalog (a registry entry that grants tools). */
export interface ToolApp {
    id: string;
    label?: string;
    /** `null` = the server could not tell. */
    available?: boolean | null;
    actionsKnown?: boolean;
    provider?: string | null;
    /** Set on the row by the Tools card from the catalog answer, not by the server. */
    providersKnown?: boolean;
    actions?: ToolAction[];
    requiresGrant?: boolean;
    availabilityKind?: string | null;
    availabilityKinds?: string[];
    grantsVia?: string | null;
}
