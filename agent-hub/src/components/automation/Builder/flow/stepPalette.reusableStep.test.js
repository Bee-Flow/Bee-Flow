import { describe, it, expect } from 'vitest';
import { blockItem, buildSearchResults, groupBlocksByCategory } from './stepPalette';

/**
 * A reusable Step is the only thing in the palette that a COLLEAGUE wrote, and
 * it was the only entry that never said what it does: its whole line was
 * "2 in · 3 out". An arity describes a function signature, not a purpose, so
 * the most in-house group in the menu was also its least legible one — while
 * the server has been shipping each Step's own `description`
 * (server/routes/automation/catalog.js) the entire time.
 *
 * What the Step is FOR leads; the counts stay, demoted to the tail of the same
 * line, because "does this take the three things I have?" is still a real
 * question at the moment of picking.
 */

const step = (extra) => ({ id: 'b1', title: 'Send Invoice', params: [{}, {}], outputFields: [{}, {}, {}], ...extra });

describe('blockItem — the Step describes itself', () => {
    it('leads with the author\'s description and keeps the counts behind it', () => {
        const item = blockItem(step({ description: 'Mails the invoice to the customer.' }));
        expect(item.desc).toBe('Mails the invoice to the customer. · 2 inputs · 3 outputs');
        // The arity is never the headline any more.
        expect(item.desc.startsWith('2')).toBe(false);
    });

    it('still answers with the counts when nobody wrote a description', () => {
        expect(blockItem(step()).desc).toBe('2 inputs · 3 outputs');
        expect(blockItem({ id: 'b2', title: 'Solo', params: [{}], outputFields: [{}] }).desc)
            .toBe('1 input · 1 output');
        expect(blockItem({ id: 'b3', title: 'Empty' }).desc).toBe('0 inputs · 0 outputs');
    });

    it('sanitises the description the way an app action\'s blurb is sanitised', () => {
        // A Step that an AI agent may call carries wording written AT the model.
        // uiDescription drops it — the menu is read by a person.
        const item = blockItem(step({
            description: 'Mails the invoice to the customer. Call this first to find a customer id.',
        }));
        expect(item.desc).toBe('Mails the invoice to the customer. · 2 inputs · 3 outputs');
    });

    it('says nothing new when the description is blank or missing', () => {
        expect(blockItem(step({ description: '   ' })).desc).toBe('2 inputs · 3 outputs');
        expect(blockItem(step({ description: null })).keywords.endsWith('Send Invoice')).toBe(true);
    });

    it('leaves the payload, id and icon lookup untouched', () => {
        const item = blockItem(step({ description: 'Mails the invoice.', icon: 'not_a_real_icon' }));
        expect(item.id).toBe('block_b1');
        expect(item.label).toBe('Send Invoice');
        expect(item.payload).toEqual({ kind: 'call_block', blockId: 'b1', label: 'Send Invoice', icon: 'not_a_real_icon' });
    });
});

describe('blockItem — findable by what the Step does', () => {
    const catalog = { apps: [], steps: [step({ description: 'Mails the invoice to the customer.', available: true })] };

    it('a search for the description finds the Step', () => {
        // Someone who remembers what a Step DOES but not what a colleague
        // called it had no way in: only the title was ever searchable.
        const found = buildSearchResults('customer', { catalog }).filter(r => r.payload?.kind === 'call_block');
        expect(found.map(r => r.label)).toContain('Send Invoice');
    });

    it('the description reaches the menu through the category sections too', () => {
        const sections = groupBlocksByCategory([step({ description: 'Mails the invoice.', category: 'Sales' })]);
        expect(sections[0].items[0].desc).toBe('Mails the invoice. · 2 inputs · 3 outputs');
    });
});
