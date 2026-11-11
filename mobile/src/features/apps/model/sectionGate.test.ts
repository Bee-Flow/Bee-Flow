/**
 * The optional section gates on the phone: a section hidden from the viewer's role is not drawn
 * and not named; one behind a condition the phone cannot evaluate is not drawn and its parts are
 * named as needing the browser; every other section is drawn as before.
 */

import { planScreen } from './appDefinition';
import { sectionGate } from './gates';
import type { AppDefinition, AppSection } from './types';

const heading = (id: string, text: string) => ({ id, type: 'heading', props: { text } });

const app = (sections: AppSection[]): AppDefinition =>
    ({ homeScreenId: 's1', screens: [{ id: 's1', sections }], actions: {} }) as unknown as AppDefinition;

const DEF = app([
    { id: 'sec_open', children: [heading('h1', 'Open')] },
    { id: 'sec_mgr', visibleToRoles: ['manager'], children: [heading('h2', 'Managers')] },
    { id: 'sec_when', visibleWhen: { kind: 'formula', expr: "vars.view == 'archive'" }, children: [heading('h3', 'Archive')] },
    { id: 'sec_true', visibleWhen: true, children: [heading('h4', 'Always')] },
]);

const texts = (plan: ReturnType<typeof planScreen>) => plan.blocks.map((b) => (b as { text?: string }).text);

describe('section gates on the phone', () => {
    it('sectionGate reads the role list and the condition', () => {
        expect(sectionGate({ id: 'a' }, null)).toBe('open');
        expect(sectionGate({ id: 'a', visibleToRoles: [] }, null)).toBe('open');
        expect(sectionGate({ id: 'a', visibleToRoles: ['manager'] }, 'member')).toBe('hidden');
        expect(sectionGate({ id: 'a', visibleToRoles: ['manager'] }, 'manager')).toBe('open');
        expect(sectionGate({ id: 'a', visibleWhen: { kind: 'formula', expr: 'x' } }, null)).toBe('unsupported');
        expect(sectionGate({ id: 'a', visibleWhen: true }, null)).toBe('open');
    });

    it('a viewer without the role sees neither the section nor a mention of it', () => {
        const plan = planScreen(DEF, 's1', 'member');
        expect(texts(plan)).toEqual(['Open', 'Always']);
        expect(plan.unsupported).toEqual(['heading']);
    });

    it('the role itself sees the gated section', () => {
        expect(texts(planScreen(DEF, 's1', 'manager'))).toEqual(['Open', 'Managers', 'Always']);
    });
});
