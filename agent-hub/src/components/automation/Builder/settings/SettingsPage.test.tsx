import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withQueryClient } from '../../../../test/queryWrapper';

const { readiness, railProps } = vi.hoisted(() => ({
    readiness: { current: null as unknown },
    railProps: { current: null as null | { onOpenSection?: (id: string) => void } },
}));

vi.mock('../../../../utils/helpers', () => ({
    API_BASE: '',
    authFetch: vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ folders: [] }) })),
}));
vi.mock('../../../../api/queries/automation/readiness', () => ({
    useReadiness: () => ({ data: readiness.current }),
    readinessStamp: () => '',
}));
// ST2's sections: this page only places them.
vi.mock('./NotificationsSection', () => ({ default: () => <div data-testid="notifications-section" /> }));
vi.mock('./SharingSection', () => ({ default: () => <div data-testid="sharing-section" /> }));
vi.mock('./AiActSection', () => ({
    default: () => <div data-testid="ai-act-section" />,
    aiActVisible: (r: { aiAct: { required: boolean } } | null) => !!r && r.aiAct.required,
    aiActOpen: (r: { aiAct: { required: boolean; status: string } } | null) => !!r && r.aiAct.required && r.aiAct.status === 'missing',
}));
vi.mock('./ReadinessRail', () => ({
    default: (p: { onOpenSection?: (id: string) => void }) => { railProps.current = p; return <div data-testid="readiness-rail" />; },
}));
vi.mock('../WebhookPanel', () => ({ default: () => <div data-testid="webhook-panel" /> }));

import SettingsTab from '../SettingsTab';

const automation = { id: 'a1', title: 'Collect files', description: '', definition: { trigger: { id: 't', type: 'trigger', kind: 'manual' }, steps: [] } };

describe('Settings page', () => {
    beforeEach(() => { readiness.current = null; railProps.current = null; });

    it('lists the sections in the table of contents and places every section and the rail', () => {
        render(withQueryClient(<SettingsTab automation={automation} onSave={vi.fn()} />));
        const toc = screen.getByRole('navigation', { name: 'Settings sections' });
        const entries = within(toc).getAllByRole('button').map((b) => b.textContent);
        expect(entries).toEqual(['General', 'Start', 'Notifications', 'Who can do what', 'Advanced']);
        expect(within(toc).getByRole('button', { name: 'General' }).getAttribute('aria-current')).toBe('true');
        for (const id of ['notifications-section', 'sharing-section', 'readiness-rail']) expect(screen.getByTestId(id)).toBeTruthy();
        // No compliance hub: no AI Act entry and no section.
        expect(screen.queryByTestId('ai-act-section')).toBeNull();
    });

    it('shows the AI Act entry with a warning dot while the check is missing', () => {
        readiness.current = { aiAct: { required: true, status: 'missing' } };
        render(withQueryClient(<SettingsTab automation={automation} onSave={vi.fn()} />));
        const toc = screen.getByRole('navigation', { name: 'Settings sections' });
        const entry = within(toc).getByRole('button', { name: /AI Act check/ });
        expect(within(entry).getByRole('img', { name: 'Not done yet' })).toBeTruthy();
        expect(screen.getByTestId('ai-act-section')).toBeTruthy();
    });

    it('moves the active entry when a TOC entry or the rail asks for a section', async () => {
        const user = userEvent.setup();
        render(withQueryClient(<SettingsTab automation={automation} onSave={vi.fn()} />));
        const toc = screen.getByRole('navigation', { name: 'Settings sections' });
        await user.click(within(toc).getByRole('button', { name: 'Advanced' }));
        expect(within(toc).getByRole('button', { name: 'Advanced' }).getAttribute('aria-current')).toBe('true');
        expect(typeof railProps.current?.onOpenSection).toBe('function');
    });

    it('is read-only for someone the routine is only shared with to view', () => {
        render(withQueryClient(<SettingsTab automation={{ ...automation, myRole: 'view' }} onSave={vi.fn()} />));
        expect(screen.getByRole('note').textContent).toMatch(/Only the owner and people who can edit/);
        expect(screen.getByLabelText('Name').matches(':disabled')).toBe(true);
        expect(screen.getByRole('button', { name: 'change' }).matches(':disabled')).toBe(true);
        // Duplicate and export stay available: they only need view.
        expect(screen.getByRole('button', { name: 'Duplicate' }).matches(':disabled')).toBe(false);
    });

    it('opens Advanced when the page is deep-linked to it', () => {
        render(withQueryClient(<SettingsTab automation={automation} onSave={vi.fn()} initialSection="advanced" />));
        expect(screen.getByTestId('webhook-panel')).toBeTruthy();
    });
});
