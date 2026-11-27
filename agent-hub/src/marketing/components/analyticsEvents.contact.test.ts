import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { startAnalyticsEvents } from './analyticsEvents';

// contact_click: a click on a mailto: or tel: link. It says which kind and in
// which block, never the address or the number. Before it existed those links
// fell through to outbound_click, which sent the address along in `href`.

let stop: (() => void) | undefined;
let tracked: { name: string; data: Record<string, unknown> }[];

function clickFirst(html: string) {
    document.body.innerHTML = html;
    document.querySelector('a')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

describe('analyticsEvents contact_click', () => {
    beforeEach(() => {
        tracked = [];
        window.umami = { track: (name, data) => { tracked.push({ name, data: data ?? {} }); } };
        stop = startAnalyticsEvents();
    });

    afterEach(() => {
        stop?.();
        delete window.umami;
        document.body.innerHTML = '';
    });

    it('tracks a mailto link as contact_click kind mail, with its block', () => {
        clickFirst('<section data-cms-block-id="blk_c" data-cms-block-type="content"><a href="mailto:sales@example.com?subject=Hi">Mail us</a></section>');
        expect(tracked).toEqual([{
            name: 'contact_click',
            data: { kind: 'mail', block: 'blk_c', blockType: 'content' },
        }]);
    });

    it('tracks a tel link as contact_click kind phone', () => {
        clickFirst('<a class="btn" href="tel:+31201234567">Call</a>');
        expect(tracked).toEqual([{ name: 'contact_click', data: { kind: 'phone' } }]);
    });

    it('never sends the link text: a mailto link can show a person\'s name', () => {
        clickFirst('<section data-cms-block-id="blk_t" data-cms-block-type="team"><a href="mailto:jan@example.com">Jan de Vries</a></section>');
        expect(tracked).toEqual([{ name: 'contact_click', data: { kind: 'mail', block: 'blk_t', blockType: 'team' } }]);
        expect(JSON.stringify(tracked)).not.toContain('Vries');
    });

    it('matches the scheme case-insensitively and with leading spaces', () => {
        clickFirst('<a href="  MAILTO:a@example.com">Mail</a>');
        expect(tracked[0]).toMatchObject({ name: 'contact_click', data: { kind: 'mail' } });
    });

    it('never sends the address or number, not even as the label', () => {
        clickFirst('<section data-cms-block-id="blk_f" data-cms-block-type="footer"><a href="mailto:jan@example.com">jan@example.com</a></section>');
        clickFirst('<a href="tel:0201234567">020 123 4567</a>');
        const sent = JSON.stringify(tracked);
        expect(sent).not.toContain('example.com');
        expect(sent).not.toContain('jan');
        expect(sent).not.toContain('1234567');
        expect(sent).not.toContain('123 4567');
        expect(tracked.map((t) => t.name)).toEqual(['contact_click', 'contact_click']);
    });

    it('does not also count the click as cta_click or outbound_click', () => {
        clickFirst('<section data-cms-block-id="blk_h" data-cms-block-type="hero"><a class="btn btn-primary" href="mailto:x@example.com">Email sales</a></section>');
        expect(tracked.map((t) => t.name)).toEqual(['contact_click']);
    });
});
