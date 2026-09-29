import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The two knowledge-source features on a plan, as the Studio shows them:
 * `kb_datatable_sources` (a table as a source) and `kb_scheduled_refresh`
 * (refreshing on a schedule). Both lock NEW use only, so every lock here
 * comes with what still works: existing table sources, "Only when I ask",
 * and a plain copy.
 */

const { ent } = vi.hoisted(() => ({
    ent: {
        current: { loading: false, error: null as unknown, lockReason: (_id: string): string | null => null },
    },
}));

vi.mock('../../../licensing/EntitlementsContext', () => ({ useEntitlements: () => ent.current }));
vi.mock('../../../../pages/meeting-notes/lib/transcriptionsApi', () => ({ listTranscriptionTags: vi.fn(async () => []) }));
vi.mock('../Datatables/datatablesApi', () => {
    const datatablesApi = { list: vi.fn(async () => []), getSchema: vi.fn(async () => ({ fields: [] })) };
    return { datatablesApi, default: datatablesApi };
});
vi.mock('./knowledgeApi', () => ({
    knowledgeApi: {
        update: vi.fn(async () => ({})),
        setPublished: vi.fn(async () => ({})),
        remove: vi.fn(async () => ({ success: true })),
        duplicate: vi.fn(async () => ({ id: 'kb_copy' })),
        categories: vi.fn(async () => []),
    },
}));

import AddSourcePanel, { messageFor } from './AddSourcePanel';
import ScheduleMenu from './ScheduleMenu';
import SettingsTab from './SettingsTab';

const t = (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key);

function refusal(word: 'feature_locked' | 'feature_disabled', feature: string) {
    return Object.assign(new Error(word), { status: 403, code: null, body: { error: word, feature } });
}

function locked(ids: Record<string, string>) {
    ent.current = { loading: false, error: null, lockReason: (id: string) => ids[id] || null };
}

beforeEach(() => {
    vi.clearAllMocks();
    ent.current = { loading: false, error: null, lockReason: () => null };
});

describe('adding a table as a source', () => {
    function panel() {
        render(<AddSourcePanel canManage onCreate={vi.fn()} onUpload={vi.fn()} />);
        return screen.getByTestId('kb-add-kind-datatable') as HTMLButtonElement;
    }

    it('is locked without kb_datatable_sources, and the tooltip says what still works', async () => {
        locked({ kb_datatable_sources: 'ceiling' });
        const button = panel();
        expect(button.disabled).toBe(true);
        expect(screen.getByTestId('kb-add-kind-datatable-locked')).toBeInTheDocument();
        // The other kinds are not the paid part.
        expect((screen.getByTestId('kb-add-kind-webpage') as HTMLButtonElement).disabled).toBe(false);

        await userEvent.hover(button.parentElement as HTMLElement);
        expect(await screen.findByText(/available on a higher plan\. Table sources you already have keep working/)).toBeInTheDocument();
    });

    it('opens its form with the licence', async () => {
        const button = panel();
        expect(button.disabled).toBe(false);
        expect(screen.queryByTestId('kb-add-kind-datatable-locked')).toBeNull();
        await userEvent.click(button);
        expect(await screen.findByTestId('kb-form-datatable')).toBeInTheDocument();
    });

    it('stays usable while the entitlements load: the server decides', () => {
        ent.current = { loading: true, error: null, lockReason: () => 'ceiling' };
        expect(panel().disabled).toBe(false);
    });
});

describe('messageFor', () => {
    it('turns a licence refusal into the sentence for its feature, never the bare word', () => {
        expect(messageFor(t, refusal('feature_locked', 'kb_datatable_sources'))).toMatch(/Tables as knowledge sources are available on a higher plan/);
        expect(messageFor(t, refusal('feature_locked', 'kb_scheduled_refresh'))).toMatch(/Refreshing on a schedule is available on a higher plan/);
        expect(messageFor(t, refusal('feature_disabled', 'kb_scheduled_refresh'))).toMatch(/not switched on for your organisation/);
        // Everything else is unchanged.
        expect(messageFor(t, { code: 'url_rejected' })).toMatch(/cannot be fetched/);
    });
});

describe('the schedule menu', () => {
    const anchorRef = { current: document.createElement('button') };
    function menu(source: Record<string, unknown>, onChange = vi.fn()) {
        render(<ScheduleMenu open onClose={() => {}} anchorRef={anchorRef} source={source} onChange={onChange} />);
        return onChange;
    }
    const row = (name: RegExp) => screen.getByRole('menuitemradio', { name }) as HTMLButtonElement;
    const WEB = { kind: 'webpage', refreshMode: 'manual', supportsModes: ['manual', 'schedule'] };

    it('locks every schedule without kb_scheduled_refresh, and never "Only when I ask"', () => {
        locked({ kb_scheduled_refresh: 'ceiling' });
        menu(WEB);
        expect(row(/On a schedule/).disabled).toBe(true);
        for (const name of [/Every day/, /Every Monday/, /The 1st of each month/]) expect(row(name).disabled).toBe(true);
        expect(row(/Only when I ask/).disabled).toBe(false);
        expect(screen.getByTestId('kb-schedule-locked').textContent).toMatch(/Refreshing when you ask always works/);
        expect(screen.queryByTestId('kb-schedule-paused')).toBeNull();
    });

    it('says a schedule set before the plan changed no longer runs, and lets it be switched off', async () => {
        locked({ kb_scheduled_refresh: 'not_granted' });
        const onChange = menu({ ...WEB, refreshMode: 'schedule', refreshCron: '0 6 * * 1' });
        expect(screen.getByTestId('kb-schedule-paused').textContent).toMatch(/no longer refreshes on its schedule/);
        expect(screen.getByTestId('kb-schedule-locked').textContent).toMatch(/Ask an admin/);
        await userEvent.click(row(/Only when I ask/));
        expect(onChange).toHaveBeenCalledWith({ mode: 'manual' });
    });

    it('never calls a table source\'s schedule paused: its sync keeps running', () => {
        locked({ kb_scheduled_refresh: 'ceiling' });
        menu({ kind: 'datatable', refreshMode: 'schedule', refreshCron: '0 6 * * 1', supportsModes: ['manual', 'schedule', 'live'] });
        expect(screen.queryByTestId('kb-schedule-paused')).toBeNull();
        expect(screen.getByTestId('kb-schedule-locked')).toBeInTheDocument();
        expect(row(/Live/).disabled).toBe(false);
    });

    it('offers every schedule with the licence', () => {
        menu(WEB);
        expect(row(/On a schedule/).disabled).toBe(false);
        expect(screen.queryByTestId('kb-schedule-locked')).toBeNull();
    });

    it('shows a refusal it did not see coming as the sentence, not as an unhandled error', async () => {
        const onChange = vi.fn(async () => { throw refusal('feature_locked', 'kb_scheduled_refresh'); });
        menu(WEB, onChange);
        await userEvent.click(row(/Every Monday/));
        expect((await screen.findByRole('alert')).textContent).toMatch(/Refreshing on a schedule is available on a higher plan/);
    });
});

describe('making a copy', () => {
    const KB = {
        id: 'kb1', name: 'Handboek', description: '', organization_id: 'org1',
        is_published: true, shared_groups: [], usage_contexts: ['agent'],
    };
    function settings() {
        render(<SettingsTab kb={KB} canManage
            onSaved={vi.fn()} onDeleted={vi.fn()} onDuplicated={vi.fn()} onNavigate={vi.fn()} />);
    }

    it('says before the button what a copy with its sources will leave out or change', async () => {
        locked({ kb_datatable_sources: 'ceiling', kb_scheduled_refresh: 'ceiling' });
        settings();
        await waitFor(() => expect(screen.getByTestId('kb-duplicate-locked-datatable')).toBeInTheDocument());
        expect(screen.getByTestId('kb-duplicate-locked-datatable').textContent).toMatch(/leaves out table sources/);
        expect(screen.getByTestId('kb-duplicate-locked-schedule').textContent).toMatch(/only when you ask/);
    });

    it('says nothing extra with the licence', () => {
        settings();
        expect(screen.queryByTestId('kb-duplicate-locked-datatable')).toBeNull();
        expect(screen.queryByTestId('kb-duplicate-locked-schedule')).toBeNull();
    });
});
