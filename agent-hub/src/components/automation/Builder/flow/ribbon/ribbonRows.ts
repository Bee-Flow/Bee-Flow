import { ClipboardList, FileText, Flag, Layers, ListFilter, Package, Table2 } from 'lucide-react';
import { typeGroupOf } from '../nodeTypeColors';
import type { IconType, ItemSection, PaletteItem } from './ribbonCategories';

/**
 * Which pills a step tab shows (the pure half; flow/ribbon/PillRow.tsx
 * renders and folds them). Every tab is ONE compact row, the way the
 * Nextcloud apps tab shows its apps: a command someone reaches for often is
 * a pill of its own that adds on click, and a family of related commands is
 * ONE pill whose dropdown lists them.
 *
 * The rows are data so they are easy to rearrange. A step the spec does not
 * name still gets a pill at the end of its row, so a new palette step is
 * never lost from the ribbon; a group left with one command (a scope filtered
 * the rest away) becomes that command's own pill.
 */

type Translate = (key: string, fallback?: string, params?: Record<string, unknown>) => string;

/** A command that adds on click. */
export interface ItemPillPlan {
    type: 'item';
    key: string;
    item: PaletteItem;
    /** Its own `data-ribbon-origin` stamp, when the build film departs from it. */
    origin: string | null;
}

/** A group of commands behind one pill. */
export interface MenuPillPlan {
    type: 'menu';
    key: string;
    title: string;
    Icon: IconType;
    /** Node family of the group, for the icon tint. */
    family: string | null;
    items: PaletteItem[];
    /** The group's section stamp, so a card still has an origin when its command is in the dropdown. */
    origin: string | null;
}

export type PillPlan = ItemPillPlan | MenuPillPlan;
/** The pills between two dividers. */
export type SegmentPlan = PillPlan[];

interface MenuSlot {
    menu: string;
    titleKey: string;
    fallback: string;
    Icon: IconType;
    /** Palette item ids, in the order the dropdown lists them. */
    ids: string[];
}

/** A palette item id (its own pill) or a group. */
type Slot = string | MenuSlot;

export type RowTab = 'ai' | 'logic' | 'people' | 'data';

/** The rows, as segments of slots. Item ids are stepPalette's (`route` is the Condition). */
export const TAB_ROWS: Record<RowTab, Slot[][]> = {
    ai: [['ai_step', 'data_extraction']],
    logic: [
        ['route', 'loop'],
        ['code', 'http_request'],
        ['privacy_shield'],
        [
            { menu: 'end', titleKey: 'automations.ribbon.group_end', fallback: 'End the run', Icon: Flag, ids: ['stop_error', 'return_to_app'] },
            'note',
        ],
    ],
    people: [
        ['approval', 'notification', 'wait'],
        [{ menu: 'forms', titleKey: 'automations.ribbon.group_forms', fallback: 'Form pages', Icon: ClipboardList, ids: ['form_page', 'form_ending'] }],
    ],
    data: [
        ['set', 'datetime'],
        [
            { menu: 'tables', titleKey: 'automations.ribbon.data_tables', fallback: 'Tables', Icon: Table2, ids: ['datatable', 'knowledge_write'] },
            { menu: 'documents', titleKey: 'automations.ribbon.data_documents', fallback: 'Documents', Icon: FileText, ids: ['generate_document', 'fill_document', 'slide', 'presentation'] },
            { menu: 'lists', titleKey: 'automations.ribbon.data_lists', fallback: 'Lists', Icon: ListFilter, ids: ['filter_list', 'flatten', 'limit', 'dedupe', 'aggregate', 'summarize'] },
        ],
    ],
};

/** The commands that keep their own stamp: the AI step is where the AI group's cards depart. */
const STAMPED: Record<string, string> = { ai_step: 'section:ai' };

const familyOf = (item: PaletteItem | undefined): string | null => (item ? (typeGroupOf(item.payload.kind) as string | null) : null);

function itemPill(item: PaletteItem): ItemPillPlan {
    return { type: 'item', key: item.id, item, origin: STAMPED[item.id] || null };
}

/** A group with one command left is that command's own pill; an empty one is nothing. */
function menuPill(key: string, title: string, Icon: IconType, items: PaletteItem[], origin: string | null): PillPlan | null {
    if (items.length === 0) return null;
    if (items.length === 1) return itemPill(items[0]);
    return { type: 'menu', key, title, Icon, family: familyOf(items[0]), items, origin };
}

/** The segments of one step tab, from its palette items. */
export function planRow(items: PaletteItem[], tab: RowTab, origin: string | null, t: Translate): SegmentPlan[] {
    const byId = new Map(items.map(it => [it.id, it]));
    const placed = new Set<string>();
    const take = (id: string) => {
        const it = byId.get(id);
        if (it) placed.add(id);
        return it;
    };
    const segments = TAB_ROWS[tab].map(slots => slots.map((slot) => {
        if (typeof slot === 'string') {
            const it = take(slot);
            return it ? itemPill(it) : null;
        }
        const members = slot.ids.map(take).filter((it): it is PaletteItem => !!it);
        return menuPill(slot.menu, t(slot.titleKey, slot.fallback), slot.Icon, members, origin);
    }).filter((p): p is PillPlan => !!p));
    const rest = items.filter(it => !placed.has(it.id)).map(itemPill);
    return [...segments, rest].filter(seg => seg.length > 0);
}

/**
 * My building blocks: creating a flowlet (and, inside one, its output) as
 * pills of their own, the org's flowlets behind one pill, then one pill per
 * category of reusable Steps.
 */
export function planBlocksRow(flowlets: PaletteItem[], blockSections: ItemSection[], t: Translate): SegmentPlan[] {
    const ownKinds = new Set(['create_layer', 'layer_output']);
    const own = flowlets.filter(it => ownKinds.has(it.payload.kind)).map(itemPill);
    const saved = menuPill('flowlets', t('automations.canvas.flowlets', 'Flowlets'), Layers, flowlets.filter(it => !ownKinds.has(it.payload.kind)), null);
    const steps = blockSections
        .map(sec => menuPill(`blocks:${sec.key}`, sec.title, Package, sec.items, null))
        .filter((p): p is PillPlan => !!p);
    return [[...own, ...(saved ? [saved] : [])], steps].filter(seg => seg.length > 0);
}
