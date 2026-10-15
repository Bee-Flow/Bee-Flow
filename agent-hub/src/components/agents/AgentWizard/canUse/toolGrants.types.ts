/** Typen van het grants-contract (toolGrants). Alleen types. */

export type ConfirmMode = 'direct' | 'ask';
export type ActAsMode = 'owner' | 'viewer';
/** De gegunde acties van één app: `'*'` (alles) of een lijst. */
export type GrantedActions = string[] | '*';

/** Een actie uit de catalogus: naam en (optioneel) effect. */
export interface CatalogAction {
    name: string;
    label?: string | null;
    effect?: string | null;
}

/** Een app uit de catalogus, zoals de kaart en de kiezer hem zien. */
export interface CatalogApp {
    id: string;
    label?: string | null;
    actions?: CatalogAction[];
    actionsKnown?: boolean;
    requiresGrant?: boolean;
    available?: boolean | null;
    availabilityKind?: string | null;
    availabilityKinds?: unknown[];
    provider?: string | null;
    providersKnown?: boolean;
    grantsVia?: string | null;
}

export interface AutomationShape {
    definition?: { trigger?: { parametersSchema?: unknown } | null } | null;
    trigger?: { parametersSchema?: unknown } | null;
}

export type SelectionValue = Set<string> | string[] | null;

export interface ToolRowsOptions {
    toolsConfig?: unknown;
    enabledIntegrations?: string[] | null;
    apps?: CatalogApp[] | null;
    catalogState?: string;
    providersKnown?: boolean;
    labels?: Map<string, string> | Record<string, unknown> | null;
    lentApps?: Set<string> | null;
    lendingEnabled?: boolean;
    runtimeCurated?: boolean | null;
}

export interface ToolRowParams {
    appId: string;
    label: string | null | undefined;
    toolsConfig: unknown;
    app: CatalogApp | null;
    lentApps: Set<string> | null;
    lendingEnabled: boolean;
    curated?: boolean | null;
    apps?: CatalogApp[] | null;
    claimants?: Map<string, string[]> | null;
}

export interface EffectiveActionsOptions {
    apps?: CatalogApp[] | null;
    claimants?: Map<string, string[]> | null;
}

export interface AutomationRowsOptions {
    toolsConfig: unknown;
    automations: unknown;
    state?: string;
    linkedIds?: Iterable<string> | null;
}
