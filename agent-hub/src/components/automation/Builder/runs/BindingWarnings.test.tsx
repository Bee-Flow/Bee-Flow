import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach } from 'vitest';
import BindingWarnings from './BindingWarnings';
import { bindingWarningsOf } from './bindingMisses';

const SENTENCE = 'input "to" read steps.read.output.contact.email, but steps.read.output.contact has no "email"';
const MISS = {
    field: 'to', kind: 'ref', path: 'steps.read.output.contact.email', reason: 'missing',
    at: 'steps.read.output.contact', found: 'record', missing: 'email', count: 3, description: SENTENCE,
};
const labels = new Map([['read', 'Read the purchasing inbox']]);

beforeEach(() => cleanup());

describe('Mappings that found nothing', () => {
    it('renders nothing when every mapping found something', () => {
        const { container } = render(<BindingWarnings warnings={[]} />);
        expect(container.firstChild).toBeNull();
    });

    it('one line per input: which input, which field, why, and how often', () => {
        render(<BindingWarnings warnings={bindingWarningsOf([MISS])} labelById={labels} />);
        expect(screen.getByText('Mappings that found nothing')).toBeTruthy();
        const line = screen.getByRole('button', { name: /To/ });
        expect(line.textContent).toContain('Read the purchasing inbox ▸ Contact ▸ Email');
        expect(line.textContent).toContain('nothing there');
        expect(line.textContent).toContain('3×');
        // No path syntax on the line itself.
        expect(line.textContent).not.toContain('steps.read');
        // The server's sentence is on hover.
        expect(line.getAttribute('title')).toBe(SENTENCE);
    });

    it('opens to the server sentence and the exact path', async () => {
        const user = userEvent.setup();
        render(<BindingWarnings warnings={bindingWarningsOf([MISS])} labelById={labels} />);
        expect(screen.queryByText('steps.read.output.contact.email')).toBeNull();
        const line = screen.getByRole('button', { name: /To/ });
        expect(line.getAttribute('aria-expanded')).toBe('false');
        await user.click(line);
        expect(line.getAttribute('aria-expanded')).toBe('true');
        expect(screen.getByText(SENTENCE)).toBeTruthy();
        expect(screen.getByText('steps.read.output.contact.email')).toBeTruthy();
        await user.click(line);
        expect(screen.queryByText(SENTENCE)).toBeNull();
    });

    it('a long list shows the first few and the rest on request', async () => {
        const user = userEvent.setup();
        const many = bindingWarningsOf(Array.from({ length: 8 }, (_, i) => ({ ...MISS, field: `field_${i}`, count: 1 })));
        render(<BindingWarnings warnings={many} labelById={labels} />);
        expect(screen.getAllByRole('listitem')).toHaveLength(5);
        await user.click(screen.getByRole('button', { name: 'Show 3 more' }));
        expect(screen.getAllByRole('listitem')).toHaveLength(8);
    });
});

describe('rule misses (V1, P4)', () => {
    const RULE = { kind: 'rule', path: 'item.atachments', reason: 'missing', count: 4 };
    const RULE_HINT = 'A rule read a field that none of the items have, so it matched nothing. Pick the field again in the Condition.';
    const MAPPING_HINT = /These inputs were left empty/;

    it('a rule miss reads "The rule · Each item ▸ Atachments" with the rule hint', () => {
        render(<BindingWarnings warnings={bindingWarningsOf([RULE])} labelById={labels} />);
        const line = screen.getByRole('button', { name: /The rule/ });
        expect(line.textContent).toContain('Each item ▸ Atachments');
        expect(line.textContent).toContain('4×');
        expect(screen.getByText(RULE_HINT)).toBeTruthy();
        expect(screen.queryByText(MAPPING_HINT)).toBeNull();
    });

    it('a mix of rule and mapping misses keeps the mapping hint', () => {
        render(<BindingWarnings warnings={bindingWarningsOf([RULE, MISS])} labelById={labels} />);
        expect(screen.getByText(MAPPING_HINT)).toBeTruthy();
        expect(screen.queryByText(RULE_HINT)).toBeNull();
    });
});
