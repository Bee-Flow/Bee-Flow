/**
 * factsShape.mts: the shape of the language-neutral facts of an integration page
 * (facts.mts, factsNextcloud.mts) and the helper that writes a tool group.
 */

/** One plain-language line on a page: the prose for `key` (per language) and the tools behind it. */
export interface ToolGroup { key: string; tools: readonly string[] }

/** Events of one trigger provider; `prefix` narrows them (the Nextcloud and Microsoft providers serve several apps). */
export interface EventRule { provider: string; prefix?: string }

export interface IntegrationFacts {
    /** Key of the toolset map (e.g. `GMAIL_TOOLS`). */
    toolset: string;
    groups: readonly ToolGroup[];
    events?: readonly EventRule[];
    /** Integrations linked first under "Related"; category siblings fill up the rest. */
    related?: readonly string[];
    /** Tools come through the Nextcloud integration (connector or the user's own sign-in). */
    nextcloud?: boolean;
    /** false: no read/write section (a generator has no data of yours to read or change). */
    effects?: false;
}

export const g = (key: string, ...tools: string[]): ToolGroup => ({ key, tools });
