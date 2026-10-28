import { render as rtlRender, screen, waitFor, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * THE ONLY PLACE WHERE THE TWO STRIPS ARE REALLY MOUNTED.
 *
 * `AppRefBreadcrumb` and `UsedByButtonsCapsule` are each tested thoroughly in isolation, but
 * nothing renders them through the chain that carries them in production:
 *
 *   automation/index.jsx  →  BuilderShell (initialAppRef)
 *   BuilderShell          →  headerProps.breadcrumbSlot
 *   BuilderHeader         →  {breadcrumbSlot}
 *
 * Measured: replacing `{breadcrumbSlot}` in BuilderHeader with an empty fragment left 176
 * files and 2414 tests in src/components/automation green. The whole stage could thus quietly
 * become invisible (breadcrumb and "Used by N buttons") without one red test. The same held
 * for the `initialAppRef` thread.
 *
 * This file tests the chain in two pieces, each at its own seam:
 *   1. BuilderShell BUILDS the slot from the right two sources;
 *   2. BuilderHeader RENDERS what it gets in that prop.
 */

vi.mock('@/utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));
vi.mock('../../shared/Toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('./DiagramPane', () => ({ default: () => null, applyAddNode: (d) => d }));
vi.mock('../../chat/InputArea', () => ({ default: () => null }));
vi.mock('../../admin/Studio/Executions/ExecutionsPanel', () => ({ default: () => null }));
vi.mock('./versions/VersionsTab', () => ({ default: () => null }));
vi.mock('./TriggerDiagnosePanel', () => ({ default: () => null }));
vi.mock('../../shared/useConfirm', () => ({
    default: () => ({ confirm: () => Promise.resolve(true), confirmDialog: null }),
}));

let header = null;
vi.mock('./BuilderHeader', () => ({ default: (p) => { header = p; return null; } }));
vi.mock('./BuildTab', () => ({ default: (p) => { header = p.headerProps; return null; } }));
vi.mock('./SettingsTab', () => ({ default: () => null }));

// The two strips are replaced by markers: the question is whether they are MOUNTED,
// and with which props, not what they draw (that is in their own suites).
vi.mock('./AppRefBreadcrumb', () => ({
    default: ({ appRef }) => <div data-testid="breadcrumb">{appRef?.appId}</div>,
}));
vi.mock('./UsedByButtonsCapsule', () => ({
    default: ({ automationId }) => <div data-testid="capsule">{automationId}</div>,
}));

import { queryWrapper } from '@/test/queryWrapper';
import { authFetch } from '@/utils/helpers';
import BuilderShell from './BuilderShell';

// The hooks under this tree read through React Query, so every render needs
// a client above it — a fresh one per render, never the app singleton.
const render = (ui, options) => rtlRender(ui, { wrapper: queryWrapper(), ...options });

const APP_REF = { appId: '5f2a1c34-8b7d-4e19-9f00-2ab3c4d5e6f7', screenId: 'scr_dash01', nodeId: 'cmp_btn123' };

const DEF = {
    schemaVersion: 2,
    trigger: { id: 'trg', type: 'trigger', kind: 'manual', label: 'Manual' },
    steps: [{ id: 's1', type: 'ai_step', label: 'Draft it', prompt: 'hi', position: { x: 0, y: 0 } }],
    edges: [{ from: 'trg', to: 's1' }],
};

let row;
const json = (body, { ok = true, status = 200 } = {}) => ({ ok, status, json: () => Promise.resolve(body) });

async function mount(props = {}, definition = DEF) {
    row = { id: 'a1', title: 'Intake', description: null, definition };
    render(<BuilderShell automationId="a1" onBack={() => {}} user={{ id: 'u1' }} {...props} />);
    await waitFor(() => expect(header).toBeTruthy());
}

beforeEach(() => {
    header = null;
    authFetch.mockReset();
    authFetch.mockImplementation((url, opts = {}) => {
        const method = opts.method || 'GET';
        if (url === '/api/automation/a1' && method === 'GET') return Promise.resolve(json({ automation: { ...row } }));
        if (url === '/api/automation/a1' && method === 'PUT') {
            row = { ...row, ...JSON.parse(opts.body) };
            return Promise.resolve(json({ automation: { ...row } }));
        }
        if (url === '/api/automation/_runs/active') return Promise.resolve(json({ active: [] }));
        if (url.startsWith('/api/automation/builder/session/')) return Promise.resolve(json({}, { ok: false, status: 404 }));
        if (url.startsWith('/api/automation/a1/runs')) return Promise.resolve(json({ runs: [] }));
        if (url.startsWith('/api/automation/a1/usage')) return Promise.resolve(json({ usage: [], complete: true }));
        if (url.startsWith('/ai/config/tiers-for-user')) return Promise.resolve(json({ auto: { label: 'Auto' } }));
        return Promise.resolve(json({}));
    });
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('BuilderShell bouwt de kruimelstrook van de header', () => {
    it('een automatisering die je uit de lijst opent toont alleen de "gebruikt door"-capsule', async () => {
        await mount();
        render(<div>{header.breadcrumbSlot}</div>);
        expect(screen.queryByTestId('breadcrumb')).toBeNull();
        expect(screen.getByTestId('capsule').textContent).toBe('a1');
    });

    it('een automation die je via ?from=app:… opent toont ALLEBEI, kruimel eerst', async () => {
        // This is the `initialAppRef` thread: index.jsx reads it from the URL and passes it in
        // here. It was tested nowhere.
        await mount({ initialAppRef: APP_REF });
        const { container } = render(<div>{header.breadcrumbSlot}</div>);
        expect(screen.getByTestId('breadcrumb').textContent).toBe(APP_REF.appId);
        expect(screen.getByTestId('capsule').textContent).toBe('a1');
        const order = [...container.querySelectorAll('[data-testid]')].map(el => el.dataset.testid);
        expect(order).toEqual(['breadcrumb', 'capsule']);
    });

    it('een herbruikbare Step krijgt GEEN capsule — die wordt door automatiseringen aangeroepen, niet door knoppen', async () => {
        await mount({ mode: 'step' });
        render(<div>{header.breadcrumbSlot ?? null}</div>);
        expect(screen.queryByTestId('capsule')).toBeNull();
    });
});

// The HEADER half of this chain is in BuilderHeader.views.test.jsx:
// there BuilderHeader is not mocked, here it is (otherwise the shell cannot be measured).
