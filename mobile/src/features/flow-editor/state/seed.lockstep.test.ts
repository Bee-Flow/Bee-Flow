/**
 * A new automation starts from the same document on both clients: the web's
 * createAutomationDraft (agent-hub/src/api/queries/automation/createDraft.ts)
 * and createFormAutomation (agent-hub/src/components/admin/Studio/studioGates.ts),
 * read as TEXT — they import the builder chunk lazily and cannot run under
 * jest. studioApps.jsx, where both used to live, is now a compatibility
 * re-export of the two; the last test pins that it still hands them out.
 */

import fs from 'node:fs';
import path from 'node:path';

import { newFlowSeed } from './seed';
import { defaultFormDeclaration } from '../model/formDefaults';

const AGENT_HUB = path.resolve(__dirname, '../../../../../agent-hub/src');
const read = (rel: string) => fs.readFileSync(path.join(AGENT_HUB, rel), 'utf8');
const CREATE_DRAFT = read('api/queries/automation/createDraft.ts');
const GATES = read('components/admin/Studio/studioGates.ts');
const BARREL = read('components/admin/Studio/studioApps.tsx');

describe('the new-automation seed', () => {
    it('is the web draft body: schemaVersion 1, a manual trigger, empty steps, edges and vars', () => {
        expect(CREATE_DRAFT).toContain('export async function createAutomationDraft');
        const body = CREATE_DRAFT.slice(CREATE_DRAFT.indexOf('export async function createAutomationDraft'));
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
        expect(GATES).toContain('export async function createFormAutomation');
        const body = GATES.slice(GATES.indexOf('export async function createFormAutomation'));
        // The form goes through the same createAutomationDraft as the manual seed.
        expect(body).toContain("await import('../../../api/queries/automation/createDraft')");
        expect(body).toContain('return createAutomationDraft(ctx, {');
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

    it('studioApps.jsx still hands out both helpers', () => {
        expect(BARREL).toMatch(/export \{[^}]*\bcreateFormAutomation\b[^}]*\} from '\.\/studioGates';/);
        expect(BARREL).toMatch(/export async function createAutomationDraft\(ctx[^,]*, options[^)]*\) \{/);
        expect(BARREL).toContain("await import('../../../api/queries/automation/createDraft')");
    });
});
