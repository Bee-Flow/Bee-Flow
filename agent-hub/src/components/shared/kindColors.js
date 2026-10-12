/**
 * kindColors — the ONE place that turns an object KIND in Studio into a
 * colour, an icon and a tile shape (Bee Flow Builder redesign, Sep 2026;
 * Studio Home artboard 1b "Gedeelde patronen").
 *
 * A kind is a thing you MAKE in Studio: automation, table, app, webpage,
 * form, agent, skill, knowledge base, meeting note, solution. Nine of them
 * share one legend (the nine tiles of artboard 1b); the tenth, solution, is
 * a container and deliberately carries no colour of its own. The rail, the
 * "Nieuw" menu, every section header, the "Gebruikt door" rows and the
 * reference pills all read this module, so a kind cannot be blue on the
 * rail and teal in a pill.
 *
 * Modelled on automation/Builder/flow/nodeTypeColors.js, under the same
 * contract:
 *   - A LEAF module. It imports lucide icons and nothing else, so shared/,
 *     the Studio sections, the sidebar and the builder can all read it
 *     without a cycle.
 *   - Emits CSS custom properties only (`var(--kind-kb)`, `var(--type-ai)`),
 *     never a hex — src/index.css owns the values, per theme: the --kind-*
 *     two-set block and the --type-* block above it.
 *   - Four kinds reuse a step family's token ON PURPOSE (artboard 1b:
 *     "Agent — blauw · zelfde als AI-stap"): automation → --type-trigger,
 *     datatable → --type-data, form → --type-pause, agent → --type-ai. A
 *     user who learns "teal = automation" in the builder meets the same
 *     teal on the Studio rail.
 *   - One kind is not a thing you make: COMPLIANCE is an AREA you
 *     administer (checks, registers, evidence — the Compliance Center,
 *     Sep 2026). It is in this register anyway, so that
 *     `StudioSectionHeader kind="compliance"`, the settings-nav tile and the
 *     Compliance Center's own rail read ONE token (--kind-compliance)
 *     instead of each choosing a teal. Same tile recipe, plain 8px radius.
 *     It is deliberately NOT on the Studio map — it lives in organisation
 *     settings — which admin/Studio/map/studioMap.js declares in
 *     KINDS_OFF_MAP so the map's drift test stays honest.
 *   - Lives in components/shared/: not under AppStudio (the noPurple scan
 *     roots) and not under Builder/flow/ (a kind is not a step).
 */
import { BookOpen, Bot, ClipboardList, FileText, Globe, LayoutGrid, Mic, Package, Scale, Table, Workflow, Zap, Clapperboard } from 'lucide-react';

/** The thirteen kinds, in rail order: Bouwen, AI, Bundelen — then the one area you administer. */
export const KIND_KEYS = Object.freeze([
    'automation', 'datatable', 'app', 'webpage', 'document', 'form',
    'agent', 'skill', 'kb', 'meeting',
    'playbook', 'solution',
    'compliance',
]);

const KIND_VAR = Object.freeze({
    automation: 'var(--type-trigger)',
    datatable: 'var(--type-data)',
    app: 'var(--kind-app)',
    webpage: 'var(--kind-web)',
    document: 'var(--kind-doc)',  // a printable artefact — rose (2026-09-15)
    form: 'var(--type-pause)',
    agent: 'var(--type-ai)',
    skill: 'var(--kind-skill)',
    kb: 'var(--kind-kb)',
    meeting: 'var(--kind-meet)',
    playbook: 'var(--kind-playbook)',  // a phased build the AI runs — emerald (2026-09-13)
    solution: 'var(--text-secondary)', // a container, deliberately neutral
    compliance: 'var(--kind-compliance)', // an area you administer — teal, retuned from --type-guard (2026-09-14)
});

/** The glyph of each kind — the exact lucide names artboard 1b draws. */
const KIND_ICON = Object.freeze({
    automation: Workflow,
    datatable: Table,
    app: LayoutGrid,
    webpage: Globe,
    document: FileText,
    form: ClipboardList,
    agent: Bot,
    skill: Zap,
    kb: BookOpen,
    meeting: Mic,
    playbook: Clapperboard,
    solution: Package,
    compliance: Scale,
});

/**
 * The names the rest of the product already uses for these objects — API
 * resource types, sidebar section ids, usage rows, plurals — folded onto
 * the twelve keys, so a caller can hand over whatever it has.
 */
const KIND_ALIASES = Object.freeze({
    automations: 'automation', automation: 'automation', flow: 'automation',
    datatables: 'datatable', table: 'datatable', tables: 'datatable', data_table: 'datatable',
    apps: 'app', application: 'app',
    webpages: 'webpage', web: 'webpage', page: 'webpage', pages: 'webpage', website: 'webpage',
    documents: 'document', doc: 'document', invoice: 'document', quote: 'document', letter: 'document',
    forms: 'form', form_page: 'form',
    agents: 'agent', assistant: 'agent',
    skills: 'skill',
    kbs: 'kb', knowledge: 'kb', knowledge_base: 'kb', knowledge_bases: 'kb', knowledgebase: 'kb',
    meetings: 'meeting', meet: 'meeting', meeting_note: 'meeting', meeting_notes: 'meeting',
    transcription: 'meeting', transcriptions: 'meeting',
    playbooks: 'playbook', recipe: 'playbook',
    solutions: 'solution', bundle: 'solution',
    compliance_hub: 'compliance', gdpr: 'compliance', privacy: 'compliance',
});

/**
 * The kind of an object, or of a bare kind string. Takes the whole object so
 * a usage row (`{ kind }`), an API record (`{ type }`) or a resource
 * reference (`{ objectType }` / `{ resourceType }`) all resolve without the
 * caller unpacking them. Unknown input → null, never a throw.
 */
export function kindOf(objOrKind) {
    if (!objOrKind) return null;
    const raw = typeof objOrKind === 'string'
        ? objOrKind
        : (objOrKind.kind ?? objOrKind.objectType ?? objOrKind.resourceType ?? objOrKind.type ?? null);
    if (typeof raw !== 'string' || !raw) return null;
    const key = raw.trim().toLowerCase();
    if (KIND_KEYS.includes(key)) return key;
    return KIND_ALIASES[key] ?? null;
}

/** `var(--kind-kb)` for a kind; a neutral ink when there is none. */
export function kindColorVar(kind) {
    return KIND_VAR[kind] ?? 'var(--text-tertiary)';
}

/**
 * A tint of the kind colour for fills. Artboard 1b: 16% on the 30px legend
 * tile and the reference pills, 18% on the 28px header tile (a smaller tile
 * needs a touch more fill to read as a tile at all). `color-mix` so it
 * follows the theme's own value at paint time.
 */
export function kindTint(kind, pct = 16) {
    return `color-mix(in srgb, ${kindColorVar(kind)} ${pct}%, transparent)`;
}

/**
 * Corner radius per kind, from the artboard's 30px legend tile: an
 * automation is trigger-shaped (rounded on its leading edge, like a trigger
 * card on the canvas), a form is a circle (like a form page's tile), every
 * other kind is a plain 8px tile.
 */
export function cardRadius(kind) {
    if (kind === 'automation') return '15px 8px 8px 15px';
    if (kind === 'form') return '999px';
    return '8px';
}

/** cardRadius at any tile size: the trigger's leading edge stays a half-circle. */
function tileRadius(kind, size) {
    if (kind === 'automation') {
        const r = Math.round(size / 2);
        return `${r}px 8px 8px ${r}px`;
    }
    return cardRadius(kind);
}

/**
 * The icon tile: 28px in a section header (18% tint, 15px glyph — artboard
 * 1b's header), 30px in the legend, 36/48px on cards and empty states. Shape
 * encodes the kind a second time for anyone who cannot rely on colour.
 * Returns `{ tile, glyph }` inline-style objects. Accepts `size` as a bare
 * number too (`kindTileStyle('kb', 36)`).
 */
export function kindTileStyle(kind, opts = {}) {
    const { size = 30, pct } = typeof opts === 'number' ? { size: opts } : opts;
    const tintPct = pct ?? (size <= 28 ? 18 : 16);
    const glyphPx = size === 28 ? 15 : Math.round(size / 2);
    const tile = {
        width: size, height: size, flexShrink: 0,
        borderRadius: tileRadius(kind, size),
        display: 'grid', placeItems: 'center',
        background: kindTint(kind, tintPct),
        color: kindColorVar(kind),
    };
    const glyph = { width: glyphPx, height: glyphPx, display: 'inline-flex' };
    return { tile, glyph };
}

/** The lucide component for a kind; null for an unknown kind. */
export function kindIcon(kind) {
    return KIND_ICON[kind] ?? null;
}
