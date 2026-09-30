/**
 * What the settings cannot say on their own: that no detector is installed or
 * it is not answering (so every category below is decoration), that the plan
 * narrowed what is stored, and that the shield points at rule collections
 * that are gone or empty.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { Banner } from '@/shared/ui';

import { describeClampsOnLoad } from '../model/clamps';
import type { GuardStatus, ShieldDoc } from '../model/types';

export function ShieldBanners({ doc, guard }: { doc: ShieldDoc; guard: GuardStatus | null | undefined }) {
    const t = useTranslation();
    return (
        <>
            {guard && !guard.configured ? (
                <Banner tone="warning">
                    {t('mobile.orgShield.guard_missing', 'No PII detector is installed on this server, so nothing is scanned for personal data — whatever these settings say. Your own words and patterns still work; they need no model.')}
                </Banner>
            ) : guard && !guard.reachable ? (
                <Banner tone="error">
                    {t('mobile.orgShield.guard_unreachable', 'The PII detector is installed but not answering. Until it is back, category detection does not run.')}
                </Banner>
            ) : null}

            {doc.clampedFields.length > 0 ? (
                <Banner tone="warning">{describeClampsOnLoad(doc.clampedFields, t)}</Banner>
            ) : null}

            {doc.stalenessWarnings.length > 0 ? (
                <Banner tone="info">
                    {t('mobile.orgShield.stale_rules', '{n} rule references in this shield point at a collection or rule that is missing or empty. Review them in the web app under Guardrails.', { n: doc.stalenessWarnings.length })}
                </Banner>
            ) : null}
        </>
    );
}
