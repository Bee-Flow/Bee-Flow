import { CheckCircle2, RotateCcw } from 'lucide-react';
import React from 'react';
import {
    OBJ_STATUS, labelOf, userName, fmtDate, ActionButton as ActionButtonJs, Fact as FactJs,
} from './auditForms';
import { useTranslation } from '@/hooks/useTranslation';
import DeadlineClockJs from '@/components/shared/DeadlineClock';
import SideDrawerJs, { DrawerFooter as DrawerFooterJs } from '@/components/shared/SideDrawer';
import RegisterStatePill from '../../shared/RegisterStatePill';
import type { DrawerMode } from '../../shared/useDrawerMode';
import type { OrgUser } from '../accessAuditLabels';

/**
 * ObjectiveDrawer: one security objective (ISO/IEC 27001 clause 6.2) in the
 * register's SideDrawer: the title, how it is measured and the target, the
 * owner and the review date, and the status steps.
 *
 * The steps used to repeat as two buttons on every row; they live here now,
 * in the footer: an active objective is marked achieved (the primary) or
 * dropped, a closed one can be reactivated. `onStatus` writes the new status.
 */

const SideDrawer = SideDrawerJs;
const DrawerFooter = DrawerFooterJs;
const DeadlineClock = DeadlineClockJs;
const ActionButton = ActionButtonJs;
const Fact = FactJs;

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
    const owner: string | number | null = userName(orgUsers, o.owner_user_id);

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
