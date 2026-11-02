/**
 * Quoted history is hidden behind a toggle, like Gmail and Outlook do.
 *
 * Run: cd agent-hub && npx vitest run src/components/support/emailQuoteCollapse.test.ts
 */
import { describe, it, expect } from 'vitest';
import { collapseQuotedHistory, findQuoteStart, isQuoteToggle } from './emailQuoteCollapse';

const LABELS = { show: 'Show', hide: 'Hide' };

function docOf(body: string): Document {
    return new DOMParser().parseFromString(`<!DOCTYPE html><html><head></head><body>${body}</body></html>`, 'text/html');
}

const isHidden = (el: Element | null) => (el as HTMLElement | null)?.style.display === 'none';
const visibleText = (doc: Document) => Array.from(doc.body.querySelectorAll('p,div,blockquote,span,td'))
    .filter((e) => !isHidden(e) && !e.closest('[data-bf-quote-hidden]') && e.children.length === 0)
    .map((e) => e.textContent?.trim()).filter(Boolean);

const FIXTURES: Record<string, string> = {
    gmail: '<div dir="ltr"><p id="new">Nieuw antwoord</p></div><br><div class="gmail_quote gmail_quote_container"><div dir="ltr" class="gmail_attr">Op ma schreef X:</div><blockquote class="gmail_quote"><p id="old">Oud bericht</p></blockquote></div><p id="after">Na de quote</p>',
    outlookWeb: '<p id="new">Nieuw antwoord</p><div id="appendonsend"></div><hr style="display:inline-block;width:98%"><div id="divRplyFwdMsg"><b>Van:</b> X</div><div><p id="old">Oud bericht</p></div>',
    outlookDesktop: '<div class="WordSection1"><p id="new">Nieuw antwoord</p><div><div style="border:none;border-top:solid #E1E1E1 1.0pt;padding:3.0pt 0in 0in 0in"><p><b>Van:</b> X<br><b>Verzonden:</b> maandag</p></div></div><p id="old">Oud bericht</p></div>',
    apple: '<div id="new">Nieuw antwoord</div><div><br><blockquote type="cite"><div id="old">Oud bericht</div></blockquote></div>',
};

describe('collapseQuotedHistory', () => {
    for (const [name, html] of Object.entries(FIXTURES)) {
        it(`hides the quote and everything after it (${name}), keeps the new text`, () => {
            const doc = docOf(html);
            const ctl = collapseQuotedHistory(doc, LABELS);
            expect(ctl).not.toBeNull();
            const visible = visibleText(doc);
            expect(visible).toContain('Nieuw antwoord');
            expect(visible).not.toContain('Oud bericht');
            expect(visible).not.toContain('Na de quote');
            const btn = doc.querySelector('[data-bf-quote-toggle]')!;
            expect(btn.textContent).toBe('··· Show');
            expect(isQuoteToggle(btn)).toBe(true);
        });
    }

    it('also hides what follows the quote in a parent (Gmail footer)', () => {
        const doc = docOf(FIXTURES.gmail);
        collapseQuotedHistory(doc, LABELS);
        expect(isHidden(doc.getElementById('after'))).toBe(true);
        expect(isHidden(doc.getElementById('new'))).toBe(false);
    });

    it('wraps loose text after the quote so it hides too', () => {
        const doc = docOf('<div><p>Nieuw</p><div class="gmail_quote">oud</div>los staartje</div>');
        collapseQuotedHistory(doc, LABELS);
        const span = Array.from(doc.body.querySelectorAll('span')).find((s) => s.textContent === 'los staartje');
        expect(isHidden(span!)).toBe(true);
    });

    it('does nothing when there is no marker', () => {
        const doc = docOf('<p>Gewoon een mail</p>');
        expect(findQuoteStart(doc)).toBeNull();
        expect(collapseQuotedHistory(doc, LABELS)).toBeNull();
        expect(doc.querySelector('[data-bf-quote-toggle]')).toBeNull();
    });

    it('does not collapse a bare forward or a mail that is only a quote', () => {
        const only = docOf('<div class="gmail_quote"><p>Alleen quote</p></div>');
        expect(collapseQuotedHistory(only, LABELS)).toBeNull();
        expect(isHidden(only.querySelector('.gmail_quote'))).toBe(false);
        const fwd = docOf('<div><br></div><blockquote type="cite"><p>Doorgestuurd</p></blockquote>');
        expect(collapseQuotedHistory(fwd, LABELS)).toBeNull();
    });

    it('toggle restores, and keeps an inline display the mail had', () => {
        const doc = docOf('<p>Nieuw</p><div class="gmail_quote" style="display:block"><p id="old">Oud</p></div>');
        const ctl = collapseQuotedHistory(doc, LABELS)!;
        const quote = doc.querySelector('.gmail_quote') as HTMLElement;
        expect(quote.style.display).toBe('none');
        ctl.toggle();
        expect(ctl.isExpanded()).toBe(true);
        expect(quote.style.display).toBe('block');
        expect(quote.hasAttribute('data-bf-quote-hidden')).toBe(false);
        expect(doc.querySelector('[data-bf-quote-toggle]')!.textContent).toBe('··· Hide');
        ctl.toggle();
        expect(quote.style.display).toBe('none');
        expect(doc.querySelector('[data-bf-quote-toggle]')!.textContent).toBe('··· Show');
    });

    it('restores an element that had no inline display to none at all', () => {
        const doc = docOf('<p>Nieuw</p><blockquote type="cite">Oud</blockquote>');
        const ctl = collapseQuotedHistory(doc, LABELS)!;
        ctl.toggle();
        expect((doc.querySelector('blockquote') as HTMLElement).getAttribute('style') || '').not.toContain('display');
    });
});
