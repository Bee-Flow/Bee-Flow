/**
 * jsKit — typed views of the shared JavaScript building blocks the Compliance
 * Center composes its drawers, tables and forms from.
 *
 * The JavaScript sources infer their prop types from their defaults (a
 * `children = null` default is typed `null`), which rejects the children a
 * compliance page passes. Each export here is the same component with the
 * prop shape its callers use; the cast is the only place that shape is
 * asserted, so a page never has to repeat it.
 */
import type { ComponentType, ReactElement, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import SideDrawerJs, {
    DrawerSection as DrawerSectionJs,
    DrawerFooter as DrawerFooterJs,
    DrawerId as DrawerIdJs,
} from '../../../shared/SideDrawer';
import DataTableJs, {
    TableRow as TableRowJs,
    TableCell as TableCellJs,
    TABLE_FOLDED_ONLY as TABLE_FOLDED_ONLY_JS,
} from '../../../shared/DataTable';
import FindingRowJs from '../../../shared/FindingRow';
import DeadlineClockJs from '../../../shared/DeadlineClock';
import {
    ActionButton as ActionButtonJs,
    Field as FieldJs,
    TextInput as TextInputJs,
    DateInput as DateInputJs,
    UserSelect as UserSelectJs,
    ReadFailed as ReadFailedJs,
    Toggle as ToggleJs,
    Select as SelectJs,
} from '../pages/audits/auditForms';
import { FilterPill as FilterPillJs } from '../../../shared/FilterPills';
import type { OrgUser } from './UserPicker';

export interface SideDrawerProps {
    open?: boolean;
    onClose?: () => void;
    width?: number;
    mode?: string;
    header?: ReactNode;
    footer?: ReactNode;
    ariaLabel?: string | null;
    testId?: string;
    children?: ReactNode;
}

export const SideDrawer = SideDrawerJs as ComponentType<SideDrawerProps>;

export const DrawerSection = DrawerSectionJs as ComponentType<{
    label?: ReactNode;
    hint?: ReactNode;
    className?: string;
    testId?: string;
    children?: ReactNode;
}>;

export const DrawerFooter = DrawerFooterJs as ComponentType<{
    primary?: ReactNode;
    onPrimary?: () => void;
    primaryLabel?: string;
    primaryDisabled?: boolean;
    testId?: string;
    children?: ReactNode;
}>;

export const DrawerId = DrawerIdJs as ComponentType<{
    className?: string;
    testId?: string;
    children?: ReactNode;
}>;

export interface TableColumn {
    id: string;
    width: string;
    foldBelow?: number;
    label: string;
}

export const DataTable = DataTableJs as <T>(props: {
    columns: TableColumn[];
    rows?: T[] | null;
    rowKey?: (row: T, index: number) => unknown;
    renderRow: (row: T, ctx: { columns: TableColumn[]; index: number }) => ReactNode;
    renderCard?: (row: T) => ReactNode;
    isMobile?: boolean;
    loading?: boolean;
    footer?: ReactNode;
    empty?: ReactNode;
    ariaLabel?: string;
    testId?: string;
}) => ReactElement;

export const TableRow = TableRowJs as ComponentType<{
    columns: TableColumn[];
    selected?: boolean;
    accent?: string | null;
    onClick?: () => void;
    className?: string;
    testId?: string;
    children?: ReactNode;
}>;

export const TableCell = TableCellJs as ComponentType<{
    column?: TableColumn | null;
    className?: string;
    align?: string;
    testId?: string;
    children?: ReactNode;
}>;

export const TABLE_FOLDED_ONLY: Readonly<Record<number, string>> = TABLE_FOLDED_ONLY_JS;

export const FindingRow = FindingRowJs as ComponentType<{
    severity?: string;
    size?: string;
    message?: ReactNode;
    testId?: string;
}>;

export const DeadlineClock = DeadlineClockJs as ComponentType<{
    variant?: string;
    dueAt?: string | null;
    startedAt?: string | null;
    doneAt?: string | null;
    doneLabel?: string;
    state?: string | null;
    pct?: number | null;
    urgentBelowMs?: number;
    now?: number;
    unit?: string;
    testId?: string;
}>;

export const ActionButton = ActionButtonJs as ComponentType<{
    icon?: LucideIcon;
    variant?: string;
    size?: string;
    disabled?: boolean;
    onClick?: () => unknown;
    autoFocus?: boolean;
    title?: string;
    className?: string;
    'data-testid'?: string;
    children?: ReactNode;
}>;

export const Field = FieldJs as ComponentType<{
    label?: ReactNode;
    hint?: ReactNode;
    className?: string;
    testId?: string;
    children?: ReactNode;
}>;

export const TextInput = TextInputJs as ComponentType<{
    value?: string | number | null;
    onChange?: (value: string) => void;
    type?: string;
    min?: number;
    placeholder?: string;
    className?: string;
    'data-testid'?: string;
}>;

export const Toggle = ToggleJs as ComponentType<{
    checked?: boolean;
    onChange?: (checked: boolean) => void;
    label?: ReactNode;
    hint?: ReactNode;
    testId?: string;
    disabled?: boolean;
}>;

export const Select = SelectJs as ComponentType<{
    value?: string | null;
    onChange?: (value: string) => void;
    options?: { value: string; label: string }[];
    className?: string;
    'data-testid'?: string;
}>;

export const FilterPill = FilterPillJs as ComponentType<{
    label?: ReactNode;
    active?: boolean;
    checked?: boolean;
    onClick?: () => void;
    testId?: string;
}>;

export const DateInput = DateInputJs as ComponentType<{
    value?: string | null;
    onChange?: (value: string) => void;
    className?: string;
    'data-testid'?: string;
}>;

export const UserSelect = UserSelectJs as ComponentType<{
    value?: string | null;
    orgUsers?: OrgUser[] | null;
    noneLabel?: string;
    onChange?: (value: string) => void;
    className?: string;
    'aria-label'?: string;
    'data-testid'?: string;
}>;

export const ReadFailed = ReadFailedJs as ComponentType<{
    testId?: string;
    children?: ReactNode;
}>;
