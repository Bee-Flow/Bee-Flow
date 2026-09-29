import { render, screen, cleanup } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import VariableTree, { friendlyBasePath } from './VariableTree';

/**
 * The caption beside a group's name. It used to be the bare base path with the
 * step id stripped (`steps.ai_87e358.output` → `output`) — better than the id,
 * but still a path fragment in monospace next to a human step name. The picker
 * shows the same caption, so this helper is the one place both read.
 *
 * The raw path is NOT dropped anywhere: both rows carry it in a `title`. What
 * is dropped is a caption that only repeats the group's own label.
 */
describe('friendlyBasePath', () => {
    it('reads a step output as a word, id gone', () => {
        expect(friendlyBasePath('steps.ai_87e358.output')).toBe('Output');
        expect(friendlyBasePath('steps.act_4d3307a.output')).toBe('Output');
    });

    it('keeps a trigger or loop base and says it in words', () => {
        expect(friendlyBasePath('trigger.output')).toBe('Trigger output');
        expect(friendlyBasePath('loop.klant_regel')).toBe('Loop klant regel');
    });

    it('returns nothing when the caption would stutter the label', () => {
        expect(friendlyBasePath('trigger', 'Trigger')).toBe('');
        expect(friendlyBasePath('currentUser', 'Current user')).toBe('');
        // Only an exact repeat is dropped — a real hint survives.
        expect(friendlyBasePath('steps.s1.output', 'Gmail search')).toBe('Output');
    });

    it('survives an empty or missing base path', () => {
        expect(friendlyBasePath('')).toBe('');
        expect(friendlyBasePath(null)).toBe('');
    });
});

/**
 * The helper above is only half the promise. What the doctrine actually says is
 * "the card shows the sentence, the tooltip keeps the exact value", so the row
 * itself has to be pinned: dropping a caption must never be the moment the base
 * path leaves the DOM. It nearly is — for a trigger the caption IS the only
 * place the tree ever printed `trigger`, and it is now dropped as a stutter.
 */
describe('VariableTree — the group row keeps its base path', () => {
    beforeEach(cleanup);

    const groupRowOf = (label) => screen.getByText(label).closest('[role="button"]');

    it('says a step output in words and keeps the id-bearing path on the row', () => {
        render(
            <VariableTree
                groups={[{
                    id: 'ai_87e358',
                    label: 'Read the figures',
                    kind: 'ai_step',
                    basePath: 'steps.ai_87e358.output',
                    fields: [{ key: 'total', path: 'steps.ai_87e358.output.total', sample: 201 }],
                }]}
                onInsert={() => {}}
            />,
        );
        expect(screen.getByText('Output')).toBeTruthy();
        // The cryptic id is off the screen…
        expect(screen.queryByText(/ai_87e358/)).toBeNull();
        // …and still one hover away, twice: on the caption and on the drag row.
        expect(screen.getByText('Output').getAttribute('title')).toBe('steps.ai_87e358.output');
        expect(groupRowOf('Read the figures').getAttribute('title')).toContain('steps.ai_87e358.output');
    });

    it('drops the stuttering caption without dropping the path with it', () => {
        render(
            <VariableTree
                groups={[{
                    id: 'trg',
                    label: 'Trigger',
                    kind: 'trigger',
                    basePath: 'trigger',
                    fields: [{ key: 'subject', path: 'trigger.subject', sample: 'Hoi' }],
                }]}
                onInsert={() => {}}
            />,
        );
        // No "Trigger · trigger" — the caption is gone as visible text…
        expect(screen.queryByText('trigger')).toBeNull();
        // …but `trigger` is still the string the row hands a power user, which
        // is the whole reason dropping the caption is allowed at all.
        expect(groupRowOf('Trigger').getAttribute('title')).toContain('trigger');
    });
});
