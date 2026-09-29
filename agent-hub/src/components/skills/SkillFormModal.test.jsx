import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SkillFormModal from './SkillFormModal';

/**
 * The light skill maker.
 *
 * The claim worth a test is the one that can destroy work silently: this
 * modal writes the TEXT fields, and S1's write precedence re-parses the
 * structured steps/rules/examples from that text. So a skill that has steps
 * in Studio must SAY that editing the workflow text here replaces them —
 * and a skill that has none must not nag about it.
 *
 * The warning is only half the promise. The other half is that the modal
 * sends a text facet ONLY when it changed, so the sentence "unchanged text
 * leaves the structure alone" is true of this build and not of a server
 * that never compares anything.
 */

vi.mock('../../utils/helpers', () => ({
    API_BASE: '',
    authFetch: vi.fn(async () => ({ ok: true, status: 200, json: async () => [] })),
}));

const WITH_STRUCTURE = {
    id: 's1', name: 'Explain a quote', description: '', instructions: '',
    workflow: '1. Fetch the quote.', rules: '', examples: '',
    steps: [{ id: 'a', text: 'Fetch the quote.', refs: [{ kind: 'automation', id: 'a1' }] }],
    rulesV2: [], examplesV2: [],
};

beforeEach(() => { cleanup(); vi.clearAllMocks(); });

const open = (props = {}) => render(
    <SkillFormModal onSave={vi.fn()} onCancel={vi.fn()} saving={false} {...props} />,
);

describe('SkillFormModal', () => {
    it('warns that rewriting the workflow text replaces the steps Studio owns', () => {
        open({ skill: WITH_STRUCTURE });
        expect(screen.queryByTestId('skill-form-structure-warning')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Workflow' }));
        expect(screen.getByTestId('skill-form-structure-warning').textContent)
            .toContain('1 step in Studio');
    });

    // The count really can be 1, and the ternary belongs around the KEY
    // (I18N-CONVENTIES §2.3), so both halves have to be reachable.
    it('counts in the singular for one step and in the plural for two', () => {
        const two = { ...WITH_STRUCTURE, steps: [...WITH_STRUCTURE.steps, { id: 'b', text: 'Send it.', refs: [] }] };
        open({ skill: two });
        fireEvent.click(screen.getByRole('button', { name: 'Workflow' }));
        expect(screen.getByTestId('skill-form-structure-warning').textContent)
            .toContain('2 steps in Studio');
        cleanup();
        open({ skill: WITH_STRUCTURE });
        fireEvent.click(screen.getByRole('button', { name: 'Workflow' }));
        expect(screen.getByTestId('skill-form-structure-warning').textContent)
            .not.toContain('1 steps');
    });

    it('does not nag about a structure a skill does not have', () => {
        open({ skill: { ...WITH_STRUCTURE, steps: [] } });
        fireEvent.click(screen.getByRole('button', { name: 'Workflow' }));
        expect(screen.queryByTestId('skill-form-structure-warning')).toBeNull();
    });

    it('sends exactly the fields it edits, leaving everything else for the server to keep', () => {
        const onSave = vi.fn();
        open({ skill: WITH_STRUCTURE, onSave });
        fireEvent.change(screen.getByLabelText('Skill name'), { target: { value: 'Renamed' } });
        fireEvent.change(screen.getByLabelText('Instructions'), { target: { value: 'Be brief.' } });
        fireEvent.click(screen.getByRole('button', { name: 'Update skill' }));
        const [form] = onSave.mock.calls.at(-1);
        expect(Object.keys(form).sort()).toEqual([
            'description', 'dynamicActivation', 'icon', 'instructions',
            'isShared', 'name', 'sharedGroups',
        ]);
        expect(form).not.toHaveProperty('steps');
        expect(form).not.toHaveProperty('outputSchema');
    });

    /**
     * The bug this pins used to destroy work in silence. `workflow` was sent
     * on EVERY save, and S1's write precedence re-parses the steps from any
     * `workflow` it receives (skillStructure.resolveBodyWrite compares
     * nothing with what is stored). So renaming a skill from here re-minted
     * every step id and dropped every reference pill — a skill edited in
     * Studio, ruined by a save that touched only its name.
     */
    it('omits an UNCHANGED workflow, so renaming here cannot re-parse the steps', () => {
        const onSave = vi.fn();
        open({ skill: WITH_STRUCTURE, onSave });
        fireEvent.change(screen.getByLabelText('Skill name'), { target: { value: 'Renamed' } });
        fireEvent.click(screen.getByRole('button', { name: 'Update skill' }));
        const [form] = onSave.mock.calls.at(-1);
        expect(form.name).toBe('Renamed');
        expect(form).not.toHaveProperty('workflow');
        expect(form).not.toHaveProperty('rules');
        expect(form).not.toHaveProperty('examples');
    });

    it('sends the workflow the moment it is actually edited — the warned-about case', () => {
        const onSave = vi.fn();
        open({ skill: WITH_STRUCTURE, onSave });
        fireEvent.click(screen.getByRole('button', { name: 'Workflow' }));
        fireEvent.change(screen.getByLabelText('Workflow'), { target: { value: '1. Fetch it twice.' } });
        fireEvent.click(screen.getByRole('button', { name: 'Update skill' }));
        const [form] = onSave.mock.calls.at(-1);
        expect(form.workflow).toBe('1. Fetch it twice.');
        expect(form).not.toHaveProperty('rules');
    });

    it('re-typing the same text is not an edit — a caret in the box costs nothing', () => {
        const onSave = vi.fn();
        open({ skill: WITH_STRUCTURE, onSave });
        fireEvent.click(screen.getByRole('button', { name: 'Workflow' }));
        fireEvent.change(screen.getByLabelText('Workflow'), { target: { value: '1. Fetch the quote!' } });
        fireEvent.change(screen.getByLabelText('Workflow'), { target: { value: '1. Fetch the quote.' } });
        fireEvent.click(screen.getByRole('button', { name: 'Update skill' }));
        expect(onSave.mock.calls.at(-1)[0]).not.toHaveProperty('workflow');
    });

    it('a NEW skill still sends every text field — there is no structure to protect', () => {
        const onSave = vi.fn();
        open({ onSave });
        fireEvent.change(screen.getByLabelText('Skill name'), { target: { value: 'Fresh' } });
        fireEvent.click(screen.getByRole('button', { name: 'Create skill' }));
        const [form] = onSave.mock.calls.at(-1);
        expect(Object.keys(form).sort()).toEqual([
            'description', 'dynamicActivation', 'examples', 'icon', 'instructions',
            'isShared', 'name', 'rules', 'sharedGroups', 'workflow',
        ]);
    });

    it('refuses to save a nameless skill', () => {
        const onSave = vi.fn();
        open({ onSave });
        fireEvent.click(screen.getByRole('button', { name: 'Create skill' }));
        expect(onSave).not.toHaveBeenCalled();
    });

    it('caps the instructions field rather than letting the server refuse the save', () => {
        open();
        const field = screen.getByLabelText('Instructions');
        fireEvent.change(field, { target: { value: 'x'.repeat(4001) } });
        expect(field.value).toBe('');
        fireEvent.change(field, { target: { value: 'x'.repeat(4000) } });
        expect(field.value).toHaveLength(4000);
    });
});
