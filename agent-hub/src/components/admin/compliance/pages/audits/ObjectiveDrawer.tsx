import { CheckCircle2, RotateCcw } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import React from 'react';
import type { ComponentType, ReactNode } from 'react';
import {
    OBJ_STATUS, labelOf, userName, fmtDate, ActionButton as ActionButtonJs, Fact as FactJs,
} from './auditForms';
import { useTranslation } from '../../../../../hooks/useTranslation';
import DeadlineClockJs from '../../../../shared/DeadlineClock';
import SideDrawerJs, { DrawerFooter as DrawerFooterJs } from '../../../../shared/SideDrawer';
import RegisterStatePill from '../../shared/RegisterStatePill';
import type { DrawerMode } from '../../shared/useDrawerMode';

/**
 * ObjectiveDrawer: one security objective (ISO/IEC 27001 clause 6.2) in the
 * register's SideDrawer: the title, how it is measured and the target, the
 * owner and the review date, and the status steps.
 *
 * The steps used to repeat as two buttons on every row; they live here now,
 * in the footer: an active objective is marked achieved (the primary) or
 * dropped, a closed one can be reactivated. `onStatus` writes the new status.
 */

// .jsx/.js exports: their `= null` defaults would type the props as null-only.
const SideDrawer = SideDrawerJs as unknown as ComponentType<{
    open?: boolean; onClose?: () => void; mode?: DrawerMode; ariaLabel?: string; testId?: string;
    header?: ReactNode; footer?: ReactNode; children?: ReactNode;
}>;
const DrawerFooter = DrawerFooterJs as unknown as ComponentType<{ primary?: ReactNode; testId?: string; children?: ReactNode }>;
const DeadlineClock = DeadlineClockJs as unknown as ComponentType<{
    dueAt?: string | null; doneAt?: string | null; variant?: 'row' | 'block' | 'inline' | 'rail'; testId?: string;
}>;
const ActionButton = ActionButtonJs as unknown as ComponentType<{
    variant?: string; icon?: LucideIcon; disabled?: boolean; onClick?: () => void; className?: string;
    children?: ReactNode; 'data-testid'?: string;
}>;
const Fact = FactJs as unknown as ComponentType<{ label: ReactNode; testId?: string; children?: ReactNode }>;

export type ObjectiveStatus = 'active' | 'achieved' | 'dropped';

export interface Objective {
    id: string | number;
    title: string;
    measure?: string | null;
    target?: string | null;
    owner_user_id?: string | null;
    review_due_at?: string | null;
    status?: string | null;
    updated_at?: string | null;
}

export interface OrgUser {
    id: string | number;
    displayName?: string | null;
    email?: string | null;
}

export interface ObjectiveDrawerProps {
    objective: Objective;
    orgUsers?: OrgUser[] | null;
    busy?: boolean;
    mode: DrawerMode;
    onClose: () => void;
    onStatus: (status: ObjectiveStatus) => void;
}

export default function ObjectiveDrawer({ objective: o, orgUsers = null, busy = false, mode, onClose, onStatus }: ObjectiveDrawerProps) {
    const { t, resolvedLocale } = useTranslation();
    const active = o.status === 'active';
    const statusLabel: string = labelOf(t, OBJ_STATUS, o.status);
    const owner: string | null = userName(orgUsers, o.owner_user_id);

    const footer = active ? (
        <DrawerFooter testId="objective-footer"
            primary={(
                <ActionButton variant="primary" icon={CheckCircle2} disabled={busy} onClick={() => onStatus('achieved')} data-testid="objective-drawer-achieve">
                    {t('compliance.obj_mark_achieved', 'Mark achieved')}
                </ActionButton>
            )}>
            <ActionButton disabled={busy} onClick={() => onStatus('dropped')} data-testid="objective-drawer-drop">
                {t('compliance.obj_mark_dropped', 'Drop')}
            </ActionButton>
        </DrawerFooter>
    ) : (
        <DrawerFooter testId="objective-footer">
            <ActionButton icon={RotateCcw} disabled={busy} onClick={() => onStatus('active')} data-testid="objective-drawer-reactivate">
                {t('compliance.obj_reactivate', 'Reactivate')}
            </ActionButton>
        </DrawerFooter>
    );

    return (
        <SideDrawer open onClose={onClose} mode={mode} ariaLabel={o.title} testId="objective-drawer"
            header={(
                <div className="flex items-center gap-2 min-w-0">
                    <span className="text-[13px] font-semibold leading-snug text-[var(--text-primary)] [overflow-wrap:anywhere]">{o.title}</span>
                    <RegisterStatePill state={o.status} testId="objective-drawer-state" className="flex-shrink-0">{statusLabel}</RegisterStatePill>
                </div>
            )}
            footer={footer}>
            <div className="flex flex-col gap-2">
                <Fact label={t('compliance.obj_col_measure', 'Measure')} testId="objective-drawer-measure">{o.measure || '—'}</Fact>
                <Fact label={t('compliance.obj_col_target', 'Target')} testId="objective-drawer-target">{o.target || '—'}</Fact>
                <Fact label={t('compliance.obj_col_owner', 'Owner')} testId="objective-drawer-owner">{owner || '—'}</Fact>
                <Fact label={t('compliance.obj_col_review', 'Review due')} testId="objective-drawer-review">
                    {o.review_due_at ? (
                        <span className="inline-flex flex-wrap items-baseline gap-x-1.5">
                            <span className="tabular-nums">{fmtDate(o.review_due_at, resolvedLocale)}</span>
                            <DeadlineClock variant="inline" dueAt={o.review_due_at} doneAt={active ? undefined : (o.updated_at || o.review_due_at)} testId="objective-drawer-clock" />
                        </span>
                    ) : '—'}
                </Fact>
            </div>
        </SideDrawer>
    );
}
