/**
 * Skills — reusable instruction packs.
 *
 * Written from the row mapper rather than from the route handlers:
 * server/stores/skillStore.js `mapRow` is the only place that decides a NULL
 * column becomes '' instead of null, and both GET routes hand back exactly
 * what it produces. So every string here is always present and possibly empty,
 * and `icon` is never empty at all — mapRow defaults it to a lightning bolt.
 */

export interface Skill {
    id: string;
    /** null for a personal skill — the org-less bucket owned by one user. */
    orgId: string | null;
    userId: string;
    name: string;
    description: string;
    /** The pack itself. */
    instructions: string;
    workflow: string;
    rules: string;
    examples: string;
    /** An emoji, defaulted server-side. */
    icon: string;
    /** Visible to the whole org, or to `sharedGroups` when that is non-empty. */
    isShared: boolean;
    /**
     * Load the pack only when the model judges it relevant, instead of putting
     * it in every system prompt (server/core/tools/skillInjection.js). A skill
     * with an `automationId` is treated as dynamic whatever this flag says,
     * which is why the UI reads the two together.
     */
    dynamicActivation: boolean;
    sharedGroups: string[];
    automationId: string | null;
    enabledIntegrations: string[];
    /**
     * May THIS viewer edit the skill? Computed server-side and attached per row
     * by routes/skills.js (GET / and GET /:id; POST hands back `true`), from the
     * same rule the mutating endpoints enforce: owner, OR `manage_skills` in the
     * skill's OWN org (server/stores/skillStore.js canEditSkill).
     *
     * Optional because a server older than Track S1 does not send it. Read it
     * fail-closed — `=== true`, never `!== false` — so an unknown verdict
     * narrows to read-only instead of offering an edit that 403s. The local
     * rule this replaced was strictly narrower (owner only), so nobody loses
     * an edit they had; managers gain the one the server already grants them.
     */
    canEdit?: boolean;
    /**
     * The structured half of the pack (S1), each the parsed form of the text
     * field above it: `steps` ↔ `workflow`, `rulesV2` ↔ `rules`, `examplesV2` ↔
     * `examples`. Shapes deliberately left opaque — this app renders the text
     * and never the structure; it only needs to know whether a facet HAS one.
     *
     * mapRow presents a NULL column as `[]` (server/stores/skillStore.js:847),
     * so an empty array means "not parsed yet" as well as "empty" — see
     * draftFromSkill on why that distinction is safety-critical here.
     */
    steps?: unknown[];
    rulesV2?: unknown[];
    examplesV2?: unknown[];
    createdAt: string | null;
    updatedAt: string | null;
}

/**
 * The writable half — the fields POST /api/skills and PUT /api/skills/:id
 * accept from this client. The routes also take `sharedGroups`,
 * `automationId` and `enabledIntegrations`; the phone deliberately does not
 * send them, because each needs a picker over data this app has no other
 * screen for (org groups, automations, integration ids) and PUT treats an
 * omitted field as "leave as-is". Editing a skill here therefore never
 * silently clears what someone configured on the web.
 */
export interface SkillDraft {
    name: string;
    description: string;
    instructions: string;
    /**
     * The three text facets are OPTIONAL, and an omitted one means "leave the
     * stored facet exactly as it is" — PUT treats a missing field as as-is.
     * draftFromSkill leaves out every facet the server already holds in
     * structured form; see the note there.
     */
    workflow?: string;
    rules?: string;
    examples?: string;
    icon: string;
    isShared: boolean;
    dynamicActivation: boolean;
}

/** routes/skills.js rejects anything longer, on both POST and PUT. */
export const SKILL_INSTRUCTIONS_MAX = 4000;

/**
 * How many skills may be active for one turn.
 *
 * Mirrors SKILL_CAP in agent-hub SkillsPopover.jsx. It is a product rule, not
 * a server one: every active pack is prepended to the system prompt, and past
 * a handful they start competing with each other and with the conversation.
 */
export const ACTIVE_SKILL_CAP = 5;

export function emptyDraft(): SkillDraft {
    return {
        name: '',
        description: '',
        instructions: '',
        workflow: '',
        rules: '',
        examples: '',
        icon: '',
        isShared: false,
        dynamicActivation: false,
    };
}

/**
 * Seed an edit form from a skill — WITHOUT the facets the Studio owns.
 *
 * A facet whose structured list is non-empty is left out of the draft, so the
 * PUT never carries its text. The reason is server-side and total:
 * server/core/skills/skillStructure.js resolveBodyWrite (:456-482) re-parses
 * every text field a request sends, and parseWorkflowToSteps (:131-138) mints
 * fresh step ids and returns `refs: []`. Sending back text this app never
 * edited would therefore silently wipe the refs and ids the Studio laid down —
 * a rename on the phone would flatten the structure behind it.
 *
 * The test is `length > 0`, per facet, and it may never become "is the list
 * present": mapRow turns a NULL column into `[]`
 * (server/stores/skillStore.js:847), so `[]` means "not parsed yet" as well as
 * "empty". Treating `[]` as structure would make every not-yet-migrated skill
 * uneditable from the phone — its text would be permanently unsendable.
 */
export function draftFromSkill(skill: Skill): SkillDraft {
    const draft: SkillDraft = {
        name: skill.name,
        description: skill.description,
        instructions: skill.instructions,
        icon: skill.icon,
        isShared: skill.isShared,
        dynamicActivation: skill.dynamicActivation,
    };
    if (!(skill.steps && skill.steps.length > 0)) draft.workflow = skill.workflow;
    if (!(skill.rulesV2 && skill.rulesV2.length > 0)) draft.rules = skill.rules;
    if (!(skill.examplesV2 && skill.examplesV2.length > 0)) draft.examples = skill.examples;
    return draft;
}
