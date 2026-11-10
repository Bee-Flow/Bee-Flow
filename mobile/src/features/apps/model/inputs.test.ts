/**
 * Which form fields the phone draws and submits when a field is gated.
 *
 * FormCard submits exactly initialValues(block.inputs), so a field left out of
 * the collected inputs is neither drawn nor sent.
 */

import { planScreen, type AppBlock } from './appDefinition';
import { collectInputs, initialValues } from './inputs';
import type { AppDefinition, AppNode } from './types';

const field = (name: string, extra: Partial<AppNode> = {}): AppNode => ({
    id: `f-${name}`,
    type: 'input_text',
    props: { name, label: name, defaultValue: `${name}-default` },
    ...extra,
});

const formOf = (children: AppNode[]): AppNode => ({ id: 'form-1', type: 'form', props: {}, children });

const app = (children: AppNode[]): AppDefinition =>
    ({
        homeScreenId: 's1',
        screens: [{ id: 's1', sections: [{ id: 'sec1', children: [formOf(children)] }] }],
        actions: {},
    }) as unknown as AppDefinition;

function formIn(definition: AppDefinition, role: string | null) {
    const plan = planScreen(definition, null, role);
    const form = plan.blocks.find((b): b is Extract<AppBlock, { kind: 'form' }> => b.kind === 'form');
    if (!form) throw new Error('no form block');
    return { names: form.inputs.map((i) => i.name), submitted: initialValues(form.inputs), unsupported: plan.unsupported };
}

describe('role-gated form fields', () => {
    const definition = app([field('open'), field('secret', { visibleToRoles: ['admin'] })]);

    it('are left out, and not named, for a viewer without the role', () => {
        const form = formIn(definition, 'viewer');
        expect(form.names).toEqual(['open']);
        expect(form.submitted).toEqual({ open: 'open-default' });
        expect(form.unsupported).toEqual([]);
    });

    it('are left out for a viewer with no role at all', () => {
        expect(formIn(definition, null).names).toEqual(['open']);
    });

    it('are drawn and submitted for a viewer with the role', () => {
        const form = formIn(definition, 'admin');
        expect(form.names).toEqual(['open', 'secret']);
        expect(form.submitted).toEqual({ open: 'open-default', secret: 'secret-default' });
    });

    it('an empty gate is open to everyone', () => {
        expect(formIn(app([field('a', { visibleToRoles: [] })]), null).names).toEqual(['a']);
    });

    it('a role-gated container inside the form hides every field in it', () => {
        const box: AppNode = { id: 'box', type: 'container', visibleToRoles: ['admin'], children: [field('inner')] };
        expect(formIn(app([field('open'), box]), 'viewer').names).toEqual(['open']);
        expect(formIn(app([field('open'), box]), 'admin').names).toEqual(['open', 'inner']);
    });
});

describe('form fields behind a condition the phone cannot evaluate', () => {
    const formula = { kind: 'formula', expr: 'vars.show' };

    it.each([
        ['visibleWhen', { visibleWhen: formula }],
        ['enabledWhen', { enabledWhen: formula }],
        ['a formula visible', { visible: formula as unknown as boolean }],
    ])('%s: hidden, not submitted, and named as missing', (_label, gate) => {
        const form = formIn(app([field('open'), field('maybe', gate)]), null);
        expect(form.names).toEqual(['open']);
        expect(form.submitted).toEqual({ open: 'open-default' });
        expect(form.unsupported).toEqual(['input_text']);
    });

    it('a conditioned container inside the form hides every field in it', () => {
        const box: AppNode = { id: 'box', type: 'container', visibleWhen: formula, children: [field('inner')] };
        const form = formIn(app([field('open'), box]), null);
        expect(form.names).toEqual(['open']);
        expect(form.unsupported).toEqual(['container']);
    });

    it('a plain boolean visible keeps its meaning', () => {
        expect(formIn(app([field('a', { visible: true }), field('b', { visible: false })]), null).names).toEqual(['a']);
    });

    it('the role gate is checked first: a field hidden by role is not named even with a condition', () => {
        const form = formIn(app([field('secret', { visibleToRoles: ['admin'], visibleWhen: formula })]), 'viewer');
        expect(form.names).toEqual([]);
        expect(form.unsupported).toEqual([]);
    });
});

describe('collectInputs without a viewer role', () => {
    it('treats every role gate as closed (fail closed)', () => {
        const noted: string[] = [];
        const inputs = collectInputs(formOf([field('open'), field('secret', { visibleToRoles: ['admin'] })]), (t) => noted.push(t));
        expect(inputs.map((i) => i.name)).toEqual(['open']);
        expect(noted).toEqual([]);
    });
});
