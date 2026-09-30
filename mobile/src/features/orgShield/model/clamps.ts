/**
 * "Saved, with notes" — which settings the plan narrowed, said precisely
 * enough to act on. A port of the web's orgShieldClamps.js.
 *
 * One deliberate difference: the server reports the external tool list as
 * `toolPiiPolicy.external` (routes/orgPrivacyShield.js `_applyTierClamps`),
 * while the web's label table only knows `toolPiiPolicy` — so on the web that
 * clamp reads as "1 other settings". Both spellings are labelled here.
 */

import type { TranslateFn } from '@/core/i18n';

type ClampTab = 'processing' | 'outbound' | 'detection';

interface ClampLabel {
    key: string;
    en: string;
    tab: ClampTab;
}

const TOOL_POLICY: ClampLabel = {
    key: 'admin.shield_clamp_tool_policy',
    en: 'the kinds withheld from tools outside your organisation — emptied',
    tab: 'detection',
};

const CLAMP_LABELS: Readonly<Record<string, ClampLabel>> = {
    piiDetectionAction: {
        key: 'admin.shield_clamp_action',
        en: 'Replace with placeholders — messages are stopped instead',
        tab: 'processing',
    },
    webSearchGuardEnabled: {
        key: 'admin.shield_clamp_web_guard',
        en: 'Protect web searches — switched back off',
        tab: 'outbound',
    },
    webSearchGuardPiiCategories: {
        key: 'admin.shield_clamp_web_guard_cats',
        en: 'the kinds withheld from web searches — emptied',
        tab: 'outbound',
    },
    toolPiiPolicy: TOOL_POLICY,
    'toolPiiPolicy.external': TOOL_POLICY,
};

function known(fields: readonly string[]): ClampLabel[] {
    return fields.map((f) => CLAMP_LABELS[f]).filter((x): x is ClampLabel => Boolean(x));
}

/** After a save: the sentence, and which tabs it concerns so the screen can offer a jump. */
export function describeClamps(fields: readonly string[], t: TranslateFn): { text: string; tabs: ClampTab[] } {
    const labels = known(fields);
    const parts = [...new Set(labels.map((e) => t(e.key, e.en)))];
    const unknown = fields.length - labels.length;
    if (unknown > 0) parts.push(t('admin.shield_clamp_other', '{n} other settings', { n: unknown }));
    if (parts.length === 0) {
        return { text: t('admin.shield_clamp_generic', 'Saved. Some settings were adjusted to your plan limits.'), tabs: [] };
    }
    return {
        text: t('admin.shield_clamp_lead', 'Saved, with notes. Your plan does not include: {what}. Every other change did land.', {
            what: parts.join('; '),
        }),
        tabs: [...new Set(labels.map((e) => e.tab))],
    };
}

/** On load: the settings are already clamped in what the GET returned. */
export function describeClampsOnLoad(fields: readonly string[], t: TranslateFn): string {
    const labels = known(fields);
    if (labels.length === 0) {
        return t('admin.shield_clamp_load_generic', 'Some settings are limited by your current plan.');
    }
    return t('admin.shield_clamp_load', 'Your plan does not include: {what}. What you see here is what is in force.', {
        what: [...new Set(labels.map((e) => t(e.key, e.en)))].join('; '),
    });
}
