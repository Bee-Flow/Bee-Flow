/**
 * Posture rows → words, with the web's keys (OverviewTab.jsx `describe`,
 * `hintFor` and LABEL_KEYS). `t` comes in as a parameter so this stays pure
 * and the derivation in posture.ts stays free of copy.
 */

import type { TranslateFn } from '@/core/i18n';

import type { PostureId, PostureRow } from './posture';

type V = Record<string, unknown>;
type Describe = (v: V, t: TranslateFn) => string;

const n = (x: unknown): number => (typeof x === 'number' ? x : 0);
const onOff: Describe = (v, t) => (v.on ? t('common.on', 'On') : t('common.off', 'Off'));

function sensitivity(v: V, t: TranslateFn): string {
    if (v.presetId === 'strict') return t('privacy.sensitivity_strict', 'Low sensitivity');
    if (v.presetId === 'balanced') return t('privacy.sensitivity_balanced', 'Balanced');
    if (v.presetId === 'high') return t('privacy.sensitivity_high', 'High sensitivity');
    return t('admin.shield_posture_custom_pct', 'Custom ({pct}%)', { pct: n(v.customPct) });
}

function dlp(v: V, t: TranslateFn): string {
    if (!v.on) return t('common.off', 'Off');
    if (v.mode === 'block') return t('admin.shield_posture_dlp_block', 'On — do not send');
    if (v.mode === 'auto_redact') return t('admin.shield_posture_dlp_redact', 'On — hide automatically');
    return t('admin.shield_posture_dlp_ask', 'On — ask the person');
}

function allowlist(v: V, t: TranslateFn): string {
    if (n(v.terms) === 0) {
        return v.publicOrgs
            ? t('admin.shield_posture_allow_public_only', 'Well-known companies only')
            : t('common.none', 'None');
    }
    return v.publicOrgs
        ? t('admin.shield_posture_allow_value_public', 'Well-known companies + {n} of your own', { n: n(v.terms) })
        : t('admin.shield_posture_allow_value', '{n} of your own', { n: n(v.terms) });
}

const VALUE: Record<PostureId, Describe> = {
    guard: (v, t) =>
        v.configured === false
            ? t('admin.shield_posture_guard_missing', 'not installed')
            : t('admin.shield_posture_guard_unreachable', 'not responding'),
    categories: (v, t) => t('admin.shield_posture_categories_value', '{n} of {total}', { n: n(v.n), total: n(v.total) }),
    sensitivity,
    action: (v, t) =>
        v.action === 'tokenize'
            ? t('dlp.action_tokenize_label', 'Replace with placeholders')
            : t('dlp.action_block_label', 'Do not send the message'),
    transparency: onOff,
    routines: onOff,
    eu: onOff,
    websearch: onOff,
    dlp,
    toolcalls: (v, t) =>
        t('admin.shield_posture_toolcalls_value', 'outside tools {external}/{total}', {
            external: n(v.external),
            total: n(v.total),
        }),
    customterms: (v, t) =>
        n(v.n) === 0 ? t('common.none', 'None') : t('admin.shield_posture_allow_value', '{n} of your own', { n: n(v.n) }),
    allowlist,
};

export function postureLabel(id: PostureId, t: TranslateFn): string {
    switch (id) {
        case 'guard': return t('admin.shield_posture_guard', 'Detection service');
        case 'categories': return t('admin.shield_posture_categories', 'Kinds of data we look for');
        case 'sensitivity': return t('admin.shield_posture_sensitivity', 'How strict');
        case 'action': return t('admin.shield_posture_action', 'When we find something');
        case 'transparency': return t('admin.shield_posture_transparency', 'Show what was sent');
        case 'routines': return t('admin.shield_posture_routines', 'Also covers routines');
        case 'dlp': return t('admin.shield_posture_dlp', 'One last check before an outside AI');
        case 'toolcalls': return t('admin.shield_posture_toolcalls', 'Held back from tools');
        case 'websearch': return t('admin.shield_posture_websearch', 'Web search protection');
        case 'eu': return t('admin.shield_posture_eu', 'EU-hosted AI only');
        case 'customterms': return t('mobile.orgShield.posture_customterms', 'Always hidden');
        default: return t('admin.shield_posture_allowlist', 'Never hidden');
    }
}

export function postureValue(row: PostureRow, t: TranslateFn): string {
    return VALUE[row.id](row.value, t);
}

/** The extra sentence a row only earns when something is worth saying. */
export function postureHint(row: PostureRow, t: TranslateFn): string | null {
    const flagged = row.tone !== 'ok';
    switch (row.id) {
        case 'guard':
            return t('admin.shield_posture_guard_hint', 'This service does the actual scanning. Until it is running, nothing on this page has any effect — your own words and patterns still work, they need no model.');
        case 'categories':
            return flagged ? t('admin.shield_posture_categories_hint', 'Protection is on, but nothing is ticked — so nothing will ever be found.') : null;
        case 'action':
            return flagged ? t('admin.shield_posture_action_hint', 'Your plan does not include placeholders, so these messages are stopped instead.') : null;
        case 'transparency':
            return flagged ? t('admin.shield_posture_transparency_hint', 'Anyone who can open the conversation can reveal the real values.') : null;
        case 'eu':
            return flagged ? t('admin.shield_posture_eu_hint', 'A chat may go to an AI model outside Europe. This is NOT about connected apps such as Gmail — you govern those with the tool columns.') : null;
        case 'allowlist':
            return flagged ? t('admin.shield_posture_allow_hint', 'These are deliberately left visible to the AI, in every category.') : null;
        default:
            return null;
    }
}
