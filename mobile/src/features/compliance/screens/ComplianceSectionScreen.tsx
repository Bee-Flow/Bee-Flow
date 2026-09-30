/**
 * One section of the Compliance Center (`/org/compliance/<section>`, old web
 * ids accepted): a framework's checks, a register (with a tab per record type
 * where the web has header tabs — audits, training), or one of the pages of
 * their own (frameworks, ROPA, access log, portability, settings).
 */

import React, { useState } from 'react';

import { useTranslation } from '@/core/i18n';
import { EmptyState, TabBar } from '@/shared/ui';

import { ComplianceScreen } from './ComplianceScreen';
import { AccessLogView } from '../components/AccessLogView';
import { CheckList } from '../components/CheckList';
import { ComplianceFrame } from '../components/ComplianceFrame';
import { FrameworksView } from '../components/FrameworksView';
import { PortabilityView } from '../components/PortabilityView';
import { RecordList } from '../components/RecordList';
import { RopaView } from '../components/RopaView';
import { SettingsView } from '../components/SettingsView';
import { useComplianceAccess } from '../hooks/useComplianceAccess';
import { labelText } from '../model/fields';
import { typesOfSection } from '../model/registry';
import { frameworkIdOf, sectionById, type ComplianceSection } from '../model/sections';

function Registers({ section }: { section: ComplianceSection }) {
    const t = useTranslation();
    const types = typesOfSection(section);
    const [tab, setTab] = useState(types[0]?.id ?? '');
    const type = types.find((x) => x.id === tab) ?? types[0];
    if (!type) return null;
    return (
        <>
            {types.length > 1 ? (
                <TabBar testID="register-tabs" items={types.map((x) => ({ id: x.id, label: labelText(x.plural, t) }))} value={type.id} onChange={setTab} />
            ) : null}
            <RecordList key={type.id} type={type} />
        </>
    );
}

function SectionBody({ section }: { section: ComplianceSection }) {
    switch (section.view) {
        case 'checks':
            return <CheckList section={section.id} framework={frameworkIdOf(section)} />;
        case 'records':
            return <Registers section={section} />;
        case 'frameworks':
            return <FrameworksView />;
        case 'ropa':
            return <RopaView />;
        case 'access_log':
            return <AccessLogView />;
        case 'portability':
            return <PortabilityView />;
        default:
            return <SettingsView />;
    }
}

export function ComplianceSectionScreen({ section: id }: { section: string }) {
    const t = useTranslation();
    const gate = useComplianceAccess();
    const section = sectionById(id);
    if (section?.view === 'overview') return <ComplianceScreen />;
    return (
        <ComplianceFrame
            title={section ? labelText(section.label, t) : t('settings.compliance', 'Compliance')}
            subtitle={t('settings.compliance', 'Compliance')}
            gate={gate}
        >
            {section ? (
                <SectionBody section={section} />
            ) : (
                <EmptyState icon="Scale" title={t('mobile.compliance.no_section', 'This part of the Compliance Center does not exist.')} />
            )}
        </ComplianceFrame>
    );
}
