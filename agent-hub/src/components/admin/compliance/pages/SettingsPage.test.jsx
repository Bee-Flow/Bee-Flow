import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { SETTINGS_GROUPS, SETTINGS_FIELD_NAMES, buildSettingsBody, normaliseSettings } from './settings/settingsFields';
import SettingsPage from './SettingsPage';

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
    const setup = (over = {}) => {
        const props = pageProps(over);
        const user = userEvent.setup();
        render(<SettingsPage {...props} />);
        return { user, props };
    };
    const openFrameworksOff = (user) => user.click(screen.getByTestId('settings-frameworks-off-toggle'));
    const retype = async (user, el, text) => { await user.clear(el); await user.type(el, text); };

    it('renders the active groups, and the frameworks that are off behind one disclosure', async () => {
        const { user } = setup();
        for (const id of ['general', 'ai_act', 'nis2']) {
            expect(screen.getByTestId(`settings-group-${id}`).getAttribute('data-inactive')).toBe('false');
        }
        const off = screen.getByTestId('settings-frameworks-off');
        expect(off.textContent).toContain('Frameworks that are off (5)');
        expect(screen.getByTestId('settings-frameworks-off-names').textContent)
            .toBe('Cyber Resilience Act · Data Act · Accessibility (EAA) · DORA · Machinery Regulation');
        // The "answers are kept" sentence is said once, not per group.
        expect(off.textContent.match(/answers are kept/g)).toHaveLength(1);
        expect(screen.queryByTestId('settings-group-cra')).toBeNull();
        await openFrameworksOff(user);
        for (const id of ['cra', 'data_act', 'eaa', 'dora', 'machinery']) {
            expect(screen.getByTestId(`settings-group-${id}`).getAttribute('data-inactive')).toBe('true');
        }
        expect(screen.getByTestId('settings-frameworks-off-toggle').getAttribute('aria-expanded')).toBe('true');
    });

    it('a framework list that has not loaded yet marks no group as off', () => {
        setup({ frameworks: { frameworks: null } });
        for (const g of SETTINGS_GROUPS) {
            expect(screen.getByTestId(`settings-group-${g.id}`).getAttribute('data-inactive')).toBe('false');
        }
        expect(screen.queryByTestId('settings-frameworks-off')).toBeNull();
    });

    it('fills the general group from the loaded settings, under its sub-headings', () => {
        setup();
        expect(screen.getByTestId('settings-f-dpo_name').value).toBe('Jane Doe');
        expect(screen.getByTestId('settings-f-data_residency').value).toBe('eu');
        expect(screen.getByTestId('settings-f-breach_recipients-item').textContent).toBe('sec@example.com');
        const accountability = screen.getByTestId('settings-section-accountability');
        expect(accountability.textContent).toContain('Accountability');
        expect(within(accountability).getByTestId('settings-f-dpo_phone')).toBeTruthy();
        expect(within(screen.getByTestId('settings-section-lawful')).getByTestId('settings-f-default_retention_days')).toBeTruthy();
        expect(within(screen.getByTestId('settings-section-public')).getByTestId('settings-dsr-hint')).toBeTruthy();
        expect(within(screen.getByTestId('settings-section-alerts')).getByTestId('settings-f-sso_enforces_mfa')).toBeTruthy();
    });

    it('says per group how far it is answered', () => {
        setup();
        // General: the phone and the public base URL are still open; the
        // optional day fields and the toggles do not count.
        expect(screen.getByTestId('settings-group-general-progress').textContent).toBe('7 of 9 answered');
        expect(screen.getByTestId('settings-group-nis2-progress').textContent).toBe('2 of 6 answered');
    });

    it('opens a group with unanswered questions by default, and edits a NIS2 field', async () => {
        const saveSettings = vi.fn().mockResolvedValue({});
        const { user } = setup({ core: { saveSettings } });
        expect(screen.getByTestId('settings-group-nis2-toggle').getAttribute('aria-expanded')).toBe('true');
        await user.type(screen.getByTestId('settings-f-nis2_csirt_contact'), 'csirt@example.org');
        await user.click(screen.getByTestId('settings-save'));
        await waitFor(() => expect(saveSettings).toHaveBeenCalled());
        expect(saveSettings.mock.calls[0][0].nis2_csirt_contact).toBe('csirt@example.org');
        expect(saveSettings.mock.calls[0][0].nis2_entity_class).toBe('important');
    });

    it('offers the AI-content-marking toggle with its 2 Dec 2026 hint', () => {
        setup();
        const toggle = screen.getByTestId('settings-f-ai_content_marking_enabled');
        expect(toggle.textContent).toContain('2 December 2026');
        expect(screen.queryByTestId('settings-f-ai_content_marking_footer')).toBeNull(); // only once marking is on
    });

    it('reveals the footer text field once marking is enabled, and saves both', async () => {
        const saveSettings = vi.fn().mockResolvedValue({});
        const { user } = setup({ core: { saveSettings } });
        await user.click(screen.getByTestId('settings-f-ai_content_marking_enabled').querySelector('input'));
        await user.type(screen.getByTestId('settings-f-ai_content_marking_footer'), 'Written with AI help.');
        await user.click(screen.getByTestId('settings-save'));
        await waitFor(() => expect(saveSettings).toHaveBeenCalled());
        const body = saveSettings.mock.calls[0][0];
        expect(body.ai_content_marking_enabled).toBe(true);
        expect(body.ai_content_marking_footer).toBe('Written with AI help.');
    });

    it('Save stays disabled until something changes, and again after the save', async () => {
        const saveSettings = vi.fn().mockResolvedValue({});
        const { user } = setup({ core: { saveSettings } });
        const saveButton = screen.getByTestId('settings-save');
        expect(saveButton.disabled).toBe(true);
        expect(screen.queryByTestId('settings-dirty')).toBeNull();
        await user.type(screen.getByTestId('settings-f-dpo_phone'), '+31 20 555');
        expect(saveButton.disabled).toBe(false);
        expect(screen.getByTestId('settings-dirty').textContent).toBe('Unsaved changes');
        expect(screen.getByTestId('settings-dirty').getAttribute('data-tone')).toBe('warning');
        await user.click(saveButton);
        await waitFor(() => expect(saveSettings).toHaveBeenCalledTimes(1));
        await waitFor(() => expect(screen.getByTestId('settings-save').disabled).toBe(true));
        expect(screen.queryByTestId('settings-dirty')).toBeNull();
    });

    it('typing a change and taking it back leaves nothing to save', async () => {
        const { user } = setup();
        const name = screen.getByTestId('settings-f-dpo_name');
        await retype(user, name, 'Someone else');
        expect(screen.getByTestId('settings-save').disabled).toBe(false);
        await retype(user, name, 'Jane Doe');
        expect(screen.getByTestId('settings-save').disabled).toBe(true);
    });

    it('guards navigation while dirty: the confirm keeps the edit on Cancel', async () => {
        const setLeaveGuard = vi.fn();
        const { user } = setup({ setLeaveGuard });
        expect(setLeaveGuard.mock.calls.some(([fn]) => typeof fn === 'function')).toBe(false);
        await retype(user, screen.getByTestId('settings-f-dpo_name'), 'R. Bakker');
        const guard = setLeaveGuard.mock.calls.filter(([fn]) => typeof fn === 'function').at(-1)[0];

        let answer = guard();
        expect(await screen.findByText('Discard unsaved settings?')).toBeTruthy();
        await user.click(screen.getByTestId('confirm-dialog-cancel'));
        await expect(answer).resolves.toBe(false);
        expect(screen.getByTestId('settings-f-dpo_name').value).toBe('R. Bakker');

        answer = guard();
        await user.click(await screen.findByTestId('confirm-dialog-confirm'));
        await expect(answer).resolves.toBe(true);
    });

    it('drops the leave guard once saved, and on unmount', async () => {
        const setLeaveGuard = vi.fn();
        const saveSettings = vi.fn().mockResolvedValue({});
        const props = pageProps({ setLeaveGuard, core: { saveSettings } });
        const user = userEvent.setup();
        const { unmount } = render(<SettingsPage {...props} />);
        await user.type(screen.getByTestId('settings-f-dpo_phone'), '1');
        expect(typeof setLeaveGuard.mock.calls.at(-1)[0]).toBe('function');
        await user.click(screen.getByTestId('settings-save'));
        await waitFor(() => expect(setLeaveGuard.mock.calls.at(-1)[0]).toBeNull());
        await user.type(screen.getByTestId('settings-f-dpo_phone'), '2');
        expect(typeof setLeaveGuard.mock.calls.at(-1)[0]).toBe('function');
        unmount();
        expect(setLeaveGuard.mock.calls.at(-1)[0]).toBeNull();
    });

    it('asks before the tab closes only while there is something unsaved', async () => {
        const { user } = setup();
        const leave = () => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; };
        expect(leave()).toBe(false);
        await user.type(screen.getByTestId('settings-f-dpo_phone'), '9');
        expect(leave()).toBe(true);
    });

    it('toggles a legal basis through the pill row, with a check on the selected ones', async () => {
        const saveSettings = vi.fn().mockResolvedValue({});
        const { user } = setup({ core: { saveSettings } });
        expect(screen.getByTestId('settings-f-legal_bases-contract').getAttribute('data-checked')).toBe('true');
        expect(screen.getByTestId('settings-f-legal_bases-consent').getAttribute('data-checked')).toBeNull();
        await user.click(screen.getByTestId('settings-f-legal_bases-consent'));
        expect(screen.getByTestId('settings-f-legal_bases-consent').getAttribute('data-checked')).toBe('true');
        await user.click(screen.getByTestId('settings-save'));
        await waitFor(() => expect(saveSettings).toHaveBeenCalled());
        expect(saveSettings.mock.calls[0][0].legal_bases).toEqual(['contract', 'consent']);
    });

    it('adds and removes a breach recipient', async () => {
        const saveSettings = vi.fn().mockResolvedValue({});
        const { user } = setup({ core: { saveSettings } });
        await user.type(screen.getByTestId('settings-f-breach_recipients-input'), 'ciso@example.com{Enter}');
        await user.click(screen.getByTestId('settings-f-breach_recipients-remove-0'));
        await user.click(screen.getByTestId('settings-save'));
        await waitFor(() => expect(saveSettings).toHaveBeenCalled());
        expect(saveSettings.mock.calls[0][0].breach_recipients).toEqual(['ciso@example.com']);
    });

    it('stamps the AI-literacy confirmation without saving by itself, and says it is not saved yet', async () => {
        const saveSettings = vi.fn().mockResolvedValue({});
        const { user } = setup({ core: { saveSettings } });
        const state = () => screen.getByTestId('settings-f-ai_literacy_confirmed_at-state');
        expect(state().textContent).toContain('Not confirmed yet');
        await user.click(screen.getByTestId('settings-f-ai_literacy_confirmed_at-confirm'));
        expect(state().textContent).toContain('Confirmed');
        expect(state().textContent).toContain('not saved yet');
        expect(saveSettings).not.toHaveBeenCalled();
        expect(screen.getByTestId('settings-dirty')).toBeTruthy();
    });

    it('a stamp that was loaded reads as confirmed, with no reminder to save', () => {
        setup({ core: { settings: { ...SETTINGS, ai_literacy_confirmed_at: '2026-08-16T10:00:00.000Z' } } });
        const state = screen.getByTestId('settings-f-ai_literacy_confirmed_at-state');
        expect(state.textContent).toContain('Confirmed 16 Aug');
        expect(state.textContent).not.toContain('not saved');
        expect(state.textContent).not.toContain('remember');
    });

    it('routes a relevance answer to frameworks.setRelevance, not into the settings body', async () => {
        const setRelevance = vi.fn();
        const saveSettings = vi.fn().mockResolvedValue({});
        const { user } = setup({ core: { saveSettings }, frameworks: { setRelevance } });
        await openFrameworksOff(user);
        await user.click(screen.getByTestId('settings-group-dora-toggle'));
        await user.selectOptions(screen.getByTestId('settings-f-dora'), 'not_relevant');
        expect(setRelevance).toHaveBeenCalledWith('dora', 'not_relevant');
        await user.type(screen.getByTestId('settings-f-dpo_phone'), '1');
        await user.click(screen.getByTestId('settings-save'));
        await waitFor(() => expect(saveSettings).toHaveBeenCalled());
        expect(saveSettings.mock.calls[0][0].dora).toBeUndefined();
    });

    it('edits the DORA customer contacts list of a framework that is off', async () => {
        const saveSettings = vi.fn().mockResolvedValue({});
        const { user } = setup({ core: { saveSettings } });
        await openFrameworksOff(user);
        await user.click(screen.getByTestId('settings-group-dora-toggle'));
        await retype(user, screen.getByTestId('settings-f-incident_customer_contacts-email-0'), 'ops@bank.example');
        await user.click(screen.getByTestId('settings-save'));
        await waitFor(() => expect(saveSettings).toHaveBeenCalled());
        expect(saveSettings.mock.calls[0][0].incident_customer_contacts[0].email).toBe('ops@bank.example');
    });

    it('edits the machinery manual-subject list', async () => {
        const saveSettings = vi.fn().mockResolvedValue({});
        const { user } = setup({ core: { saveSettings } });
        await openFrameworksOff(user);
        await user.click(screen.getByTestId('settings-group-machinery-toggle'));
        await user.type(screen.getByTestId('settings-f-machinery_manual_subjects-input'), 'CNC gateway');
        await user.click(screen.getByTestId('settings-f-machinery_manual_subjects-add'));
        await user.click(screen.getByTestId('settings-save'));
        await waitFor(() => expect(saveSettings).toHaveBeenCalled());
        expect(saveSettings.mock.calls[0][0].machinery_manual_subjects).toEqual(['Press brake bridge', 'CNC gateway']);
    });

    it('fills the DPO block from an organisation member, from the sub-heading row', async () => {
        const { user } = setup();
        const picker = within(screen.getByTestId('settings-section-accountability')).getByTestId('settings-f-dpo_user');
        expect(picker.getAttribute('aria-label')).toBe('Fill from member');
        await user.selectOptions(picker, 'u1');
        expect(screen.getByTestId('settings-f-dpo_name').value).toBe('T. Smit');
        expect(screen.getByTestId('settings-f-dpo_email').value).toBe('t@example.com');
    });

    it('shows the public DSR link on the configured public base URL', async () => {
        const { user } = setup();
        await user.type(screen.getByTestId('settings-f-public_base_url'), 'https://acme.example/');
        expect(screen.getByTestId('settings-dsr-hint').textContent).toContain('https://acme.example/privacy/requests');
    });

    it('cannot save before the settings have been read', () => {
        setup({ core: { settings: null } });
        expect(screen.getByTestId('settings-loading')).toBeTruthy();
        expect(screen.getByTestId('settings-save').disabled).toBe(true);
    });
});
