/**
 * A new automation starts from the same document on both clients: the web's
 * createAutomationDraft and createFormAutomation
 * (agent-hub/src/components/admin/Studio/studioApps.jsx), read as TEXT —
 * they import the builder chunk lazily and cannot run under jest.
 */

import fs from 'node:fs';
import path from 'node:path';

import { newFlowSeed } from './seed';
import { defaultFormDeclaration } from '../model/formDefaults';

const WEB = fs.readFileSync(
    path.resolve(__dirname, '../../../../../agent-hub/src/components/admin/Studio/studioApps.jsx'),
    'utf8',
);

describe('the new-automation seed', () => {
    it('is the web draft body: schemaVersion 1, a manual trigger, empty steps, edges and vars', () => {
        const body = WEB.slice(WEB.indexOf('export async function createAutomationDraft'));
        expect(body).toContain('schemaVersion: 1,');
        expect(body).toContain("trigger: trigger || { id: 'trg', type: 'trigger', kind: 'manual', output: {} },");
        expect(body).toMatch(/steps: \[\],\s*edges: \[\],\s*vars: \{\},/);
        expect(newFlowSeed()).toEqual({
            schemaVersion: 1,
            trigger: { id: 'trg', type: 'trigger', kind: 'manual', output: {} },
            steps: [],
            edges: [],
            vars: {},
        });
    });

    it('a form is the same body with the web form trigger', () => {
        const body = WEB.slice(WEB.indexOf('export async function createFormAutomation'));
        expect(body).toContain(
            "trigger: { id: 'trg', type: 'trigger', kind: 'form', form: { ...form, title: title || form.title, ...(collect ? { collect: true } : {}) }, output: {} },",
        );
        const seeded = newFlowSeed('form', { title: 'Intake', collect: true });
        expect(seeded.trigger).toEqual({
            id: 'trg',
            type: 'trigger',
            kind: 'form',
            form: { ...defaultFormDeclaration(), title: 'Intake', collect: true },
            output: {},
        });
        expect(newFlowSeed('form').trigger?.form?.title).toBe(defaultFormDeclaration().title);
    });
});
