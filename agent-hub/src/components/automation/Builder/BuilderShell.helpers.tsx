import { Suspense } from 'react';
import AppRefBreadcrumb from './AppRefBreadcrumb';
import UsedByButtonsCapsule from './UsedByButtonsCapsule';
import { lazyWithI18n } from '@/utils/lazyWithReload';
import ManagedPartBanner from '../../shared/ManagedPartBanner';
import { type BreadcrumbSlotArgs, type HistorySlotArgs } from './BuilderShell.types';

export function breadcrumbSlot({ appRef, isStep, persistedAutomationId, readOnly, managedPart, managedNotDeployed }: BreadcrumbSlotArgs) {
    if (!(appRef || (!isStep && persistedAutomationId) || readOnly)) return null;
    return (
        <>
            {readOnly ? <ManagedPartBanner managed={managedPart} notDeployed={managedNotDeployed} /> : null}
            {appRef ? <AppRefBreadcrumb appRef={appRef} /> : null}
            {!isStep && persistedAutomationId
                ? <UsedByButtonsCapsule automationId={persistedAutomationId} />
                : null}
        </>
    );
}

// The runs tab (compare, goldens, table and file chips) is big and only opens on demand: keep it out of the entry chunks.
const RunsTab = lazyWithI18n(() => import('./runs/RunsTab'));

// The Step execution list pulls in the whole run viewer: load it only when a Step's history opens.
const ExecutionsPanel = lazyWithI18n(() => import('../../admin/Studio/Executions/ExecutionsPanel'));

export function historySlot({ automationId, isStep, active, initialRunId, initialRunStepId, onRunStateChange, onOpenEditor }: HistorySlotArgs) {
    if (!automationId) return null;
    if (!isStep) {
        return (
            <Suspense fallback={null}>
                <RunsTab
                    automationId={automationId}
                    active={active}
                    initialRunId={initialRunId}
                    initialStepId={initialRunStepId}
                    onRunStateChange={onRunStateChange}
                    onOpenEditor={onOpenEditor}
                />
            </Suspense>
        );
    }
    return (
        <Suspense fallback={null}>
            <ExecutionsPanel
                scope="step"
                stepId={automationId}
                active={active}
                initialRunId={initialRunId}
                initialStepId={initialRunStepId}
                onRunStateChange={onRunStateChange}
                onOpenEditor={() => onOpenEditor()}
            />
        </Suspense>
    );
}
