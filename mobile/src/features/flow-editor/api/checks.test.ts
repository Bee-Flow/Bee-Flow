/**
 * The trigger diagnose: its path, and how its answer is read — the shape
 * routes/automation/diagnoseTrigger.js answers with, pinned against the source.
 */

import fs from 'node:fs';
import path from 'node:path';

import { api } from '@/core/api/client';

import { diagnoseTrigger, readDiagnosis } from './checks';

jest.mock('@/core/api/client', () => {
    const actual = jest.requireActual('@/core/api/client');
    return { ...actual, api: { get: jest.fn(), post: jest.fn(), put: jest.fn() } };
});

const SERVER = path.resolve(__dirname, '../../../../../server');

beforeEach(() => jest.clearAllMocks());

describe('the trigger diagnose', () => {
    it('posts to the automation and reads each check', async () => {
        (api.post as jest.Mock).mockResolvedValue({
            ok: false,
            kind: 'gmail.mail.new',
            checks: [
                { name: 'credentials', status: 'error', message: 'No Gmail credentials', detail: { remediation: 'Connect Gmail' } },
                { name: 'odd', status: 'nonsense', message: 7 },
            ],
        });
        const result = await diagnoseTrigger('a 1');
        expect(api.post).toHaveBeenCalledWith('/api/automation/a%201/diagnose-trigger', {}, { retry: false });
        expect(result).toEqual({
            ok: false,
            kind: 'gmail.mail.new',
            checks: [
                { name: 'credentials', status: 'error', message: 'No Gmail credentials', detail: { remediation: 'Connect Gmail' } },
                { name: 'odd', status: 'skipped', message: '', detail: undefined },
            ],
        });
        expect(readDiagnosis(null)).toEqual({ ok: false, kind: 'unknown', checks: [] });
    });

    it('matches the route’s answer: ok, kind and checks of name, status, message and detail', () => {
        // Split out of runs.js, which mounts it in the route's old place.
        expect(fs.readFileSync(path.join(SERVER, 'routes/automation/runs.js'), 'utf8')).toContain("router.use(require('./diagnoseTrigger'));");
        const src = fs.readFileSync(path.join(SERVER, 'routes/automation/diagnoseTrigger.js'), 'utf8');
        expect(src).toContain("router.post('/:id/diagnose-trigger'");
        expect(src).toContain('res.json({ ok, kind: `nextcloud.${event}`, checks })');
        expect(src).toMatch(/checks\.push\(\{ name: '[a-z_]+', status: '(ok|warn|error)', message: /);
    });
});
