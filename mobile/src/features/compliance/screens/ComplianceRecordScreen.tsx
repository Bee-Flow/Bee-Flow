/**
 * One record (`/org/compliance/<type>/<id>`): a register row by its record
 * type (dsr, incidents, risks, ncs, …), or — under a framework section — one
 * check by its key (web: the drawer and the check expansion).
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { EmptyState } from '@/shared/ui';

import { CheckDetail } from '../components/CheckDetail';
import { ComplianceFrame } from '../components/ComplianceFrame';
import { RecordDetail } from '../components/RecordDetail';
import { useComplianceAccess } from '../hooks/useComplianceAccess';
import { recordType } from '../model/registry';
import { frameworkIdOf, sectionById } from '../model/sections';

export function ComplianceRecordScreen({ section, id }: { section: string; id: string }) {
    const t = useTranslation();
    const gate = useComplianceAccess();
    const type = recordType(section) ?? recordType(sectionById(section)?.types?.[0]);
    if (type) return <RecordDetail type={type} id={id} gate={gate} />;
    const framework = sectionById(section);
    if (framework?.view === 'checks') return <CheckDetail framework={frameworkIdOf(framework)} id={id} gate={gate} />;
    return (
        <ComplianceFrame title={t('settings.compliance', 'Compliance')} gate={gate}>
            <EmptyState icon="Scale" title={t('mobile.compliance.no_section', 'This part of the Compliance Center does not exist.')} />
        </ComplianceFrame>
    );
}
