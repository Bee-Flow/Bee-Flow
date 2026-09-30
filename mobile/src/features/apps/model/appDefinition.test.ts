/**
 * What the phone keeps, drops, and admits to dropping.
 *
 * Every case here is a defect that reached a real screen, not a spec check.
 */

import { planScreen } from './appDefinition';
import type { AppDefinition, AppNode } from './types';


const node = (type: string, extra: Partial<AppNode> = {}): AppNode => ({
    id: `${type}-1`,
    type,
    ...extra,
});

const app = (children: AppNode[]): AppDefinition =>
    ({
        homeScreenId: 's1',
        screens: [{ id: 's1', sections: [{ id: 'sec1', children }] }],
        actions: {},
    }) as unknown as AppDefinition;

describe('page_header', () => {
    it('is drawn, and its action area still works', () => {
        // 12 of the 12 shipped templates open with one, 81 times between them.
        // It was going into the "needs a browser" banner while `heading`,
        // which 4 templates use, was drawn.
        const plan = planScreen(
            app([
                node('page_header', {
                    props: { title: 'Tickets', subtitle: 'Open items' },
                    children: [node('heading', { props: { text: 'child' } })],
                }),
            ]),
        );
        expect(plan.blocks[0]).toMatchObject({
            kind: 'page_header',
            title: 'Tickets',
            subtitle: 'Open items',
            divider: true,
        });
        expect(plan.blocks[1]).toMatchObject({ kind: 'heading', text: 'child' });
        expect(plan.unsupported).toEqual([]);
    });
});

describe('modal', () => {
    it('does not spill its contents onto the page', () => {
        // The walker used to name the modal AND render its children inline, so
        // dialog bodies (44 across the shipped templates) were always visible.
        const plan = planScreen(
            app([
                node('modal', {
                    children: [node('text', { props: { text: 'secret' } })],
                }),
            ]),
        );
        expect(plan.blocks).toEqual([]);
        expect(plan.unsupported).toEqual(['modal']);
    });
});

describe('spacer', () => {
    it('is empty space, not a visible rule', () => {
        const plan = planScreen(app([node('spacer', { props: { steps: 2 } })]));
        expect(plan.blocks[0]).toMatchObject({ kind: 'spacer', steps: 2 });
    });
});

describe('role gating', () => {
    const gated = app([
        node('heading', { props: { text: 'everyone' } }),
        node('heading', { id: 'admin-only', props: { text: 'admins' }, visibleToRoles: ['admin'] }),
    ]);

    it('hides a node the viewer has no role for', () => {
        const plan = planScreen(gated, null, 'agent');
        expect(plan.blocks.map((b) => b.id)).toEqual(['heading-1']);
        // Not reported: naming it would tell the viewer that something exists
        // which they are not allowed to know about.
        expect(plan.unsupported).toEqual([]);
    });

    it('shows it to the role named', () => {
        const plan = planScreen(gated, null, 'admin');
        expect(plan.blocks.map((b) => b.id)).toEqual(['heading-1', 'admin-only']);
    });

    it('treats a null role the way the server does — open gates only', () => {
        // studioAppRunGate.roleAllows deliberately deviates from the web
        // preview here: a viewer with no mapped role must not clear a gate.
        const plan = planScreen(gated, null, null);
        expect(plan.blocks.map((b) => b.id)).toEqual(['heading-1']);
    });

    it('an empty gate is open to everyone', () => {
        const plan = planScreen(
            app([node('heading', { props: { text: 'x' }, visibleToRoles: [] })]),
            null,
            null,
        );
        expect(plan.blocks).toHaveLength(1);
    });
});

describe('formula gates the phone cannot evaluate', () => {
    it('reports a conditional node instead of guessing it visible', () => {
        // On the web visibleWhen WINS over `visible`, so drawing it anyway put
        // conditioned-off fields on screen and submitted their values.
        const plan = planScreen(
            app([node('text', { props: { text: 'maybe' }, visibleWhen: { kind: 'expr' } })]),
        );
        expect(plan.blocks).toEqual([]);
        expect(plan.unsupported).toEqual(['text']);
    });
});

describe('content inside a form', () => {
    it('is reported rather than vanishing', () => {
        // A form block holds inputs only, so a heading or paragraph inside one
        // cannot be drawn — and it used to disappear with no banner at all.
        // `form` is in 12 of 12 templates and `text` appears 464 times.
        const plan = planScreen(
            app([
                node('form', {
                    props: { name: 'f' },
                    children: [
                        node('text', { props: { text: 'please fill this in' } }),
                        node('input_text', { props: { name: 'who', label: 'Who' } }),
                    ],
                }),
            ]),
        );
        const form = plan.blocks.find((b) => b.kind === 'form');
        expect(form).toBeTruthy();
        expect(plan.unsupported).toContain('text');
    });

    it('still names an input it cannot draw', () => {
        const plan = planScreen(
            app([
                node('form', {
                    props: { name: 'f' },
                    children: [node('input_richtext', { props: { name: 'body' } })],
                }),
            ]),
        );
        expect(plan.unsupported).toContain('input_richtext');
    });
});
