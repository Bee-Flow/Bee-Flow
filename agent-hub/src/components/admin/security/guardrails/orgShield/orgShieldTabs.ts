import { Activity, Gauge, LayoutDashboard, Replace, Send, Tags } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/**
 * The sections of the Privacy Shield editor, and the shape of the strip that
 * navigates them.
 *
 * The page used to be fifteen sections in one scroll. Grouping them needed a
 * question per section that an admin actually asks, not a taxonomy:
 *
 *   overview   — how does this organisation stand right now?
 *   detection  — what counts as personal data?
 *   owndata    — what else, that only this organisation has?
 *   processing — what do we do with a message we flagged?
 *   outbound   — what may leave the building?
 *
 * The LABELS are those questions in the user's words rather than ours. An
 * org admin is not a security engineer: "Detection / Processing / Outbound"
 * is our model of the pipeline, and reading it required already knowing the
 * pipeline. The ids stay as they are — they are in URLs and tests.
 *
 * ── Why the strip is a PATH and not a flat tab bar ────────────────────────
 * Four equal tabs said nothing about order, and the single most common
 * misreading of this screen was treating "When we find something" (the
 * always-on gate) and "Leaving your org" (the interactive pre-flight, external
 * providers only) as alternatives. They are consecutive stages of one path: a
 * message is scanned, then handled, then — only if the model is outside the
 * organisation — checked once more. Numbering the stages 1–4 and ending the
 * path at the AI model makes the order visible without being explained.
 *
 * Overview and What happened are NOT stages — they are a summary and a log of
 * the whole thing — so they sit outside the path as standalone pills.
 *
 * Semantically this is still one tablist; the numbers, the chevrons and the
 * path's two ends are decoration and are hidden from assistive tech.
 */
export interface ShieldTab {
    id: string;
    labelKey: string;
    fallback: string;
    Icon: LucideIcon;
}

export const TAB_IDS = ['overview', 'detection', 'owndata', 'processing', 'outbound'];

export const DEFAULT_TAB = 'overview';

export const TABS: ShieldTab[] = [
    { id: 'overview', labelKey: 'admin.shield_tab_overview', fallback: 'Overview', Icon: LayoutDashboard },
    { id: 'detection', labelKey: 'admin.shield_tab_detection', fallback: 'What we look for', Icon: Gauge },
    // The org's own kinds of data sit right after the built-in ones: they
    // are found in the same scan, so they are the same stage of the path.
    { id: 'owndata', labelKey: 'shield_data.tab_label', fallback: 'Your own data', Icon: Tags },
    // The same words the Overview uses for this step, so step 3 has one name
    // everywhere (strip, Overview, the explainer).
    { id: 'processing', labelKey: 'admin.shield_posture_action', fallback: 'When we find something', Icon: Replace },
    { id: 'outbound', labelKey: 'admin.shield_tab_outbound', fallback: 'Leaving your org', Icon: Send },
];

/**
 * The monitoring tab — evidence, where the other four are policy. It is
 * OPT-IN per mount (`showActivityTab` on OrgShieldEditor) because its data
 * endpoints derive the organisation from the SESSION: on the admin
 * GuardrailsHub mount, which can pin a DIFFERENT org, the tab would silently
 * show the wrong organisation's activity. Only the org-settings mount (own
 * org, always) offers it.
 */
export const ACTIVITY_TAB: ShieldTab = { id: 'activity', labelKey: 'admin.shield_tab_activity', fallback: 'What happened', Icon: Activity };

export const ALL_TAB_IDS = [...TAB_IDS, ACTIVITY_TAB.id];

/**
 * The tabs that are stages of the path, in the order a message travels
 * through them. `overview` and `activity` are deliberately absent. A stage's
 * number on the strip is its position here, plus one.
 */
export const PIPELINE_TAB_IDS = ['detection', 'owndata', 'processing', 'outbound'];

/**
 * `processing` and `outbound` render the SAME pane — the two checks side by
 * side, in the order they run, because the whole point is that they are
 * consecutive rather than alternative. Both ids stay live so existing
 * `?tab=` bookmarks keep working and the strip can still say which stage you
 * clicked; the pane emphasises that one.
 *
 * @see tabs/ChecksTab.tsx
 */
export const CHECKS_TAB_IDS = ['processing', 'outbound'];

/** Does this tab id render the combined two-checks pane? */
export function isChecksTab(id: string | null | undefined): boolean {
    return CHECKS_TAB_IDS.includes(id ?? '');
}

/**
 * Never trust the URL. A stale bookmark, a typo, or a link from a future
 * release that renamed a tab must land somewhere sane rather than render an
 * empty pane. `ids` is the mount's own tab set: `?tab=activity` on a mount
 * that does not offer the tab falls back to Overview instead of rendering a
 * wrong-organisation pane.
 */
export function normaliseTab(raw: string | null | undefined, ids: readonly string[] = TAB_IDS): string {
    return raw != null && ids.includes(raw) ? raw : DEFAULT_TAB;
}
