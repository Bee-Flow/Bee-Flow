import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import VariablePicker from './VariablePicker';

/**
 * The picker is the control that exists so nobody has to know a path — and it
 * led with one: the group header printed `steps.act_4d3307a.output` in
 * monospace and every leaf printed its raw key (`from_email`, `klant_naam`).
 * A non-technical author reading that concludes they are looking at code.
 *
 * What these tests pin is the pair, not just the humanising: the card shows the
 * sentence, the title keeps the exact value. Deleting the raw path would cap the
 * power user who has to type it into an expression, which is the other half of
 * the complaint.
 */
const GROUPS = [
    {
        id: 'act_4d3307a',
        label: 'Gmail search',
        kind: 'integration_action',
        basePath: 'steps.act_4d3307a.output',
        fields: [
            { key: 'from_email', path: 'steps.act_4d3307a.output.from_email', sample: 'a@b.nl' },
            { key: 'klant_naam', path: 'steps.act_4d3307a.output.klant_naam', sample: 'Jansen' },
            { key: 'pdf', path: 'steps.act_4d3307a.output.pdf', sample: 'f.pdf' },
            {
                key: 'org',
                path: 'steps.act_4d3307a.output.org',
                sample: { klant_id: 'o1' },
                children: [{ key: 'klant_id', path: 'steps.act_4d3307a.output.org.klant_id', sample: 'o1' }],
            },
        ],
    },
];

function renderPicker(props = {}) {
    render(
        <VariablePicker open anchorEl={document.body} groups={GROUPS} onPick={() => {}} onClose={() => {}} {...props} />,
    );
}

/** The clickable row for a leaf — the row's title is its full dotted path. */
const leafRow = (path) => document.querySelector(`[title="${path}"]`);

describe('VariablePicker — names, not keys', () => {
    beforeEach(cleanup);

    it('shows each leaf as words', () => {
        renderPicker();
        expect(screen.getByText('From email')).toBeTruthy();
        expect(screen.getByText('Klant naam')).toBeTruthy();
        // The proper-noun table is shared with the tool-name humaniser, so an
        // acronym does not come out as "Pdf".
        expect(screen.getByText('PDF')).toBeTruthy();
        expect(screen.queryByText('from_email')).toBeNull();
        expect(screen.queryByText('klant_naam')).toBeNull();
    });

    it('keeps the exact key on the name and the full path on the row', () => {
        renderPicker();
        const name = screen.getByText('Klant naam');
        expect(name.getAttribute('title')).toBe('klant_naam');
        expect(leafRow('steps.act_4d3307a.output.klant_naam')).toBeTruthy();
    });

    it('says the group in words and demotes its base path', () => {
        renderPicker();
        // The step id never reaches the screen…
        expect(document.body.textContent).not.toContain('act_4d3307a');
        expect(screen.getByText('Output')).toBeTruthy();
        // …but it is still one hover away, on the caption and on the header.
        expect(screen.getByText('Output').getAttribute('title')).toBe('steps.act_4d3307a.output');
        const header = screen.getByText('Gmail search').closest('button');
        expect(header.getAttribute('title')).toBe('steps.act_4d3307a.output');
    });

    it('drops a caption that would only repeat the group name', () => {
        cleanup();
        render(
            <VariablePicker
                open
                anchorEl={document.body}
                groups={[{ id: 'cu', label: 'Current user', basePath: 'currentUser', fields: [] }]}
                onPick={() => {}}
                onClose={() => {}}
            />,
        );
        // "Current user · Current user" is a stutter, not a hint. Once only —
        // getByText throws on a second match.
        expect(screen.getByText('Current user')).toBeTruthy();
        expect(screen.getByText('Current user').closest('button').getAttribute('title')).toBe('currentUser');
    });

    it('humanises nested children too', () => {
        renderPicker();
        fireEvent.click(leafRow('steps.act_4d3307a.output.org').querySelector('[data-expand-btn]'));
        expect(screen.getByText('Klant id')).toBeTruthy();
        expect(screen.getByText('Klant id').getAttribute('title')).toBe('klant_id');
    });
});
