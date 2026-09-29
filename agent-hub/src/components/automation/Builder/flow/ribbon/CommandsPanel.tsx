import { Layers } from 'lucide-react';
import { stepDragProps } from '../stepDrag';
import { CmdButton } from './jsComponents';
import useTranslation from '../../../../../hooks/useTranslation';
import { DRAG_HINT, DRAG_HINT_KEY } from './AppCommands';
import type { OpenState } from './AppCommands';
import PillRow from './PillRow';
import type { RowPill } from './PillRow';
import { DropdownPill } from './MenuPanel';
import { FamilyIcon, itemRow } from './menuRows';
import { FAMILY_TEXT } from './ribbonCategories';
import type { PaletteItem, StepPayload } from './ribbonCategories';
import type { MenuPillPlan, SegmentPlan } from './ribbonRows';

type AddFn = (payload: StepPayload) => void;

/**
 * A palette step as a pill: its icon in its family's colour, its name, and a
 * screen tip saying what it does. Adds on click (or Enter) and drags onto the
 * canvas. A step this graph cannot accept stays visible, greyed, with the
 * reason as its tip, and is not draggable (BFSF-348).
 */
export function ItemPill({ item, onAdd, origin = null }: { item: PaletteItem; onAdd: AddFn; origin?: string | null }) {
    const { t } = useTranslation();
    return (
        <CmdButton
            glyph={<FamilyIcon Icon={item.icon || Layers} kind={item.payload.kind} />}
            label={item.label}
            desc={item.disabled ? item.disabledReason : item.desc}
            tipFooter={item.disabled ? null : t(DRAG_HINT_KEY, DRAG_HINT)}
            onClick={() => onAdd(item.payload)}
            disabled={!!item.disabled}
            grabbable={!item.disabled}
            {...(origin ? { 'data-ribbon-origin': origin } : null)}
            {...(item.disabled ? null : stepDragProps(item.payload))}
        />
    );
}

/** A group of steps behind one pill; its dropdown lists them. */
function MenuPill({ plan, onAdd, openKey, setOpenKey }: OpenState & { plan: MenuPillPlan; onAdd: AddFn }) {
    const { t } = useTranslation();
    const Icon = plan.Icon;
    return (
        <DropdownPill
            id={`menu:${plan.key}`}
            label={plan.title}
            glyph={<Icon size={14} className={(plan.family && FAMILY_TEXT[plan.family]) || 'text-[var(--text-secondary)]'} />}
            desc={`${plan.items.map(it => it.label).join(', ')}.`}
            tipFooter={t('routines.ribbon.n_steps_pick', '{n} steps. Pick one.', { n: plan.items.length })}
            origin={plan.origin}
            title={plan.title}
            sections={[{ key: plan.key, title: plan.title, rows: plan.items.map(itemRow) }]}
            filterLabel={(n) => t('routines.ribbon.filter_steps', 'Filter {n} steps…', { n })}
            onAdd={onAdd}
            openKey={openKey}
            setOpenKey={setOpenKey}
        />
    );
}

/**
 * The planned pills as rendered row pills. A folded step sits in "More"
 * under `foldTitle` (the tab's name), a folded group under its own.
 */
export function planPills(segments: SegmentPlan[], foldTitle: string, onAdd: AddFn, open: OpenState): RowPill[][] {
    return segments.map(seg => seg.map((plan): RowPill => (plan.type === 'item'
        ? {
            key: plan.key,
            node: <ItemPill item={plan.item} onAdd={onAdd} origin={plan.origin} />,
            fold: { key: `tab:${foldTitle}`, title: foldTitle, rows: [itemRow(plan.item)] },
            origins: plan.origin ? [plan.origin] : [],
        }
        : {
            key: plan.key,
            node: <MenuPill plan={plan} onAdd={onAdd} {...open} />,
            fold: { key: plan.key, title: plan.title, rows: plan.items.map(itemRow) },
            origins: plan.origin ? [plan.origin] : [],
        })));
}

interface Props extends OpenState {
    segments: SegmentPlan[];
    /** The tab's name: the heading of its folded steps in "More". */
    title: string;
    testId: string;
    enabled: boolean;
    empty?: string | null;
    onAdd: AddFn;
}

/** A step tab (Logic, People, Data & documents, My building blocks) as one row of pills. */
export default function CommandsPanel({ segments, title, testId, enabled, empty = null, onAdd, openKey, setOpenKey }: Props) {
    const open = { openKey, setOpenKey };
    return (
        <PillRow
            segments={planPills(segments, title, onAdd, open)}
            testId={testId}
            enabled={enabled}
            empty={empty}
            onAdd={onAdd}
            {...open}
        />
    );
}
