import { describe, it, expect } from 'vitest';
import { parseConfig } from '../../components/admin/compliance/data/useChatMonitoring';
import { createState, ROUTES } from './compliance';
import { chatMonitoringView } from './complianceChatMonitoring';

/**
 * The demo's chat-signals card reads the configuration through the hub's own
 * allow-list parser, so a field the fixture names differently from
 * routes/compliance/chatMonitoring.js shows up here as a default, not as a
 * blank on screen.
 */

type Route = (ctx: { state: ReturnType<typeof createState> }) => unknown;

describe('compliance demo — chat signals, switched off', () => {
    it('answers GET /chat-monitoring in the shape buildView sends, off and never set up', () => {
        const body = (ROUTES as unknown as Record<string, Route>)['GET /api/compliance/chat-monitoring']({ state: createState() });
        const view = parseConfig(body);
        expect(view.settings.enabled).toBe(false);
        expect(view.settings.surfaces).toEqual([]);
        expect(view.effective).toMatchObject({ state: 'off', surfaces: [], paused: [] });
        expect(view.dpia).toMatchObject({ kind: 'none', current: false });
        expect(view.catalogue.surfaces.map(s => [s.id, s.population, s.available])).toEqual([
            ['direct', 'employees', true], ['agent', 'employees', true], ['agent_public', 'visitors', true], ['notebook', 'employees', false],
        ]);
        expect(view.catalogue.retention).toEqual({ min: 30, max: 90, default: 90 });
        expect(view.contributors).toEqual({ direct: '<5', agent: '<5' });
    });

    it('takes the DPO, the privacy notice and the public DSR form from the org settings', () => {
        const view = parseConfig(chatMonitoringView(createState().settings));
        expect(view.dpoRecorded).toBe(true);
        expect(view.privacyNoticeUrlSet).toBe(true);
        expect(view.template).toEqual({ dpoContact: 'privacy@vandael.example', dsrUrl: 'https://vandael.example/dsr', shieldLogRetentionDays: 400 });
        const bare = parseConfig(chatMonitoringView({}));
        expect(bare.dpoRecorded).toBe(false);
        expect(bare.privacyNoticeUrlSet).toBe(false);
        expect(bare.template.dpoContact).toBeNull();
    });
});
