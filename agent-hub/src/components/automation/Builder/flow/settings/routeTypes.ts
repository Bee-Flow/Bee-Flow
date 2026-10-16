import type { RouteRule } from './routeEditorsModel';

/** The Condition node's route as the editor holds it (flow/routeModel.js readRoute). */
export interface RouteConfig {
    mode?: string;
    style?: string;
    source?: string;
    maxItems?: unknown;
    rules?: RouteRule[];
    matchMode?: string;
    keepRest?: boolean;
    defaultBranch?: string;
    matchOn?: string;
}

/** A rule as a suggestion or a handoff hands it over: a name and its expression. */
export interface SuggestedRule { name: string; expr: string }

/** `set('route', …)` on the step's draft. */
export type SetDraft = (key: string, value: unknown) => void;

/** The rules a list change left reading fields the new item lacks (R11). */
export interface UnfitRules { paths: string[]; itemName: string }
