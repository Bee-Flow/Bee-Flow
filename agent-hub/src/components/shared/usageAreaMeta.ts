/**
 * What the UI shows for a usage AREA (server/shared/usageAreas.js, mirrored to
 * shared/usageAreas.generated.mjs): its icon, its name and its chart colour.
 *
 * Shared by the Settings usage pages and the admin AI Monitor, which may not
 * import from pages/, so it lives here.
 *
 * Colour rule (house charts): a series colour is a FIXED slot per area,
 * assigned in AREA order and never cycled. The eight areas that carry the
 * most spend (`series: true`) take the eight `--chart-N` slots in that order;
 * every other area has no slot and is drawn, together with "other", as the
 * neutral "Other" series, so no two areas share a colour and no colour
 * changes with the data.
 */
import type { LucideIcon } from 'lucide-react';
import {
    BookOpen, Bot, ClipboardList, Cog, FileText, FolderKanban, Globe, HelpCircle,
    Image as ImageIcon, LayoutGrid, MessageSquare, Mic, Table, Users, Workflow, Zap,
} from 'lucide-react';
import { chartSeriesVar } from './charts/chartChrome';
import { AREAS, OTHER_AREA, areaOf } from '@/shared/usageAreas.generated.mjs';

/** The neutral ink of "Other" and of every area without a slot. */
export const AREA_NEUTRAL = 'var(--text-tertiary)';

interface AreaEntry { icon: LucideIcon; labelKey: string; label: string; series: boolean }

const AREA_TABLE: Readonly<Record<string, AreaEntry>> = Object.freeze({
    agents: { icon: Bot, labelKey: 'adoption.area_agents', label: 'Agents', series: true },
    chat: { icon: MessageSquare, labelKey: 'adoption.area_chat', label: 'Direct chat', series: true },
    automations: { icon: Workflow, labelKey: 'adoption.area_automations', label: 'Automations', series: true },
    forms: { icon: ClipboardList, labelKey: 'adoption.area_forms', label: 'Forms', series: true },
    apps: { icon: LayoutGrid, labelKey: 'adoption.area_apps', label: 'Apps', series: true },
    cowork: { icon: Users, labelKey: 'adoption.area_cowork', label: 'Cowork', series: true },
    meetings: { icon: Mic, labelKey: 'adoption.area_meetings', label: 'Meeting notes', series: true },
    knowledge: { icon: BookOpen, labelKey: 'adoption.area_knowledge', label: 'Knowledge', series: false },
    documents: { icon: FileText, labelKey: 'adoption.area_documents', label: 'Documents', series: false },
    projects: { icon: FolderKanban, labelKey: 'adoption.area_projects', label: 'Projects', series: true },
    webpages: { icon: Globe, labelKey: 'adoption.area_webpages', label: 'Webpages', series: false },
    skills: { icon: Zap, labelKey: 'adoption.area_skills', label: 'Skills', series: false },
    datatables: { icon: Table, labelKey: 'adoption.area_datatables', label: 'Datatables', series: false },
    media: { icon: ImageIcon, labelKey: 'adoption.area_media', label: 'Media', series: false },
    system: { icon: Cog, labelKey: 'adoption.area_system', label: 'Product features', series: false },
    other: { icon: HelpCircle, labelKey: 'adoption.area_other', label: 'Other', series: false },
});

/** The area ids in report order (the shared vocabulary's AREAS). */
export const AREA_ORDER: readonly string[] = Object.freeze(AREAS.map(a => a.id));

/** The ids that get their own series; the rest fold into "other". */
export const SERIES_AREAS: readonly string[] = Object.freeze(AREA_ORDER.filter(id => AREA_TABLE[id]?.series === true));

type Translate = (key: string, fallback: string) => string;

export interface AreaMeta {
    id: string;
    icon: LucideIcon;
    labelKey: string;
    label: string;
    /** The `--chart-N` slot (0-based), or null: drawn as part of the neutral "Other". */
    seriesIndex: number | null;
    color: string;
}

/** The meta of an area id; an unknown id reads as "other". */
export function areaMeta(areaId: string | null | undefined, t?: Translate): AreaMeta {
    const id = areaId && AREA_TABLE[areaId] ? areaId : OTHER_AREA;
    const e = AREA_TABLE[id];
    const slot = SERIES_AREAS.indexOf(id);
    return {
        id,
        icon: e.icon,
        labelKey: e.labelKey,
        label: t ? t(e.labelKey, e.label) : e.label,
        seriesIndex: slot < 0 ? null : slot,
        color: slot < 0 ? AREA_NEUTRAL : chartSeriesVar(slot),
    };
}

/** The series an area is drawn in: itself when it has a slot, else "other". */
export function seriesAreaOf(areaId: string): string {
    return SERIES_AREAS.includes(areaId) ? areaId : OTHER_AREA;
}

/**
 * Literals older rows still carry that no writer logs any more (the eight keys
 * the dashboards' first label maps knew), read as the area they meant.
 */
const LEGACY_SOURCE_AREA: Readonly<Record<string, string>> = Object.freeze({
    agent: 'agents', chat: 'agents', direct: 'chat', notebook: 'projects', template: 'system', designer: 'apps',
});

export interface SourceDetails { label: string; icon: LucideIcon; color: string; area: string }

/** The one source an area may be named by alone: its own id, or that id without the plural s. */
const isAreaOwnSource = (source: string, area: string) => source === area || `${source}s` === area;

/** The name of a source; see usageSourceDetails. */
function sourceLabel(source: string | null | undefined, area: string, areaLabel: string): string {
    if (!source) return areaLabel;
    if (area === OTHER_AREA) return source;
    return isAreaOwnSource(source, area) ? areaLabel : `${areaLabel} · ${source}`;
}

/**
 * A ledger `source` as the UI names it, with the icon and colour of the area
 * it rolls up to. Lists and filters are keyed by source, so the name is
 * unique per source: the area's name alone for the area's own source
 * (`cowork`, `automation`), else the area's name and the raw source
 * (`Agents · agent_stream`). A source the
 * vocabulary does not know keeps its raw name (under "other"), so nothing is
 * hidden.
 */
export function usageSourceDetails(source: string | null | undefined, t?: Translate): SourceDetails {
    const legacy = typeof source === 'string' ? LEGACY_SOURCE_AREA[source] : undefined;
    const area = legacy ?? areaOf(source);
    const meta = areaMeta(area, t);
    return { label: sourceLabel(source, area, meta.label), icon: meta.icon, color: meta.color, area };
}
