import { createAutomationDraft } from '@/api/queries/automation/createDraft';
import { createFormAutomation, studioLockHint, type StudioCreateCtx, type Translate } from '../studioGates';
import { studioAppForKind } from '../studioNav';

// Derived from studioNav: a section folder never imports the registry (studioRegistry.boundary.test.ts).
type StudioAppDescriptor = NonNullable<ReturnType<typeof studioAppForKind>>;

/**
 * The HANDOVER TABLE of the AI router: from a chosen kind to the door that
 * already belongs to it today (Track H4, v1).
 *
 * ── One answer to "where is this made" ─────────────────────────────────────
 *
 * The section comes from `studioAppForKind(kind)` and the action from the
 * `create.onCreate` of that same register row — the same callback that the
 * "New" menu calls. So no second kind→screen walk here: that already existed
 * twice earlier in this programme (studioMap.REGISTRY_BY_KIND and
 * attentionLink.SEGMENT_BY_KIND), and that is precisely why studioNav.js
 * absorbed it. The AI router opens literally the same door as the menu.
 *
 * ── A locked kind is a sign, not a door ───────────────────────────────────
 *
 * `sections` is the resolveStudioNav output that the caller already holds
 * (gate-passing sections plus the locked ones). If the section is there LOCKED,
 * or not in it at all, then `available: false` and `run` does NOTHING — the
 * same rule as NewMenu and the rail. The server should not return such a kind;
 * this is the second brake, and it has to be there (house rule 12: unknown
 * narrows).
 *
 * ── What does and does NOT travel today: TWO questions, two tables ─────────
 *
 * The schema card makes two promises — "it will be called <name>" and "this is
 * the assignment" — and those do NOT travel together. One flag for both was the
 * mistake of the first round: `automation` carried the name, therefore was
 * `true`, and the screen read that as "the brief arrives" and concealed the
 * brief on precisely the most likely route. So two tables, each with one
 * question:
 *
 *   SEED_SUPPORT[kind]  does the BRIEF (the description) arrive at the builder?
 *   NAME_SUPPORT[kind]  does the NAME of the card arrive at the new thing?
 *
 * SEED_SUPPORT is false for every kind except `automation` and `form` (see the
 * table), and that is not carelessness but the state of play: only the
 * automation builder and the Form page read a prompt from outside today. For the rest, the chain that would carry one runs through
 * six files, none of which are inside H4's fence (useNavigateToPage → AuthedApp
 * → AgentHub → Studio/index → studioApps → the builder itself). A `?seed=` that
 * nobody reads is not seeding, so it is not suggested here. Set the line to true
 * as soon as the receiving side `takeSeed(kind)` really reads — that is the only
 * change needed here.
 */

/**
 * Per kind: does the BRIEF arrive at the builder?
 *
 * `automation` and `form` YES. For the rest NO, and per kind why:
 *
 * automation — YES (2026-11-04): the brief and the name are parked under
 *              `automation` and the router opens `studio/automations/new`. The
 *              designer (components/automation/index.tsx) takes them there and
 *              opens a NEW builder with the brief as its auto-send input and the
 *              name as the draft's title, so the assistant is open and already
 *              working. No row is created first: BuilderShell.canAutoSend fires
 *              only into a builder without an id, and the first send creates the
 *              draft under the parked name.
 * form       — YES: createFormFromRouter creates the form, parks the brief under
 *              `form:<id>` and opens the Questions tab, which immediately offers
 *              it to "Build it with AI".
 * kb         — studio/knowledge/new creates one directly and opens it; there is
 *              no field for a prompt along the way.
 * skill      — the AI draft of a skill belongs to POST /api/skills/ai/draft
 *              (Track S3), not to this router.
 * agent      — studio/agents opens the card grid, not the wizard, and
 *              AgentWizard has no initialPrompt prop.
 * webpage    — the describe bar exists (pages/webpages/BuildBar.jsx) but
 *              WebpagesPage does not pass `onBuild` through.
 * app        — the remix prompt path only works on an EXISTING app.
 * datatable  — 'new' falls into the "not found" branch of DatatablesStudio.
 * solution   — idem: SolutionsStudio opens on activeId 'new'.
 * meeting    — a recording/upload starts from a file, not from text.
 */
const SEED_SUPPORT: Readonly<Record<string, boolean>> = Object.freeze({
    automation: true,
    // The Form page (Forms/form/QuestionsTab.jsx) reads it: the brief is parked UNDER THE ID
    // of the form just created (`form:<automationId>`, see run below), and the Questions tab
    // immediately drafts the questions from it — the "Build it with AI" panel.
    form: true,
    kb: false,
    skill: false,
    agent: false,
    webpage: false,
    app: false,
    datatable: false,
    solution: false,
    meeting: false,
});

/**
 * Per kind: does the NAME of the card arrive at the thing that comes into being?
 *
 * automation — YES: with a brief, the name is parked beside it and becomes the
 *              title of the draft the first send creates (BuilderShell
 *              `seedMetadata`); without one, createAutomationDraft(ctx, { title })
 *              POSTs it along.
 * form       — NO, and this is the sharpest: createFormAutomation today takes only
 *              `ctx` and sets the title itself to "Untitled form". We already pass
 *              `{ title }` (ready for the day studioApps accepts it), but as long
 *              as it is ignored we do not claim that the name arrives — a row IS
 *              created, under a different name than the card just named.
 * skill      — NO, same shape: the create callback hard-POSTs
 *              t('skills_studio.untitled', 'Untitled skill').
 * kb         — NO, same shape: KnowledgeStudio's 'new' route creates one directly
 *              under t('knowledge.untitled', 'New knowledge base').
 * the rest   — NO, but without a row: agent/webpage/app/datatable/solution/
 *              meeting are navigations, nothing comes into being to name.
 *
 * All four NO answers get the same single sentence on the screen (DescribeItPanel:
 * `studio.ai.name_manual`), because the effect for the user is the same: the name
 * the card gave is not in the sidebar.
 */
const NAME_SUPPORT: Readonly<Record<string, boolean>> = Object.freeze({
    automation: true,
    // createFormAutomation neemt de titel aan sinds de Form-pagina bestaat.
    form: true,
    kb: false,
    skill: false,
    agent: false,
    webpage: false,
    app: false,
    datatable: false,
    solution: false,
    meeting: false,
});

/** A `t` that translates nothing, so this module also works without one. */
const plainT: Translate = (key, fallback) => (typeof fallback === 'string' ? fallback : key);

const NOOP_RUN = () => Promise.resolve(null);

/**
 * The SINGULAR name of a kind, from the `create` row of its section —
 * so literally the word the "New" menu uses. No second word list for the same
 * ten things: otherwise an app is called one thing on one screen and another
 * thing on another.
 */
export function kindLabel(kind: string | null | undefined, t: Translate = plainT) {
    const app = studioAppForKind(kind);
    if (!app?.create?.labelKey) return typeof kind === 'string' ? kind : '';
    return t(app.create.labelKey, app.create.labelFallback);
}

const unavailable = (kind: string | null | undefined, section: StudioAppDescriptor | null, locked: string | null, lockHint: string | null, label: string = '') => ({
    kind: kind || null,
    section: section || null,
    label,
    available: false,
    locked: locked || null,
    lockHint: lockHint || null,
    seedable: false,
    carriesName: false,
    run: NOOP_RUN,
});

/**
 * The destination of a kind.
 *
 * @param {string|null} kind
 * @param {{ sections?: any[], t?: Function }} [opts] `sections` = the
 *        resolveStudioNav output; `t` only for the label and the lock hint.
 * @returns {{ kind, section, label, available, locked, lockHint, seedable,
 *             carriesName, run }} `seedable` = the brief arrives,
 *          `carriesName` = the name arrives. Two questions, never one flag.
 */
/** A row of the resolved Studio nav: the section's id, and why it is locked if it is. */
export interface NavRow {
    id?: string;
    locked?: string | null;
}

export function destinationForKind(kind: string|null|undefined, { sections = null, t = plainT }: { sections?: NavRow[] | null; t?: Translate } = {}) {
    const app = studioAppForKind(kind);
    // Unknown kind, or a section without its own "New" entry: there is no door to
    // open, so none gets added either.
    if (!app || !app.create || typeof app.create.onCreate !== 'function') {
        return unavailable(kind, app || null, null, null, kindLabel(kind, t));
    }

    const row = (sections || []).find((s) => s && s.id === app.id) || null;
    // Absent counts as not available, with the same hint that NewMenu's AI line
    // chooses when it does not see the target section: we do not know WHY it is
    // gone (a permission gate hides the row), and then the screen may not make any
    // promise about it.
    if (!row || row.locked) {
        const reason = row?.locked || 'ceiling';
        return unavailable(kind, app, reason, studioLockHint(reason, t), kindLabel(kind, t));
    }

    const label = kindLabel(kind, t);
    const seedable = kind != null && SEED_SUPPORT[kind] === true;
    const carriesName = kind != null && NAME_SUPPORT[kind] === true;

    return {
        kind,
        section: app,
        label,
        available: true,
        locked: null,
        lockHint: null,
        seedable,
        carriesName,
        run: ({ onNavigate, t: runT = t, user = null, name = '', seed = '' }: { onNavigate?: ((target: string) => void) | null; t?: Translate; user?: unknown; name?: string; seed?: string } = {}) => {
            const ctx = { onNavigate, t: runT, user };
            const title = typeof name === 'string' && name.trim() ? name.trim() : '';
            // The brief stays on the handover channel, even if this builder does not (yet)
            // read it: parking is the caller's choice, but whoever calls run() directly
            // may pass it along.
            if (kind === 'form') return createFormFromRouter(ctx, { title, seed });
            if (kind === 'automation') return createAutomationFromRouter(ctx, { title, seed });
            if (seed) parkSeed(kind, seed);
            return app.create?.onCreate(ctx);
        },
    };
}

/**
 * A form from the AI router: created as a form that collects its answers in a
 * table (the recommended choice of the "New form" dialog), and opened on the
 * Questions tab of the Form page — not in the automation builder. The brief is
 * parked AFTER creation, under the id of this form: a brief that stood under the
 * bare 'form' would be picked up by the next Questions tab of WHICHEVER form.
 */
async function createFormFromRouter(ctx: StudioCreateCtx, { title = '', seed = '' } = {}) {
    const id = await createFormAutomation({ ...ctx, onNavigate: null }, { title: title || null, collect: true });
    if (!id) return null;
    if (seed) parkSeed(`form:${id}`, seed);
    if (ctx.onNavigate) ctx.onNavigate(`studio/forms/${id}/questions`);
    return id;
}

/** Where the router sends a described automation; the designer reads the parked brief there. */
export const AUTOMATION_WITH_BRIEF_PATH = 'studio/automations/new';

/**
 * An automation from the AI router, with a brief: no row yet. The brief and the name wait
 * under `automation`, and `studio/automations/new` tells the designer to open a
 * new builder that sends the brief at once (see SEED_SUPPORT).
 */
function createAutomationFromRouter(ctx: StudioCreateCtx, { title, seed }: { title: string; seed: string }) {
    if (seed && ctx.onNavigate) {
        parkSeed('automation', seed, title);
        ctx.onNavigate(AUTOMATION_WITH_BRIEF_PATH);
        return Promise.resolve(null);
    }
    // No brief, or nowhere to open it: the row the "New" menu would create, under the name.
    if (seed) parkSeed('automation', seed, title);
    return createAutomationDraft(ctx, title ? { title } : undefined);
}

// ── The seeding channel ───────────────────────────────────────────────────
//
// One key, one brief, read once. Only the kinds SEED_SUPPORT marks have a
// receiving side, and that must be visible in the behaviour: whoever does not
// read gets nothing, and the brief does not silently linger for a next screen
// that happens to pass by.
//
// sessionStorage and not a module variable, because the builder opens in another
// lazy chunk (and sometimes after a full navigation). Everything in try/catch:
// in private mode, reading AND writing already THROW when window.sessionStorage
// is touched, and an AI router that falls over on that is worse than a brief
// that does not travel along.

const SEED_KEY = 'beeflow.studioAi.seed';

const store = () => {
    try { return window.sessionStorage; } catch { return null; }
};

/** Park the brief (and, optionally, the name it was given) for `kind`. Silently does nothing when that cannot be done. */
export function parkSeed(kind: string | null | undefined, seed: string, name: string = '') {
    const text = typeof seed === 'string' ? seed.trim() : '';
    const key = typeof kind === 'string' ? kind : '';
    const title = typeof name === 'string' ? name.trim() : '';
    try {
        const s = store();
        if (!s) return false;
        if (!key || !text) { s.removeItem(SEED_KEY); return false; }
        s.setItem(SEED_KEY, JSON.stringify(title ? { kind: key, seed: text, name: title } : { kind: key, seed: text }));
        return true;
    } catch {
        return false;
    }
}

/**
 * Fetch the brief for `kind` — and CLEAR it, whether or not it was pasted.
 * A brief that was parked for a different kind does not belong to this screen,
 * and therefore does not linger here either.
 */
export function takeSeed(kind: string) {
    return takeSeedEntry(kind)?.seed ?? null;
}

/** As takeSeed, with the name that was parked beside the brief ('' when none). */
export function takeSeedEntry(kind: string): { seed: string; name: string } | null {
    let raw: string | null = null;
    try {
        const s = store();
        if (!s) return null;
        raw = s.getItem(SEED_KEY);
        s.removeItem(SEED_KEY);
    } catch {
        return null;
    }
    if (!raw) return null;
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { return null; }
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.seed !== 'string' || !parsed.seed) return null;
    if (kind && parsed.kind !== kind) return null;
    return { seed: parsed.seed, name: typeof parsed.name === 'string' ? parsed.name : '' };
}

export { SEED_KEY, SEED_SUPPORT, NAME_SUPPORT };
