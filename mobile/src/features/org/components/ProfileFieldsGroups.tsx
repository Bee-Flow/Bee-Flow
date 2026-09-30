/**
 * Organisation Info's two cards, in the web's order and with its keys:
 * Branding (name … website) and Legal & Invoicing (street … VAT). The
 * country is the web's select, opened as a sheet.
 */

import React from 'react';
import type { KeyboardTypeOptions } from 'react-native';

import { useTranslation, type TranslateFn } from '@/core/i18n';
import { Group, SettingRow, TextField } from '@/shared/ui';

import { FieldRow } from './FieldRow';
import { countryName } from '../model/countries';
import type { ProfileField, ProfileForm } from '../model/profile';

interface FieldSpec {
    key: Exclude<ProfileField, 'billingCountry'>;
    label: string;
    placeholder: string;
    hint?: string;
    keyboard?: KeyboardTypeOptions;
}

function brandingFields(t: TranslateFn): FieldSpec[] {
    return [
        { key: 'name', label: t('org.company_name', 'Company Name'), placeholder: t('org.placeholder_company_name', 'Bee Flow B.V.') },
        {
            key: 'tagline',
            label: t('org.tagline', 'Tagline'),
            placeholder: t('org.placeholder_tagline', 'Your Processes, Pollinated with Intelligence.'),
            hint: t('org.tagline_hint', 'Shown below the company name in headers and exports.'),
        },
        { key: 'description', label: t('org.description', 'Description'), placeholder: t('org.placeholder_description', 'Brief description of your organisation') },
        { key: 'email', label: t('org.email', 'Email'), placeholder: t('org.placeholder_email', 'info@company.nl'), keyboard: 'email-address' },
        { key: 'phone', label: t('org.phone', 'Phone'), placeholder: t('org.placeholder_phone', '+31 20 123 4567'), keyboard: 'phone-pad' },
        { key: 'website', label: t('org.website', 'Website'), placeholder: t('org.placeholder_website', 'https://beeflow.nl'), keyboard: 'url' },
    ];
}

function legalFields(t: TranslateFn): { address: FieldSpec[]; registration: FieldSpec[] } {
    return {
        address: [
            {
                key: 'address',
                label: t('org.street', 'Street + number'),
                placeholder: t('org.placeholder_street', 'Hoofdstraat 123'),
                hint: t('org.billing_address_hint', 'Used on invoices and to calculate tax at checkout.'),
            },
            { key: 'billingLine2', label: t('org.address_line2', 'Address line 2 (optional)'), placeholder: t('org.placeholder_line2', 'Unit, floor, etc.') },
            { key: 'billingPostalCode', label: t('org.postal_code', 'Postal code'), placeholder: t('org.placeholder_postal_code', '1011 AB') },
            { key: 'billingCity', label: t('org.city', 'City'), placeholder: t('org.placeholder_city', 'Amsterdam') },
        ],
        registration: [
            { key: 'kvk', label: t('org.kvk', 'Chamber of Commerce (KVK)'), placeholder: t('org.placeholder_kvk', '97632430') },
            { key: 'vat', label: t('org.vat', 'VAT Number'), placeholder: t('org.placeholder_vat', 'NL123456789B01') },
        ],
    };
}

type Props = {
    form: ProfileForm;
    onChange: (key: ProfileField, value: string) => void;
    onPickCountry: () => void;
    disabled: boolean;
    /** The name field's refusal, when it is empty. */
    nameError?: string | null;
};

function fieldRows(specs: FieldSpec[], { form, onChange, disabled, nameError }: Omit<Props, 'onPickCountry'>) {
    return specs.map((spec) => (
        <FieldRow key={spec.key}>
            <TextField
                testID={`org-field-${spec.key}`}
                label={spec.label}
                placeholder={spec.placeholder}
                hint={spec.hint}
                error={spec.key === 'name' ? nameError : null}
                value={form[spec.key]}
                keyboardType={spec.keyboard}
                autoCapitalize={spec.keyboard ? 'none' : 'sentences'}
                editable={!disabled}
                onChangeText={(value) => onChange(spec.key, value)}
            />
        </FieldRow>
    ));
}

export function ProfileFieldsGroups(props: Props) {
    const t = useTranslation();
    const legal = legalFields(t);
    const country = props.form.billingCountry;
    return (
        <>
            <Group title={t('org.branding', 'Branding')} footer={t('org.branding_subtitle', 'Logo, name, and public-facing details')}>
                {fieldRows(brandingFields(t), props)}
            </Group>
            <Group title={t('org.legal_invoicing', 'Legal & Invoicing')} footer={t('org.legal_subtitle', 'Address, registration, and compliance details')}>
                {fieldRows(legal.address, props)}
                <SettingRow
                    testID="org-field-billingCountry"
                    label={t('org.country', 'Country')}
                    value={country ? countryName(country) : t('org.select_country', 'Select a country')}
                    disabled={props.disabled}
                    onPress={props.onPickCountry}
                />
                {fieldRows(legal.registration, props)}
            </Group>
        </>
    );
}
