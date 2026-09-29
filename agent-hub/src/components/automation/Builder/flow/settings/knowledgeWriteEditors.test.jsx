// The knowledge_write node's editor and card.
//
// The commit that added them shipped no client test at all — including for the
// extract→patch round trip, which is the exact class of bug the SAME commit had
// to fix for `datatable` (the Iteration toggle rendered, round-tripped through
// nothing, and was gone on the next open).
//
// So that round trip is the first thing here.

import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import KnowledgeWriteFields from './knowledgeWriteEditors';
import { extractFormState, buildPatch } from './formState';
import { knowledgeWriteSummary } from '../nodeSummaries';

const STEP = {
    id: 'w1', type: 'knowledge_write',
    knowledgeBaseId: 'kb_1',
    title: '{{steps.a.output.title}}',
    content: '{{steps.a.output.text}}',
    sourceUri: 'ticket:{{trigger.output.id}}',
};

const CATALOG = {
    knowledgeBases: [
        { id: 'kb_1', name: 'Handbook', canWrite: true, scope: 'org' },
        { id: 'kb_ro', name: 'Read only', canWrite: false, scope: 'org' },
    ],
    knowledgeWriteStrategies: [
        { value: 'skip', label: 'Keep what is there', blurb: 'Leave it alone.' },
        { value: 'merge', label: 'Merge into one', blurb: 'Combine them.' },
    ],
};

function setup(over = {}) {
    const draft = { ...extractFormState({ ...STEP, ...over }) };
    const set = vi.fn((k, v) => { draft[k] = v; });
    render(<KnowledgeWriteFields draft={draft} set={set} groups={[]} catalog={CATALOG} />);
    return { draft, set };
}

describe('the knowledge_write editor', () => {
    it('offers the bases the author may write to, and DISABLES the ones they may not', () => {
        // A picker that silently omits what you were looking for reads as a bug;
        // one that offers a base the save then refuses teaches you to build
        // something invalid. Disabled-with-a-reason is the only honest option.
        setup();
        const writable = screen.getByRole('option', { name: /Handbook/ });
        const readonly = screen.getByRole('option', { name: /Read only/ });
        expect(writable.disabled).toBe(false);
        expect(readonly.disabled).toBe(true);
        expect(readonly.textContent).toMatch(/only read this one/i);
    });

    it('warns that a write with no source reference repeats every run', () => {
        setup({ sourceUri: '' });
        expect(screen.getByText(/NEW document every time it runs/i)).toBeTruthy();
    });

    it('says nothing about repeating once a source reference is set', () => {
        setup();
        expect(screen.queryByText(/NEW document every time/i)).toBeNull();
    });

    it('an empty base list explains itself instead of rendering a blank dropdown', () => {
        const draft = extractFormState(STEP);
        render(<KnowledgeWriteFields draft={draft} set={() => {}} groups={[]} catalog={{ knowledgeBases: [] }} />);
        expect(screen.getByText(/No knowledge bases yet/i)).toBeTruthy();
    });
});

describe('the form round trip', () => {
    it('carries every field the runner reads, both ways', () => {
        const draft = extractFormState(STEP);
        expect(draft.knowledgeBaseId).toBe('kb_1');
        expect(draft.content).toBe('{{steps.a.output.text}}');
        expect(draft.sourceUri).toBe('ticket:{{trigger.output.id}}');
        // Unchanged draft -> none of THIS step's fields in the patch: the form
        // must not rewrite what it merely displayed. (`label`/`icon` land in
        // every type's patch from the shared base state; not our business.)
        const patch = buildPatch(STEP, draft);
        for (const k of ['knowledgeBaseId', 'title', 'content', 'sourceUri', 'nearDuplicateStrategy']) {
            expect(patch, `${k} was rewritten by a no-op open/save`).not.toHaveProperty(k);
        }
    });

    it('round-trips the Iteration toggle — the datatable bug, on this step', () => {
        // datatable rendered this control and round-tripped it through nothing,
        // so turning it on looked like it worked and was gone on the next open.
        const withLoop = { ...STEP, forEach: { overRef: 'steps.a.output.rows', itemVar: 't', maxIterations: 100 } };
        const draft = extractFormState(withLoop);
        expect(draft.forEach).toEqual(withLoop.forEach);

        const turnedOff = { ...draft, forEach: null };
        expect(buildPatch(withLoop, turnedOff).forEach).toBeNull();

        const turnedOn = { ...extractFormState(STEP), forEach: { overRef: 'steps.a.output.rows', itemVar: 't' } };
        expect(buildPatch(STEP, turnedOn).forEach).toMatchObject({ overRef: 'steps.a.output.rows', itemVar: 't' });
    });

    it("the default near-duplicate strategy stays OFF the step", () => {
        // So a form-saved step is the same shape as an AI-built one.
        const draft = { ...extractFormState(STEP), nearDuplicateStrategy: 'skip' };
        expect(buildPatch(STEP, draft).nearDuplicateStrategy).toBeUndefined();
        const merged = { ...extractFormState(STEP), nearDuplicateStrategy: 'merge' };
        expect(buildPatch(STEP, merged).nearDuplicateStrategy).toBe('merge');
    });
});

describe('the card summary', () => {
    it('names the base once the catalog knows it', () => {
        expect(knowledgeWriteSummary(STEP, { kbNameById: { kb_1: 'Handbook' } })).toBe('Save into Handbook');
    });

    it('says something true before the catalog arrives', () => {
        expect(knowledgeWriteSummary(STEP, {})).toBe('Save into a knowledge base');
    });

    it('asks for the two things without which the step does nothing', () => {
        expect(knowledgeWriteSummary({ ...STEP, knowledgeBaseId: '' }, {})).toEqual({ muted: 'no knowledge base picked yet' });
        expect(knowledgeWriteSummary({ ...STEP, content: '   ' }, { kbNameById: { kb_1: 'Handbook' } }))
            .toEqual({ muted: 'nothing to write into Handbook yet' });
    });
});
