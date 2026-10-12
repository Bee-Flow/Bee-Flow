import { builtInOnly } from './ownData/ownDataModel';
import { presetFor } from '../../../../privacy/PiiSensitivityPicker';

/**
 * Derive the Overview tab's posture rows from the shield state.
 *
 * Deliberately a PURE module: no JSX, no `t()`, no React. Two reasons.
 *
 * 1. The interesting logic here is "which of these settings is a problem",
 *    and that deserves a unit test that asserts on `tone` and structured
 *    `value` rather than on English copy that will churn.
 * 2. It keeps the Overview tab a dumb renderer, so adding a row is a data
 *    change rather than a layout change.
 *
 * Each row carries `tab`, so "Change →" can jump straight to the control
 * instead of the summary duplicating it.
 *
 * ── Why EVIDENCE is an input ──────────────────────────────────────────────
 * Two rows can only be judged against what actually happened. "EU-hosted AI
 * only: Off" is not a finding on its own — plenty of organisations run one
 * model and it is in Frankfurt. It becomes a finding once calls have in fact
 * carried personal data out of Europe. Same for the tool-block lists. So the
 * caller may pass `egress` (from the activity endpoints) and those rows sharpen
 * from "here is a setting" to "here is a setting and here is what it let
 * through". Without it they stay plain rather than nagging.
 */

/** Tones that count towards the "needs attention" badge. */
const ATTENTION_TONES = new Set(['warn', 'error']);

/**
 * Tones that put a row on the Overview's "things to review" list, most urgent
 * first. `note` is a deliberate choice worth a second look (it reveals rather
 * than protects); `suggest` is an optional safeguard that is off. Neither
 * counts as attention, so the strip does not turn amber over an option.
 */
const REVIEW_TONES = ['error', 'warn', 'note', 'suggest'];

/**
 * Which numbered step of the path each row is shown under on the Overview.
 * The step is where a message meets the setting; `tab` is where it is CHANGED,
 * and the two differ on purpose for the tool lists (step 4 "Leaving your org",
 * changed in the step-1 matrix) and the never-hide list (step 1, edited next
 * to the org's own types). The guard row belongs to no step.
 */
export const STEP_OF = {
    categories: 1,
    sensitivity: 1,
    allowlist: 1,
    customterms: 2,
    action: 3,
    transparency: 3,
    automations: 3,
    knowledge: 3,
    toolcalls: 4,
    dlp: 4,
    eu: 4,
    websearch: 4,
};

/** The Overview's review list: rows with a review tone, most urgent first. */
export function reviewItems(posture) {
    const rows = posture?.rows || [];
    return REVIEW_TONES.flatMap(tone => rows.filter(r => r.tone === tone));
}

export function derivePosture(f, { categories = [], env = {}, licence = {}, guard = null, egress = null } = {}) {
    if (!f.enabled) return { off: true, rows: [], attention: 0, review: 0 };

    const total = categories.length;
    // The category lists also carry the org's own type ids (the switches on
    // Your own data). Counted here they would read "23 of 21".
    const detectBuiltIn = builtInOnly(f.piiCategories);
    const preset = presetFor(f.piiConfidenceThreshold);
    const rows = [];

    // Evidence that something actually left Europe in the reporting window.
    // `null` (no licence, no data, endpoint absent) is NOT zero — it means we
    // do not know, and a row must not claim either way.
    const nonEuPii = Number.isFinite(egress?.piiNonEuCount) ? egress.piiNonEuCount : null;
    const leaked = nonEuPii !== null && nonEuPii > 0;
    // All tool calls that carried personal data, wherever they went. Shown
    // beside the setting; only the outside-Europe part decides the tone.
    const toolPii = Number.isFinite(egress?.toolPii) ? egress.toolPii : null;

    rows.push({
        id: 'categories',
        tab: 'detection',
        icon: 'ScanSearch',
        // The misconfiguration this page never surfaced: the shield is ON, so
        // everything looks fine, but with zero categories selected nothing is
        // ever detected and every other control below is decoration.
        tone: detectBuiltIn.length === 0 ? 'warn' : 'ok',
        value: { n: detectBuiltIn.length, total },
    });

    rows.push({
        id: 'sensitivity',
        tab: 'detection',
        icon: 'Gauge',
        tone: 'ok',
        value: preset
            ? { presetId: preset.id }
            : { customPct: Math.round((f.piiConfidenceThreshold ?? 0.7) * 100) },
    });

    const unlicensedTokenize = f.piiAction === 'tokenize' && licence.canTokenizePii === false;
    rows.push({
        id: 'action',
        tab: 'processing',
        icon: f.piiAction === 'tokenize' ? 'Replace' : 'Ban',
        // Stored 'tokenize' on a lapsed licence used to render as "no card
        // selected, no explanation". The server deliberately does not clamp
        // this field, so the stored value really is tokenize — and the runtime
        // blocks instead. Saying so is the whole point of a posture summary.
        tone: unlicensedTokenize ? 'warn' : 'ok',
        value: { action: f.piiAction, unlicensed: unlicensedTokenize },
    });

    const transparencyOn = f.piiAction === 'tokenize' && !!f.showRawPayload;
    rows.push({
        id: 'transparency',
        tab: 'processing',
        icon: 'Eye',
        // Not an error — it is a deliberate choice — but its audience is wider
        // than the wording of the switch suggests, so an active one is worth
        // pointing at. Same treatment as the never-hide list, for the same
        // reason: this is a setting that reveals rather than protects.
        tone: transparencyOn ? 'note' : 'ok',
        value: { on: transparencyOn },
    });

    rows.push({
        id: 'automations',
        tab: 'processing',
        icon: 'Workflow',
        tone: 'ok',
        value: { on: !!f.applyToAutomations },
    });

    rows.push({
        id: 'knowledge',
        tab: 'processing',
        icon: 'BookOpen',
        tone: 'ok',
        // Absent means on, matching the server default.
        value: { on: f.scanKnowledgeBases !== false },
    });

    rows.push({
        id: 'dlp',
        tab: 'outbound',
        icon: 'UserCheck',
        // Optional, so never "attention" — but an outside AI with no last
        // check is worth offering, and the review list is where offers go.
        tone: f.dlpEnabled ? 'ok' : 'suggest',
        value: { on: !!f.dlpEnabled, mode: f.dlpEnabled ? f.dlpMode : null },
    });

    const external = builtInOnly(f.toolPiiPolicy?.external?.blockCategories).length;
    const internal = builtInOnly(f.toolPiiPolicy?.internal?.blockCategories).length;
    rows.push({
        id: 'toolcalls',
        // The categories a tool may carry now live in the detection matrix,
        // beside "do we even look for this" — so Change goes there, not to the
        // outbound pane it used to live on.
        tab: 'detection',
        icon: leaked ? 'AlertTriangle' : 'Wrench',
        tone: leaked ? 'warn' : 'ok',
        value: {
            external,
            internal,
            total,
            // What got out, and how often, so the row can name it instead of
            // leaving the admin to go and count.
            leakedCount: leaked ? nonEuPii : null,
            leakedCategories: leaked ? (egress.piiCategories || []) : [],
            toolPii,
        },
    });

    if (env.hasWebSearchEnabled) {
        rows.push({
            id: 'websearch',
            tab: 'outbound',
            icon: 'Search',
            tone: 'ok',
            value: { on: !!f.webSearchGuard, licensed: licence.canUseWebSearchGuard !== false },
        });
    }

    if (env.hasEuModelsConfigured) {
        rows.push({
            id: 'eu',
            tab: 'outbound',
            icon: !f.euModeEnabled && leaked ? 'AlertTriangle' : 'Globe',
            // Off is only a finding once something has actually gone abroad —
            // see the module note. And even then the row has to say what it
            // does NOT cover: EU-only governs MODELS, so an admin who turns it
            // on to stop a Gmail tool call has fixed nothing.
            tone: !f.euModeEnabled && leaked ? 'warn' : 'ok',
            value: { on: !!f.euModeEnabled },
        });
    }

    // The org's own kinds of data. The row keeps its old id so saved
    // bookmarks and tests that name it still work; it now counts types.
    const types = f.customDataTypes || [];
    rows.push({
        id: 'customterms',
        tab: 'owndata',
        icon: 'Tags',
        tone: 'ok',
        value: {
            n: types.length,
            // A couple of names, so the row says WHICH kinds rather than only
            // how many. Two is what fits on one line at Dutch string lengths.
            sample: types.slice(0, 2).map(type => type?.name || '').filter(Boolean),
        },
    });

    const allowTerms = f.piiAllowTerms || [];
    rows.push({
        id: 'allowlist',
        // Edited on "Your own data", beside the org's own types.
        tab: 'owndata',
        icon: 'Eye',
        // The one control on this page that makes the shield leak BY DESIGN,
        // so an active list is worth pointing at even though it is not wrong.
        tone: allowTerms.length > 0 ? 'note' : 'ok',
        value: {
            terms: allowTerms.length,
            publicOrgs: f.piiAllowPublicOrgs !== false,
        },
    });

    // Prepended, not appended: without a reachable guard every control on this
    // page is decoration, and the org settings screen has never said so.
    if (guard && (guard.configured === false || guard.reachable === false)) {
        rows.unshift({
            id: 'guard',
            // No `tab`: nothing on this page fixes it. The row offers a
            // diagnose action instead of a "Change →" that would land the
            // admin on a pane of controls that cannot help them.
            tab: null,
            icon: 'CircleX',
            tone: 'error',
            value: { configured: guard.configured !== false, reachable: guard.reachable !== false },
        });
    }

    return {
        off: false,
        rows,
        // What turns the strip's Overview read-out amber. Derived here so the
        // badge can never disagree with the rows underneath it.
        attention: rows.filter(r => ATTENTION_TONES.has(r.tone)).length,
        // How many rows the Overview lists under "things to review" — the
        // number the strip shows, so the two always agree.
        review: rows.filter(r => REVIEW_TONES.includes(r.tone)).length,
    };
}

export default derivePosture;
