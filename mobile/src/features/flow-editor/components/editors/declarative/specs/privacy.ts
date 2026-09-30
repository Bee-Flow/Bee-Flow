/**
 * The Privacy Shield — the web's PrivacyShieldFields (settings/
 * privacyEditors.jsx): ONE editor over the three runtime types `guard`,
 * `tokenize` and `untokenize`, whose mode decides the type (bindings
 * privacyModel `writePrivacy`, so a mode switch changes `type` and the node
 * editor heals the edges in the same save). The mode words are the web's
 * PRIVACY_MODES (privacyModel.js), the categories its piiCategories.ts, each
 * under the web's own `pii.*` key; specs.lockstep.test.ts holds both lists
 * to the web.
 */

import {
    modeBranches,
    modeHides,
    modeScans,
    readPrivacyMode,
    type FlowEdge,
    type FlowNode,
    type PrivacyModel,
} from '@/features/flow-editor/bindings';
import type { FormDraft } from '@/features/flow-editor/formState';

import { msg, type EditorSpec, type Msg, type OptionSpec } from '../spec';
import { TITLES } from './common';

export const PRIVACY_MODE_WORDS: readonly OptionSpec[] = [
    {
        value: 'check',
        label: msg('mobile.flow.privacy.check', 'Check for personal data'),
        blurb: msg('mobile.flow.privacy.check_blurb', 'Scan a value and send the run down one path or the other.'),
    },
    {
        value: 'check_hide',
        label: msg('mobile.flow.privacy.check_hide', 'Check and hide'),
        blurb: msg('mobile.flow.privacy.check_hide_blurb', 'Scan, branch on the answer, and replace what was found with placeholders.'),
    },
    {
        value: 'hide',
        label: msg('mobile.flow.privacy.hide', 'Hide personal data'),
        blurb: msg('mobile.flow.privacy.hide_blurb', 'Replace personal data with placeholders. The real values come back later.'),
    },
    {
        value: 'reveal',
        label: msg('mobile.flow.privacy.reveal', 'Show real values again'),
        blurb: msg('mobile.flow.privacy.reveal_blurb', 'Put the real values back where a step still holds placeholders.'),
    },
];

/** The web's PII_CATEGORIES: id → its `pii.*` label key, in the web's order. */
export const PII_CATEGORY_KEYS: readonly (readonly [id: string, key: string, english: string])[] = [
    ['Person', 'pii.person_name', 'Person Names'],
    ['DateOfBirth', 'pii.date_of_birth', 'Date of Birth'],
    ['PhoneNumber', 'pii.phone_number', 'Phone Numbers'],
    ['Email', 'pii.email_address', 'Email Addresses'],
    ['Address', 'pii.physical_address', 'Home and street addresses'],
    ['CreditCardNumber', 'pii.credit_card', 'Credit Card Numbers'],
    ['BankAccountNumber', 'pii.bank_account', 'Bank Account Numbers'],
    ['InternationalBankingAccountNumber', 'pii.iban', 'IBAN Numbers'],
    ['USSocialSecurityNumber', 'pii.ssn', 'Social Security Numbers'],
    ['PassportNumber', 'pii.passport', 'Passport Numbers'],
    ['DriversLicenseNumber', 'pii.drivers_license', "Driver's License Numbers"],
    ['IPAddress', 'pii.ip_address', 'IP Addresses'],
    ['URL', 'pii.url', 'Web addresses'],
    ['ApiKeyOrSecret', 'pii.api_key_or_secret', 'Passwords and access keys'],
    ['Organization', 'pii.organization', 'Company names'],
    ['NationalIdentificationNumber', 'pii.national_id', 'National ID numbers (BSN and equivalents)'],
    ['TaxIdentificationNumber', 'pii.tax_id', 'Tax numbers (VAT / BTW / RSIN)'],
    ['HealthInsuranceNumber', 'pii.health_insurance', 'Health Insurance Numbers'],
    ['MedicalCondition', 'pii.medical_condition', 'Medical Conditions'],
    ['Medication', 'pii.medication', 'Medications'],
    ['LicensePlateNumber', 'pii.license_plate', 'License Plates'],
];

const ALL_IDS = PII_CATEGORY_KEYS.map(([id]) => id);

const privacy = (draft: FormDraft): Partial<PrivacyModel> => (draft.privacy as Partial<PrivacyModel>) || {};
const mode = (draft: FormDraft) => privacy(draft).mode ?? 'check';
const merge = (draft: FormDraft, patch: Partial<PrivacyModel>): FormDraft => ({ privacy: { ...privacy(draft), ...patch } });

/** The categories on: all of them while none are named (null = the organisation's list). */
export function categoriesOn(draft: FormDraft): string[] {
    const selected = privacy(draft).categories;
    return Array.isArray(selected) ? (selected as string[]) : ALL_IDS;
}

/** Back to null when every category (or none) is on, as the web writes it. */
export function categoriesPatch(next: readonly string[]): string[] | null {
    return next.length && next.length < ALL_IDS.length ? [...next] : null;
}

function sourceLabel(draft: FormDraft): Msg {
    const m = mode(draft);
    if (m === 'reveal') return msg('mobile.flow.privacy.source_reveal', 'What to restore');
    if (m === 'hide') return msg('mobile.flow.privacy.source_hide', 'What to hide it in');
    if (m === 'check_hide') return msg('mobile.flow.privacy.source_check_hide', 'What to scan and hide');
    return msg('mobile.flow.privacy.source_check', 'What to scan');
}

function modeNote(draft: FormDraft): Msg | null {
    const m = mode(draft);
    if (m === 'reveal') {
        return msg('mobile.flow.privacy.note_reveal', 'Bind the next step to output.text. Most values come back on their own — an AI reply, a tool result — so this is only needed where one did not.');
    }
    if (m === 'hide') {
        return msg('mobile.flow.privacy.note_hide', 'Bind the next step to output.text. Every value is replaced by a placeholder like [email_1], and the real values are put back automatically wherever the run uses them again.');
    }
    return msg('mobile.flow.privacy.note_branches', 'Leaves by “personal data” or “clean” — connect an alert to the first.');
}

const branches = (draft: FormDraft) => modeBranches(mode(draft));

export interface DroppedEdge {
    edge: FlowEdge;
    port: string;
    why: string;
}

/**
 * The connections a mode switch would cost, BEFORE it is saved — port of the
 * web's privacyModel.js `droppedEdgesOnModeChange`: a guard leaving
 * two-way mode loses its "clean" edge; a step becoming a guard loses its "if
 * it fails" edge (a guard may not carry one).
 */
export function droppedEdgesOnModeChange(step: Partial<FlowNode> | null | undefined, nextMode: unknown, edges: readonly FlowEdge[] = []): DroppedEdge[] {
    const from = step?.id;
    if (!from) return [];
    const out = (edges || []).filter((e) => e?.from === from);
    const wasBranching = modeBranches(readPrivacyMode(step));
    const willBranch = modeBranches(nextMode);
    const dropped: DroppedEdge[] = [];
    if (wasBranching && !willBranch) {
        for (const e of out) if (e.label === 'else') dropped.push({ edge: e, port: 'clean', why: 'this mode has only one way on' });
    }
    if (!wasBranching && willBranch) {
        for (const e of out) {
            if (e.label === 'on_error') dropped.push({ edge: e, port: 'if it fails', why: 'a checking step cannot have an "if it fails" path' });
        }
    }
    return dropped;
}

function modeSwitchCost(value: unknown, _draft: FormDraft, ctx: { step: FlowNode; definition: { edges?: readonly FlowEdge[] } }) {
    const dropped = droppedEdgesOnModeChange(ctx.step, value, ctx.definition.edges ?? []);
    if (!dropped.length) return null;
    const message = dropped.some((d) => d.port === 'clean')
        ? msg('mobile.flow.privacy.drops_clean', 'This mode has only one way on, so the “clean” connection is removed.')
        : msg('mobile.flow.privacy.drops_error', 'A checking step cannot have an “if it fails” path, so that connection is removed.');
    return { message, action: msg('mobile.flow.privacy.switch_anyway', 'Switch anyway') };
}

export const PRIVACY: EditorSpec = {
    type: 'guard',
    sections: [
        {
            key: 'config',
            title: TITLES.configuration,
            defaultOpen: true,
            fields: [
                {
                    kind: 'choice',
                    id: 'mode',
                    label: msg('mobile.flow.privacy.what', 'What should this step do?'),
                    options: PRIVACY_MODE_WORDS,
                    read: mode,
                    write: (value, draft) => merge(draft, { mode: value as PrivacyModel['mode'] }),
                    confirm: modeSwitchCost,
                },
                {
                    kind: 'path',
                    id: 'sourceRef',
                    label: sourceLabel,
                    hint: (draft) =>
                        mode(draft) === 'reveal'
                            ? msg('mobile.flow.privacy.source_reveal_hint', 'The value that still holds placeholders — usually the output of a step that worked on hidden data.')
                            : msg('mobile.flow.privacy.source_hint', 'Any value from an earlier step — an email body, a document’s text, a form answer. Objects are scanned whole.'),
                    prompt: msg('mobile.flow.privacy.pick', 'Pick a value from an earlier step'),
                    read: (draft) => privacy(draft).sourceRef ?? '',
                    write: (value, draft) => merge(draft, { sourceRef: String(value ?? '') }),
                },
                { kind: 'note', id: 'modeNote', hint: modeNote },
                {
                    kind: 'toggle',
                    id: 'stopOnFound',
                    visibleWhen: branches,
                    label: msg('mobile.flow.privacy.stop', 'Stop the run'),
                    description: msg('mobile.flow.privacy.stop_hint', 'The run fails, and the failure says which categories were found.'),
                    read: (draft) => !!privacy(draft).stopOnFound,
                    write: (value, draft) => merge(draft, { stopOnFound: !!value }),
                },
                {
                    kind: 'toggle',
                    id: 'maskOnFound',
                    visibleWhen: branches,
                    label: msg('mobile.flow.privacy.mask', 'Pass a masked copy on'),
                    description: msg(
                        'mobile.flow.privacy.mask_hint',
                        'Adds output.masked, with every value replaced by [person]. Irreversible — the original is not recoverable from it.',
                    ),
                    read: (draft) => !!privacy(draft).maskOnFound,
                    write: (value, draft) => merge(draft, { maskOnFound: !!value }),
                },
            ],
        },
        {
            key: 'advanced',
            title: TITLES.advanced,
            hasContent: (draft) => Array.isArray(privacy(draft).categories) || typeof privacy(draft).confidence === 'number',
            fields: [
                {
                    kind: 'chips',
                    id: 'categories',
                    visibleWhen: (draft) => modeScans(mode(draft)),
                    label: (draft) =>
                        modeHides(mode(draft)) && !branches(draft)
                            ? msg('mobile.flow.privacy.hide_these', 'Hide')
                            : msg('mobile.flow.privacy.look_for', 'Look for'),
                    hint: msg(
                        'mobile.flow.privacy.categories_hint',
                        'Everything the organisation looks for, unless you narrow it here. A step can only look for LESS than the Privacy Shield does, never more.',
                    ),
                    options: PII_CATEGORY_KEYS.map(([id, key, english]) => ({ value: id, label: msg(key, english) })),
                    read: categoriesOn,
                    write: (value, draft) => merge(draft, { categories: categoriesPatch(value as string[]) }),
                },
                {
                    kind: 'number',
                    id: 'confidence',
                    visibleWhen: (draft) => modeScans(mode(draft)),
                    min: 0,
                    max: 1,
                    allowBlank: true,
                    label: msg('mobile.flow.privacy.confidence', 'Only report matches above'),
                    hint: msg(
                        'mobile.flow.privacy.confidence_hint',
                        'Leave empty to use the organisation’s threshold. A higher number reports only what the detector is more sure about.',
                    ),
                    read: (draft) => privacy(draft).confidence ?? '',
                    write: (value, draft) => merge(draft, { confidence: value === '' || value == null ? null : Number(value) }),
                },
            ],
        },
    ],
};
