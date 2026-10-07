/**
 * The chrome every Compliance screen shares: the header, and the gate. A
 * member without `admin_compliance` is told who this is for; an organisation
 * whose plan lacks the Compliance Center sees it locked with the licence line
 * (never before the entitlements have answered — then it is loading).
 */

import React, { type ReactNode } from 'react';

import { useTranslation } from '@/core/i18n';
import { EmptyState, LoadingState, Screen, ScreenHeader } from '@/shared/ui';

import type { ComplianceGate } from '../hooks/useComplianceAccess';

export interface ComplianceFrameProps {
    title: string;
    subtitle?: string;
    gate: ComplianceGate;
    actions?: ReactNode;
    /** A status row under the header (a framework's score pill and 'Run again'). */
    status?: ReactNode;
    children: ReactNode;
}

function Closed({ gate }: { gate: ComplianceGate }) {
    const t = useTranslation();
    if (gate.access.state === 'pending') return <LoadingState />;
    if (gate.access.state === 'locked') {
        return (
            <EmptyState
                icon="Lock"
                title={t('mobile.compliance.locked_title', 'The Compliance Center is not included in your plan')}
                message={gate.hint}
            />
        );
    }
    return (
        <EmptyState
            icon="Lock"
            title={t('mobile.compliance.denied_title', 'For compliance officers')}
            message={t(
                'mobile.compliance.denied_message',
                'Only an organisation administrator, or someone given the compliance permission, can open the Compliance Center.',
            )}
        />
    );
}

export function ComplianceFrame({ title, subtitle, gate, actions, status, children }: ComplianceFrameProps) {
    return (
        <Screen edges={['top', 'bottom']} inset>
            <ScreenHeader title={title} subtitle={subtitle} actions={gate.open ? actions : undefined} />
            {gate.open && status ? status : null}
            {gate.open ? children : <Closed gate={gate} />}
        </Screen>
    );
}
