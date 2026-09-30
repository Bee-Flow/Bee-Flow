/**
 * The organisation's Privacy Shield, as an editor — the phone's
 * OrgShieldEditor.jsx on its org-settings mount (own org, with the activity
 * tab). One draft across the four policy tabs, saved as one document by the
 * Save bar; the tab strip counts each tab's unsaved edits. The control tabs
 * are off while the shield is off, as on the web.
 */

import React, { useState } from 'react';

import { useTranslation } from '@/core/i18n';
import { OrgLockedScreen, useOrgContext } from '@/features/org';
import { useConfirmLeave } from '@/shared/patterns';
import { Banner, Button, EmptyState, ErrorState, LoadingState, SaveBar, Screen, ScreenHeader, TabBar, type TabBarItem } from '@/shared/ui';

import { ActivityPane } from '../components/ActivityPane';
import { DetectionPane } from '../components/DetectionPane';
import { OutboundPane } from '../components/OutboundPane';
import { OverviewPane } from '../components/OverviewPane';
import { ProcessingPane } from '../components/ProcessingPane';
import { useGuardStatus, useShieldEnv } from '../hooks/queries';
import { useShieldEditor, type ShieldEditor } from '../hooks/useShieldEditor';
import { useShieldLicence } from '../hooks/useShieldLicence';
import { derivePosture } from '../model/posture';
import type { GuardStatus, ShieldDoc, ShieldEnv, ShieldFields } from '../model/types';

type ShieldTab = 'overview' | 'detection' | 'processing' | 'outbound' | 'activity';

const NO_ENV: ShieldEnv = { hasWebSearchEnabled: false, hasEuModelsConfigured: false };

function useTabs(editor: ShieldEditor): TabBarItem<ShieldTab>[] {
    const t = useTranslation();
    const off = !editor.fields?.enabled;
    const dirty = (id: ShieldTab) => editor.dirtyStages.find((s) => s.id === id)?.count ?? null;
    return [
        { id: 'overview', label: t('admin.shield_tab_overview', 'Overview'), icon: 'LayoutGrid', count: dirty('overview') },
        { id: 'detection', label: t('admin.shield_tab_detection', 'What we look for'), icon: 'Gauge', count: dirty('detection'), disabled: off },
        { id: 'processing', label: t('admin.shield_tab_processing', 'What happens'), icon: 'Shield', count: dirty('processing'), disabled: off },
        { id: 'outbound', label: t('admin.shield_tab_outbound', 'Leaving your org'), icon: 'Send', count: dirty('outbound'), disabled: off },
        { id: 'activity', label: t('admin.shield_tab_activity', 'What happened'), icon: 'Activity' },
    ];
}

function Editor({ orgId }: { orgId: string }) {
    const t = useTranslation();
    const editor = useShieldEditor(orgId);
    const guard = useGuardStatus(true);
    const env = useShieldEnv(true).data ?? NO_ENV;
    const tabs = useTabs(editor);
    useConfirmLeave(editor.dirty);
    const [tab, setTab] = useState<ShieldTab>('overview');
    const { doc, fields } = editor;
    const header = <ScreenHeader title={t('settings.privacy_shield', 'Privacy Shield')} subtitle={t('mobile.orgShield.subtitle', 'What the organisation detects, hides and blocks')} />;

    if (doc.isLoading) return <Screen edges={['top']} inset>{header}<LoadingState label={t('admin.shield_loading', 'Loading settings...')} /></Screen>;
    // A failed load must not show defaults with Save live: one tap would write a blank shield.
    if (doc.isError || !doc.data || !fields) {
        return (
            <Screen edges={['top']} inset>
                {header}
                {doc.isError ? <ErrorState error={doc.error} onRetry={() => void doc.refetch()} /> : <EmptyState icon="ShieldOff" title={t('admin.shield_load_failed', 'Could not load these settings')} />}
            </Screen>
        );
    }
    // A tab switched off with the shield falls back to the overview.
    const active: ShieldTab = tabs.find((x) => x.id === tab)?.disabled ? 'overview' : tab;
    const jump = editor.notice?.tabs[0] as ShieldTab | undefined;
    return (
        <Screen edges={['top']} inset>
            {header}
            <TabBar items={tabs} value={active} onChange={setTab} accessibilityLabel={t('admin.shield_tabs_label', 'Privacy Shield sections')} />
            {editor.notice ? (
                <Banner tone="warning" action={jump ? <Button label={t('mobile.orgShield.go_to_tab', 'Show me')} size="sm" variant="ghost" onPress={() => setTab(jump)} /> : undefined}>
                    {editor.notice.text}
                </Banner>
            ) : null}
            <Pane active={active} doc={doc.data} fields={fields} editor={editor} env={env} guard={guard.data ?? null} onGoTo={setTab} />
            {active !== 'activity' ? <SaveBar dirty={editor.dirty} saving={editor.saving} onSave={editor.save} onDiscard={editor.discard} /> : null}
        </Screen>
    );
}

interface PaneProps {
    active: ShieldTab;
    doc: ShieldDoc;
    fields: ShieldFields;
    editor: ShieldEditor;
    env: ShieldEnv;
    guard: GuardStatus | null;
    onGoTo: (tab: ShieldTab) => void;
}

function Pane({ active, doc, fields, editor, env, guard, onGoTo }: PaneProps) {
    const licence = useShieldLicence();
    const set = editor.set;
    switch (active) {
        case 'detection':
            return <DetectionPane fields={fields} set={set} webGuard={licence.webGuard} termErrors={editor.termErrors} />;
        case 'processing':
            return <ProcessingPane fields={fields} set={set} tokenize={licence.tokenize} />;
        case 'outbound':
            return <OutboundPane fields={fields} set={set} env={env} webGuard={licence.webGuard} />;
        case 'activity':
            return <ActivityPane licence={licence.activity} shieldEnabled={fields.enabled} />;
        default: {
            const posture = derivePosture(fields, { env, canTokenize: licence.tokenize.open, canGuardWebSearch: licence.webGuard.open, guard });
            return <OverviewPane doc={doc} fields={fields} guard={guard} posture={posture} set={set} onGoTo={onGoTo} />;
        }
    }
}

/** Someone the PUT would refuse (not an org admin, or no organisation) sees why instead. */
function AdminOnly() {
    const t = useTranslation();
    const denied = {
        icon: 'ShieldOff' as const,
        title: t('mobile.orgShield.admin_only_title', 'Only organisation administrators can change the shield'),
        message: t('mobile.orgShield.admin_only_message', 'Your own privacy settings are under Settings → Privacy, where you can also see what your organisation enforces.'),
    };
    return <OrgLockedScreen title={t('settings.privacy_shield', 'Privacy Shield')} denied={denied} />;
}

export function OrgShieldScreen() {
    const { orgId, isOrgAdmin } = useOrgContext();
    if (!orgId || !isOrgAdmin) return <AdminOnly />;
    return <Editor orgId={orgId} />;
}
