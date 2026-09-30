/**
 * "What we look for", widen-then-narrow as on the web: how hard to look, which
 * kinds (and what a tool may carry out), extra words of our own, and the
 * exceptions that are never hidden. Each list is one row with its count; the
 * 21 kinds open in a sheet (DetectionSheet) rather than filling the page.
 */

import React, { useState } from 'react';

import { useTranslation } from '@/core/i18n';
import { Group, GroupedScroll, NoteRow, SettingRow, Text } from '@/shared/ui';

import { AllowTermsSheet } from './AllowTermsSheet';
import { CustomTermsSheet } from './CustomTermsSheet';
import { DetectionSheet } from './DetectionSheet';
import { SensitivityGroup } from './SensitivityGroup';
import { ToolPolicySheet } from './ToolPolicySheet';
import type { Lock } from '../hooks/useShieldLicence';
import { withToolCategories } from '../model/fields';
import { PII_CATALOG } from '../model/piiCatalog';
import type { ShieldFields, ShieldSaveResult, ToolClass } from '../model/types';

type Open = ToolClass | 'detect' | 'terms' | 'allow' | null;

export function DetectionPane({
    fields,
    set,
    webGuard,
    termErrors,
}: {
    fields: ShieldFields;
    set: (changes: Partial<ShieldFields>) => void;
    webGuard: Lock;
    termErrors: ShieldSaveResult['termErrors'];
}) {
    const t = useTranslation();
    const [open, setOpen] = useState<Open>(null);
    const total = PII_CATALOG.length;
    const policy = fields.toolPiiPolicy;
    const toolClass = open === 'external' || open === 'internal' ? open : null;
    const count = (n: number) => t('admin.shield_posture_categories_value', '{n} of {total}', { n, total });
    return (
        <GroupedScroll>
            <Group>
                <NoteRow>
                    <Text variant="caption" tone="secondary">
                        {t('admin.shield_pii_master_desc_lead', 'Before a message goes to the AI, Bee Flow reads it and looks for personal details — names, email addresses, phone numbers, home addresses, bank details, ID numbers, health information and more. Anything found is hidden from the AI.')}
                    </Text>
                </NoteRow>
            </Group>
            <SensitivityGroup value={fields.piiConfidenceThreshold} onChange={(v) => set({ piiConfidenceThreshold: v })} />

            <Group>
                <SettingRow label={t('admin.shield_matrix_col_detect', 'Hide from AI')} value={count(fields.piiCategories.length)} onPress={() => setOpen('detect')} testID="open-detect" />
            </Group>

            <Group title={t('admin.shield_posture_toolcalls', 'Held back from tools')}>
                <SettingRow label={t('admin.shield_matrix_col_external', 'Outside tools')} value={webGuard.open ? count(policy.external.blockCategories.length) : (webGuard.hint ?? '')} onPress={() => setOpen('external')} testID="tool-external" />
                <SettingRow label={t('admin.shield_matrix_col_internal', 'Own server')} value={count(policy.internal.blockCategories.length)} onPress={() => setOpen('internal')} testID="tool-internal" />
            </Group>

            <Group title={t('mobile.orgShield.exceptions_title', 'Your own words')}>
                <SettingRow label={t('mobile.orgShield.custom_terms_title', 'Always hide these — your own words and patterns')} value={String(fields.customSensitiveTerms.length)} onPress={() => setOpen('terms')} testID="open-terms" />
                <SettingRow label={t('admin.shield_allow_title', 'Never hide these')} value={String(fields.piiAllowTerms.length)} onPress={() => setOpen('allow')} testID="open-allow" />
            </Group>

            <ToolPolicySheet
                cls={toolClass}
                selected={toolClass ? policy[toolClass].blockCategories : []}
                lockedHint={toolClass === 'external' && !webGuard.open ? (webGuard.hint ?? t('admin.shield_tool_block_locked', 'Holding data back from outside tools is an Enterprise feature.')) : null}
                onChange={(cls, ids) => set({ toolPiiPolicy: withToolCategories(policy, cls, ids) })}
                onClose={() => setOpen(null)}
            />
            <DetectionSheet visible={open === 'detect'} selected={fields.piiCategories} onChange={(ids) => set({ piiCategories: ids })} onClose={() => setOpen(null)} />
            <CustomTermsSheet visible={open === 'terms'} terms={fields.customSensitiveTerms} termErrors={termErrors} onChange={(next) => set({ customSensitiveTerms: next })} onClose={() => setOpen(null)} />
            <AllowTermsSheet
                visible={open === 'allow'}
                terms={fields.piiAllowTerms}
                publicOrgs={fields.piiAllowPublicOrgs}
                onTerms={(next) => set({ piiAllowTerms: next })}
                onPublicOrgs={(on) => set({ piiAllowPublicOrgs: on })}
                onClose={() => setOpen(null)}
            />
        </GroupedScroll>
    );
}

