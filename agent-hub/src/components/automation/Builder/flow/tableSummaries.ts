import { opHelp } from './settings/tableEditor/opHelp';
import { isBlankBinding, isOpKind, type Binding } from './settings/tableEditor/tableOpModel';
import type { SummaryText, TFn } from './nodes/nodeProps';

interface StepLike {
    [key: string]: unknown;
    source?: Binding | null;
    sheets?: unknown;
    ops?: { op?: unknown }[];
}

const MAX_NAMED = 2;

/** The line under a Read table card: which sheets it opens, or that it still needs a file. */
export function readTableSummary(step: StepLike, t: TFn): SummaryText {
    if (isBlankBinding(step.source)) return { muted: t('automation_tables.card.pick_file', 'Pick a file') };
    if (Array.isArray(step.sheets)) {
        return step.sheets.length === 1
            ? t('automation_tables.card.one_sheet', 'Sheet {name}', { name: String(step.sheets[0]) })
            : t('automation_tables.card.some_sheets', '{count} chosen sheets', { count: step.sheets.length });
    }
    return step.sheets === 'first'
        ? t('automation_tables.card.first_sheet', 'First sheet')
        : t('automation_tables.card.all_sheets', 'All sheets');
}

/** The line under an Edit table card: how many steps it has and the first two by name. */
export function tableSummary(step: StepLike, t: TFn): SummaryText {
    if (isBlankBinding(step.source)) return { muted: t('automation_tables.card.pick_table', 'Pick a table') };
    const ops = (Array.isArray(step.ops) ? step.ops : []).filter(o => isOpKind(o?.op));
    if (ops.length === 0) return { muted: t('automation_tables.card.no_steps', 'No steps yet') };
    const titles = opHelp(t).ops;
    const named = ops.slice(0, MAX_NAMED).map(o => titles[o.op as keyof typeof titles].title).join(' · ');
    return t('automation_tables.card.steps', '{count} steps: {named}{more}', { count: ops.length, named, more: ops.length > MAX_NAMED ? ' …' : '' });
}
