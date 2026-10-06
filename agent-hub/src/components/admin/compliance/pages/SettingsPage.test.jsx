import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import SettingsPage from './SettingsPage';
import { SETTINGS_GROUPS, SETTINGS_FIELD_NAMES, buildSettingsBody, normaliseSettings } from './settings/settingsFields';

vi.mock('../../../../hooks/useTranslation', () => {
    const useTranslation = () => ({
        t: (key, fallback, params) => {
            let out = typeof fallback === 'string' ? fallback : key;
            for (const [k, v] of Object.entries(params || {})) out = out.split(`{${k}}`).join(String(v));
            return out;
        },
        locale: 'en',
        resolvedLocale: 'en',
    });
    return { default: useTranslation, useTranslation };
});

afterEach(cleanup);

const USERS = [
    { id: 'u1', displayName: 'T. Smit', email: 't@example.com', phone: '+31 6 1' },
    { id: 'u2', displayName: 'R. Bakker', email: 'r@example.com' },
];

const SETTINGS = {
    organization_id: 'org1',
    dpo_name: 'Jane Doe', dpo_email: 'dpo@example.com', dpo_phone: '',
    legal_bases: ['contract'], data_residency: 'eu', default_retention_days: 365,
    privacy_notice_url: 'https://example.com/privacy', breach_recipients: ['sec@example.com'],
    ai_literacy_confirmed_at: null, ai_literacy_material_url: '',
    ai_content_marking_enabled: false,
    nis2_entity_class: 'important', nis2_registered_at: '2026-08-20T00:00:00.000Z',
    incident_customer_contacts: [{ name: 'SOC', email: 'soc@bank.example', entity: 'Bank NV' }],
    dora_customer_notice_hours: 4,
    machinery_manual_subjects: ['Press brake bridge'],
};

function pageProps(over = {}) {
    const { core, frameworks, ...rest } = over;
    return {
        section: { id: 'settings' },
        tab: null, onTab: vi.fn(), navigate: vi.fn(), focusId: null,
        exportsEnabled: true, dl: (u) => u, api: '/api/compliance', isMobile: false,
        setHeaderActions: vi.fn(),
        data: {
            core: { settings: SETTINGS, saveSettings: vi.fn().mockResolvedValue({}), ...core },
            orgUsers: USERS,
            frameworks: {
                // The hook's shape: `frameworks` is the loaded list (null while loading).
                frameworks: ['gdpr', 'aia', 'iso27001', 'nis2', 'cra', 'data_act', 'pld', 'eaa', 'dora', 'machinery']
                    .map(id => ({ id, enabled: ['gdpr', 'aia', 'nis2'].includes(id) })),
                isEnabled: (id) => ['gdpr', 'aia', 'nis2'].includes(id),
                byId: (id) => ({ id, relevance: id === 'dora' ? 'relevant' : 'unknown' }),
                setRelevance: vi.fn(),
                ...frameworks,
            },
        },
        ...rest,
    };
}

describe('settingsFields', () => {
    it('names only compliance_settings columns — no relevance or picker pseudo-fields', () => {
        expect(SETTINGS_FIELD_NAMES).toContain('ai_content_marking_enabled');
        expect(SETTINGS_FIELD_NAMES).toContain('nis2_entity_class');
        expect(SETTINGS_FIELD_NAMES).not.toContain('dora');
        expect(SETTINGS_FIELD_NAMES).not.toContain('machinery');
        expect(SETTINGS_FIELD_NAMES).not.toContain('dpo_user');
    });

    it('covers every PLAN §1.3 settings field', () => {
        const expected = [
            'dpo_name', 'dpo_email', 'dpo_phone', 'legal_bases', 'data_residency', 'default_retention_days',
            'privacy_notice_url', 'breach_recipients', 'public_base_url', 'sso_enforces_mfa',
            'ai_literacy_material_url', 'ai_literacy_confirmed_at', 'ai_content_marking_enabled', 'ai_content_marking_footer',
            'nis2_entity_class', 'nis2_registration_reference', 'nis2_registered_at', 'nis2_authority_channel',
            'nis2_csirt_contact', 'nis2_board_training_at',
            'cra_role', 'cra_reporting_channel', 'psirt_contact_email', 'vuln_disclosure_url',
            'security_txt_policy_enabled', 'support_policy_url', 'support_end_date', 'security_update_channel',
            'data_act_provider_role', 'notice_period_days', 'exit_procedure_tested_at', 'exit_procedure_tested_by',
            'accessibility_statement_url', 'accessibility_conformance_level', 'accessibility_conformance_at',
            'incident_customer_contacts', 'dora_customer_notice_hours', 'dora_contract_clauses_confirmed_at',
            'dora_contract_clauses_confirmed_by', 'dora_contract_template_url',
            'machinery_manual_subjects',
        ];
        for (const name of expected) expect(SETTINGS_FIELD_NAMES).toContain(name);
        expect(new Set(SETTINGS_FIELD_NAMES).size).toBe(SETTINGS_FIELD_NAMES.length);
    });

    it('normalises absent values into empty answers, not guesses', () => {
        const form = normaliseSettings(null);
        expect(form.dpo_name).toBe('');
        expect(form.legal_bases).toEqual([]);
        expect(form.ai_content_marking_enabled).toBe(false);
        expect(form.incident_customer_contacts).toEqual([]);
        expect(form.nis2_registered_at).toBe('');
    });

    it('reads the project settings, with project hints on unless switched off', () => {
        expect(SETTINGS_FIELD_NAMES).toContain('project_retention_days');
        expect(SETTINGS_FIELD_NAMES).toContain('project_owner_hints_enabled');
        expect(normaliseSettings(null).project_owner_hints_enabled).toBe(true);
        expect(normaliseSettings({ project_owner_hints_enabled: false }).project_owner_hints_enabled).toBe(false);
        const body = buildSettingsBody({ ...normaliseSettings(null), project_retention_days: '90' });
        expect(body.project_retention_days).toBe(90);
        expect(body.project_owner_hints_enabled).toBe(true);
    });

    it('normalises a timestamp column onto the date input shape', () => {
        expect(normaliseSettings(SETTINGS).nis2_registered_at).toBe('2026-08-20');
    });

    it('builds the body from the allow-list — an unknown form key never travels', () => {
        const body = buildSettingsBody({ ...normaliseSettings(SETTINGS), secret_note: 'do not send', newRecipient: 'x@y.z' });
        expect(body.secret_note).toBeUndefined();
        expect(body.newRecipient).toBeUndefined();
        expect(body.dpo_name).toBe('Jane Doe');
        expect(body.default_retention_days).toBe(365);
        expect(body.legal_bases).toEqual(['contract']);
        expect(body.ai_content_marking_enabled).toBe(false);
        expect(body.incident_customer_contacts).toEqual([{ name: 'SOC', email: 'soc@bank.example', entity: 'Bank NV' }]);
    });

    it('sends an empty string as null and keeps numbers numeric', () => {
        const body = buildSettingsBody({ ...normaliseSettings(null), notice_period_days: '60', dpo_email: '   ' });
        expect(body.dpo_email).toBeNull();
        expect(body.notice_period_days).toBe(60);
        expect(body.default_retention_days).toBeNull();
    });
});

describe('SettingsPage', () => {
    it('renders a group per framework, including the ones that are off', () => {
        render(<SettingsPage {...pageProps()} />);
        for (const g of SETTINGS_GROUPS) expect(screen.getByTestId(`settings-group-${g.id}`)).toBeTruthy();
        expect(screen.getByTestId('settings-group-cra').getAttribute('data-inactive')).toBe('true');
        expect(screen.getByTestId('settings-group-nis2').getAttribute('data-inactive')).toBe('false');
    });

    it('a framework list that has not loaded yet marks no group as off', () => {
        render(<SettingsPage {...pageProps({ frameworks: { frameworks: null } })} />);
        for (const g of SETTINGS_GROUPS) {
            expect(screen.getByTestId(`settings-group-${g.id}`).getAttribute('data-inactive')).toBe('false');
        }
    });

    it('fills the general group from the loaded settings', () => {
        render(<SettingsPage {...pageProps()} />);
        expect(screen.getByTestId('settings-f-dpo_name').value).toBe('Jane Doe');
        expect(screen.getByTestId('settings-f-data_residency').value).toBe('eu');
        expect(screen.getByTestId('settings-f-breach_recipients-item').textContent).toBe('sec@example.com');
    });

    it('offers the AI-content-marking toggle with its 2 Dec 2026 hint', () => {
        render(<SettingsPage {...pageProps()} />);
        const toggle = screen.getByTestId('settings-f-ai_content_marking_enabled');
        expect(toggle).toBeTruthy();
        expect(toggle.textContent).toContain('2 December 2026');
        expect(screen.queryByTestId('settings-f-ai_content_marking_footer')).toBeNull(); // only once marking is on
    });

    it('reveals the footer text field once marking is enabled, and saves both', async () => {
        const saveSettings = vi.fn().mockResolvedValue({});
        render(<SettingsPage {...pageProps({ core: { saveSettings } })} />);
        fireEvent.click(screen.getByTestId('settings-f-ai_content_marking_enabled').querySelector('input'));
        const footer = screen.getByTestId('settings-f-ai_content_marking_footer');
        fireEvent.change(footer, { target: { value: 'Written with AI help.' } });
        fireEvent.click(screen.getByTestId('settings-save'));
        await waitFor(() => expect(saveSettings).toHaveBeenCalled());
        const body = saveSettings.mock.calls[0][0];
        expect(body.ai_content_marking_enabled).toBe(true);
        expect(body.ai_content_marking_footer).toBe('Written with AI help.');
    });

    it('opens a closed group and edits a NIS2 field', async () => {
        const saveSettings = vi.fn().mockResolvedValue({});
        render(<SettingsPage {...pageProps({ core: { saveSettings } })} />);
        fireEvent.click(screen.getByTestId('settings-group-nis2-toggle'));
        fireEvent.change(screen.getByTestId('settings-f-nis2_csirt_contact'), { target: { value: 'csirt@example.org' } });
        fireEvent.click(screen.getByTestId('settings-save'));
        await waitFor(() => expect(saveSettings).toHaveBeenCalled());
        expect(saveSettings.mock.calls[0][0].nis2_csirt_contact).toBe('csirt@example.org');
        expect(saveSettings.mock.calls[0][0].nis2_entity_class).toBe('important');
    });

    it('toggles a legal basis through the pill row', async () => {
        const saveSettings = vi.fn().mockResolvedValue({});
        render(<SettingsPage {...pageProps({ core: { saveSettings } })} />);
        fireEvent.click(screen.getByTestId('settings-f-legal_bases-consent'));
        fireEvent.click(screen.getByTestId('settings-save'));
        await waitFor(() => expect(saveSettings).toHaveBeenCalled());
        expect(saveSettings.mock.calls[0][0].legal_bases).toEqual(['contract', 'consent']);
    });

    it('adds and removes a breach recipient', async () => {
        const saveSettings = vi.fn().mockResolvedValue({});
        render(<SettingsPage {...pageProps({ core: { saveSettings } })} />);
        fireEvent.change(screen.getByTestId('settings-f-breach_recipients-input'), { target: { value: 'ciso@example.com' } });
        fireEvent.click(screen.getByTestId('settings-f-breach_recipients-add'));
        fireEvent.click(screen.getByTestId('settings-f-breach_recipients-remove-0'));
        fireEvent.click(screen.getByTestId('settings-save'));
        await waitFor(() => expect(saveSettings).toHaveBeenCalled());
        expect(saveSettings.mock.calls[0][0].breach_recipients).toEqual(['ciso@example.com']);
    });

    it('stamps the AI-literacy confirmation without saving by itself', () => {
        const saveSettings = vi.fn().mockResolvedValue({});
        render(<SettingsPage {...pageProps({ core: { saveSettings } })} />);
        expect(screen.getByTestId('settings-f-ai_literacy_confirmed_at-state').textContent).toContain('Not confirmed yet');
        fireEvent.click(screen.getByTestId('settings-f-ai_literacy_confirmed_at-confirm'));
        expect(screen.getByTestId('settings-f-ai_literacy_confirmed_at-state').textContent).toContain('Confirmed');
        expect(saveSettings).not.toHaveBeenCalled();
        expect(screen.getByTestId('settings-dirty')).toBeTruthy();
    });

    it('routes a relevance answer to frameworks.setRelevance, not into the settings body', async () => {
        const setRelevance = vi.fn();
        const saveSettings = vi.fn().mockResolvedValue({});
        render(<SettingsPage {...pageProps({ core: { saveSettings }, frameworks: { setRelevance } })} />);
        fireEvent.click(screen.getByTestId('settings-group-dora-toggle'));
        fireEvent.change(screen.getByTestId('settings-f-dora'), { target: { value: 'not_relevant' } });
        expect(setRelevance).toHaveBeenCalledWith('dora', 'not_relevant');
        fireEvent.click(screen.getByTestId('settings-save'));
        await waitFor(() => expect(saveSettings).toHaveBeenCalled());
        expect(saveSettings.mock.calls[0][0].dora).toBeUndefined();
    });

    it('edits the DORA customer contacts list', async () => {
        const saveSettings = vi.fn().mockResolvedValue({});
        render(<SettingsPage {...pageProps({ core: { saveSettings } })} />);
        fireEvent.click(screen.getByTestId('settings-group-dora-toggle'));
        fireEvent.change(screen.getByTestId('settings-f-incident_customer_contacts-email-0'), { target: { value: 'ops@bank.example' } });
        fireEvent.click(screen.getByTestId('settings-save'));
        await waitFor(() => expect(saveSettings).toHaveBeenCalled());
        expect(saveSettings.mock.calls[0][0].incident_customer_contacts[0].email).toBe('ops@bank.example');
    });

    it('edits the machinery manual-subject list', async () => {
        const saveSettings = vi.fn().mockResolvedValue({});
        render(<SettingsPage {...pageProps({ core: { saveSettings } })} />);
        fireEvent.click(screen.getByTestId('settings-group-machinery-toggle'));
        fireEvent.change(screen.getByTestId('settings-f-machinery_manual_subjects-input'), { target: { value: 'CNC gateway' } });
        fireEvent.click(screen.getByTestId('settings-f-machinery_manual_subjects-add'));
        fireEvent.click(screen.getByTestId('settings-save'));
        await waitFor(() => expect(saveSettings).toHaveBeenCalled());
        expect(saveSettings.mock.calls[0][0].machinery_manual_subjects).toEqual(['Press brake bridge', 'CNC gateway']);
    });

    it('fills the DPO block from an organisation member', () => {
        render(<SettingsPage {...pageProps()} />);
        fireEvent.change(screen.getByTestId('settings-f-dpo_user'), { target: { value: 'u1' } });
        expect(screen.getByTestId('settings-f-dpo_name').value).toBe('T. Smit');
        expect(screen.getByTestId('settings-f-dpo_email').value).toBe('t@example.com');
    });

    it('shows the public DSR link on the configured public base URL', () => {
        render(<SettingsPage {...pageProps()} />);
        fireEvent.change(screen.getByTestId('settings-f-public_base_url'), { target: { value: 'https://acme.example/' } });
        expect(screen.getByTestId('settings-dsr-hint').textContent).toContain('https://acme.example/privacy/requests');
    });

    it('cannot save before the settings have been read', () => {
        render(<SettingsPage {...pageProps({ core: { settings: null } })} />);
        expect(screen.getByTestId('settings-loading')).toBeTruthy();
        expect(screen.getByTestId('settings-save').disabled).toBe(true);
    });
});
