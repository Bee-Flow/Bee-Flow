import { act } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/test/appScreenRender';

const ACTION = 'act_pick000001';
const BLOCK = {
    template: '<p class="hello">Hello {{ who }}</p><button data-emit="pick" data-value="who">Pick</button>',
    css: '.hello{color:var(--bf-primary)}',
    inputs: { who: { kind: 'static', value: 'Ada' } },
    events: { pick: ACTION },
};
const node = (block: unknown = BLOCK, style: Record<string, unknown> = {}) => ({ id: 'cmp_blk000001', type: 'custom_block', visible: true, style: { span: 12, ...style }, props: { block } });
const ACTIONS = { [ACTION]: { kind: 'toast', message: 'picked' } };

const frameOf = (container: HTMLElement) => container.querySelector('iframe') as HTMLIFrameElement;

/** jsdom loads no frame document: write the body the host built into the frame and say it loaded. */
async function load(frame: HTMLIFrameElement) {
    const doc = frame.contentDocument as Document;
    const srcdoc = frame.getAttribute('srcdoc') || '';
    doc.body.innerHTML = srcdoc.slice(srcdoc.indexOf('<body>') + 6, srcdoc.lastIndexOf('</body>'));
    await act(async () => { frame.dispatchEvent(new Event('load')); });
    return doc;
}

describe('AppCustomBlock', () => {
    it('draws the template in a frame that allows no script, with the inputs resolved', () => {
        const { container } = renderScreen([node()], {}, ACTIONS);
        const frame = frameOf(container);
        expect(frame.getAttribute('sandbox')).toBe('allow-same-origin');
        expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
        const srcdoc = frame.getAttribute('srcdoc') || '';
        expect(srcdoc).toContain('<p class="hello">Hello Ada</p>');
        expect(srcdoc).toContain("default-src 'none'");
        expect(container.querySelector('.bfa-custom_block__root')).not.toBeNull();
        expect(container.querySelector('.bfa-custom_block__frame')).toBe(frame);
    });

    it('runs the wired action with the control\'s value when the control is clicked', async () => {
        const runAction = vi.fn();
        const { container } = renderScreen([node()], { runAction }, ACTIONS);
        const doc = await load(frameOf(container));
        const button = doc.querySelector('button') as HTMLButtonElement;
        expect(button.getAttribute('data-bf-emit')).toBe('0');
        await act(async () => { button.click(); });
        expect(runAction).toHaveBeenCalledTimes(1);
        expect(runAction.mock.calls[0][0]).toBe(ACTION);
        expect(runAction.mock.calls[0][1]).toMatchObject({ value: 'Ada' });
    });

    it('ignores a control number the host did not hand out', async () => {
        const runAction = vi.fn();
        const { container } = renderScreen([node()], { runAction }, ACTIONS);
        const doc = await load(frameOf(container));
        doc.body.innerHTML = '<button data-bf-emit="7">x</button><button data-bf-emit="pick">y</button><button>z</button>';
        await act(async () => { doc.querySelectorAll('button').forEach((b) => b.click()); });
        expect(runAction).not.toHaveBeenCalled();
    });

    it('in the editor no control is wired and a shield takes the click', async () => {
        const runAction = vi.fn();
        const { container } = renderScreen([node()], { mode: 'edit', runAction }, ACTIONS);
        const frame = frameOf(container);
        expect(frame.getAttribute('srcdoc')).not.toContain('data-bf-emit');
        expect(container.querySelector('[data-custom-block-shield]')).not.toBeNull();
        const doc = await load(frame);
        await act(async () => { (doc.querySelector('button') as HTMLButtonElement).click(); });
        expect(runAction).not.toHaveBeenCalled();
    });

    it('an empty block is a notice in the editor and nothing in a running app', () => {
        const edit = renderScreen([node({ template: '' })], { mode: 'edit' });
        expect(edit.container.querySelector('.bfa-custom_block__notice')).not.toBeNull();
        expect(edit.container.querySelector('iframe')).toBeNull();
        edit.unmount();
        const run = renderScreen([node({ template: '' })]);
        expect(run.container.querySelector('iframe')).toBeNull();
        expect(run.container.querySelector('.bfa-custom_block__notice')).toBeNull();
    });

    it('a block that never passed the server is held to the same lists', () => {
        const { container } = renderScreen([node({ template: '<p onclick="x()">a</p><link rel="prerender" href="http://leak.example/"><script>x</script>', css: '@import url(http://leak.example/a.css);' })]);
        const srcdoc = (frameOf(container).getAttribute('srcdoc') || '').toLowerCase();
        expect(srcdoc).not.toContain('leak.example');
        expect(srcdoc).not.toContain('onclick');
        expect(srcdoc).not.toContain('<link');
        expect(srcdoc).not.toContain('<script');
    });
});
