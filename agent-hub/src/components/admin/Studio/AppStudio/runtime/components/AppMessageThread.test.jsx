import { render, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import AppMessageThread from './AppMessageThread';
import { RuntimeProvider, DEFAULT_RUNTIME } from '../RuntimeContext';

/**
 * The message thread is the one component that exists because a repeater cannot
 * do it: per-row appearance driven by a field. These tests pin that behaviour
 * and the sandbox invariant on HTML e-mail bodies.
 */

const MESSAGES = [
    { id: 'm1', kind: 'requester', author: 'Jan Klant', body: 'Waar blijft mijn pakket?', at: '2026-03-01T09:00:00Z', files: [{ filename: 'bon.pdf' }] },
    { id: 'm2', kind: 'agent', author: 'Ann', body: 'Onderweg!', at: '2026-03-01T09:12:00Z', files: [] },
    { id: 'm3', kind: 'system', author: null, body: 'Ticket gesloten', at: '2026-03-02T08:00:00Z', files: [] },
    { id: 'm4', kind: 'note', author: 'Ann', body: 'Klant belde ook', at: '2026-03-02T08:05:00Z', files: [] },
];

const SIDE_MAP = [
    { value: 'requester', side: 'left', tone: 'neutral' },
    { value: 'agent', side: 'right', tone: 'primary' },
    { value: 'system', side: 'center', tone: 'neutral' },
    { value: 'note', side: 'right', tone: 'warning' },
];

function node(props = {}, extra = {}) {
    return {
        id: 'cmp_mt',
        type: 'message_thread',
        props: {
            source: { kind: 'static', value: MESSAGES },
            bodyField: 'body', authorField: 'author', timestampField: 'at',
            sideField: 'kind', sideMap: SIDE_MAP,
            attachmentsField: 'files', attachmentLabelKey: 'filename',
            rowLimit: 100, emptyText: 'No messages yet.',
            ...props,
        },
        style: { span: 12 },
        ...extra,
    };
}

function renderThread(n, runtime = {}) {
    return render(
        <RuntimeProvider value={{ ...DEFAULT_RUNTIME, mode: 'run', ...runtime }}>
            <AppMessageThread node={n} />
        </RuntimeProvider>,
    );
}

describe('AppMessageThread', () => {
    it('gives each row the side and tone its sideMap entry asks for', () => {
        // This is the whole reason the component exists — four visual
        // treatments driven by one field.
        const { container } = renderThread(node());
        const bubbles = [...container.querySelectorAll('[data-app-thread-side]')];
        expect(bubbles.map((b) => b.getAttribute('data-app-thread-side')))
            .toEqual(['left', 'right', 'center', 'right']);
        expect(bubbles.map((b) => b.getAttribute('data-app-thread-tone')))
            .toEqual(['neutral', 'primary', 'neutral', 'warning']);
    });

    it('falls back to left/neutral for a value with no mapping', () => {
        const { container } = renderThread(node({ sideMap: [] }));
        const sides = [...container.querySelectorAll('[data-app-thread-side]')]
            .map((b) => b.getAttribute('data-app-thread-side'));
        expect(new Set(sides)).toEqual(new Set(['left']));
    });

    it('renders plain bodies as text and keeps their line breaks', () => {
        const { getByText } = renderThread(node());
        expect(getByText('Waar blijft mijn pakket?')).toBeTruthy();
        expect(getByText('Onderweg!')).toBeTruthy();
    });

    it('renders an HTML body in a sandboxed iframe WITHOUT allow-scripts', () => {
        // The single most important line in this file: allow-scripts +
        // allow-same-origin together would let a customer's e-mail strip its
        // own sandbox and run code inside the app.
        const { container } = renderThread(node({
            htmlField: 'html',
            source: { kind: 'static', value: [{ kind: 'requester', html: '<p>hoi</p><script>evil()</script>' }] },
        }));
        const frame = container.querySelector('iframe');
        expect(frame).toBeTruthy();
        const sandbox = frame.getAttribute('sandbox') || '';
        expect(sandbox).not.toContain('allow-scripts');
    });

    it('shows attachment chips only where there are attachments', () => {
        const { container } = renderThread(node());
        const chipGroups = container.querySelectorAll('[data-app-thread-chips="attachments"]');
        expect(chipGroups).toHaveLength(1);
        expect(chipGroups[0].textContent).toContain('bon.pdf');
    });

    it('renders citation chips when a field is bound', () => {
        const { container } = renderThread(node({
            citationsField: 'cites', citationLabelKey: 'title',
            source: { kind: 'static', value: [{ kind: 'agent', body: 'x', cites: [{ title: 'Handboek' }] }] },
        }));
        const chips = container.querySelector('[data-app-thread-chips="citations"]');
        expect(chips.textContent).toContain('Handboek');
    });

    it('keeps the TAIL when rowLimit truncates', () => {
        // Unlike a timeline, dropping the newest messages in a conversation
        // would hide exactly what the agent needs to answer.
        const many = Array.from({ length: 10 }, (_, i) => ({ kind: 'agent', body: `m${i}`, author: 'Ann' }));
        const { container, queryByText } = renderThread(node({ rowLimit: 3, source: { kind: 'static', value: many } }));
        expect(container.querySelectorAll('[data-app-thread-row]')).toHaveLength(3);
        expect(queryByText('m9')).toBeTruthy();
        expect(queryByText('m0')).toBeNull();
    });

    it('renders the empty state', () => {
        const { getByText } = renderThread(node({ source: { kind: 'static', value: [] }, emptyText: 'Nog niks.' }));
        expect(getByText('Nog niks.')).toBeTruthy();
    });

    it('fires onRowClick with the row, in run mode only', () => {
        const runAction = vi.fn();
        const { container } = renderThread(node({}, { onRowClick: 'act_1' }), { runAction, mode: 'run' });
        fireEvent.click(container.querySelectorAll('button')[0]);
        expect(runAction).toHaveBeenCalledWith('act_1', { formValues: MESSAGES[0], item: MESSAGES[0] });

        runAction.mockClear();
        const edit = renderThread(node({}, { onRowClick: 'act_1' }), { runAction, mode: 'edit' });
        expect(edit.container.querySelectorAll('button')).toHaveLength(0);
        expect(runAction).not.toHaveBeenCalled();
    });

    it('uses no purple — the house palette only', () => {
        const { container } = renderThread(node());
        expect(container.innerHTML).not.toMatch(/indigo|violet|purple/i);
    });
});

/**
 * Mail is full of bodies that are truthy and empty. Gmail sends
 * `<div dir="ltr"><br></div>` for a message whose content is an attachment or a
 * bare subject line — and on the branch that only checked truthiness, that got
 * a blank 120px white iframe (the frame's minimum) inside a coloured bubble.
 * Three of the four live messages in the app this was found in look like that.
 */
describe('an HTML body that would paint nothing', () => {
    const withBodies = (html, body) => node({
        htmlField: 'html',
        bodyField: 'body',
        source: { kind: 'static', value: [{ kind: 'requester', html, body }] },
    });

    it.each([
        ['<div dir="ltr"><br></div>', 'Gmail’s empty-body stub'],
        ['   ', 'whitespace'],
        ['<p></p><span></span>', 'tags with nothing in them'],
        ['<p>&nbsp;&nbsp;</p>', 'non-breaking spaces'],
    ])('falls back to the text body for %s', (html) => {
        const { container, getByText } = renderThread(withBodies(html, 'De echte tekst'));
        expect(container.querySelector('iframe')).toBeNull();
        expect(getByText('De echte tekst')).toBeTruthy();
    });

    it.each([
        ['<p>hallo</p>', 'text'],
        ['<img src="cid:logo1">', 'an image and nothing else'],
        ['<table><tr><td>1</td></tr></table>', 'a table'],
        ['<p>&euro;</p>', 'an entity that is a real character'],
    ])('still renders the frame for %s', (html) => {
        const { container } = renderThread(withBodies(html, 'niet dit'));
        expect(container.querySelector('iframe')).toBeTruthy();
    });

    it('shows the empty marker when BOTH bodies are blank, not a blank frame', () => {
        // body_text is "\r\n" on those rows, not '', so the text branch printed
        // whitespace and the reader still saw nothing at all.
        const { container } = renderThread(withBodies('<div dir="ltr"><br></div>', '\r\n'));
        expect(container.querySelector('iframe')).toBeNull();
        expect(container.textContent).toContain('—');
    });
});

describe('an e-mail is a sheet of paper', () => {
    const mail = (html) => node({
        htmlField: 'html',
        source: { kind: 'static', value: [{ kind: 'agent', html, body: '' }] },
    });

    it('drops the filled bubble for a white card, because mail brings its own colours', () => {
        // The live Gmail HTML pins color:rgb(0,0,0) inline. On the primary-filled
        // bubble that is black on brand blue; in dark mode it is black on black.
        const { container } = renderThread(mail('<p style="color:rgb(0,0,0)">hoi</p>'));
        const card = container.querySelector('[data-app-thread-html="true"]');
        expect(card).toBeTruthy();
        expect(card.style.background).toBe('rgb(255, 255, 255)');
        expect(card.style.padding).toBe('0px');
        // The side still reads, as an accent edge rather than a fill.
        expect(card.getAttribute('data-app-thread-side')).toBe('right');
        expect(card.style.borderRightWidth).toBe('3px');
    });

    it('lets the sheet run the full column, unlike a bubble', () => {
        // 85% is a chat tell: it leaves the gutter that says "one side of a
        // conversation". A mail client shows a message full width, and the cap
        // only made the body wrap early inside a half-empty column.
        const { container } = renderThread(mail('<p>hoi</p>'));
        const card = container.querySelector('[data-app-thread-html="true"]');
        expect(card.style.maxWidth).toBe('100%');
    });

    it('leaves a plain-text row exactly as it was', () => {
        const { container } = renderThread(node());
        expect(container.querySelector('[data-app-thread-html]')).toBeNull();
        const bubble = container.querySelector('[data-app-thread-side="right"]');
        expect(bubble.style.padding).toBe('');
        // The bubble keeps its cap — this change is about paper only.
        expect(bubble.style.maxWidth).toBe('85%');
    });
});

/**
 * message_thread mail header (spec: componentSpecs.js). Any of emailField /
 * toField / subjectField / showAvatar turns the line above the bubble into a
 * mail header: name + <email>, an "Aan/Onderwerp" line, time on the right, and
 * an optional avatar. With none set the rendering is unchanged.
 */
const MAIL = [
    { kind: 'agent', author: 'Daniel de Vries', email: 'daniel@acme.nl', to: 'jan@klant.nl', subject: 'Offerte 2231', body: 'Bijgaand.', at: '2026-03-01T09:00:00Z' },
];

function mailNode(props = {}) {
    return node({
        source: { kind: 'static', value: MAIL },
        bodyField: 'body', authorField: 'author', timestampField: 'at',
        sideField: 'kind', sideMap: [{ value: 'agent', side: 'right', tone: 'primary' }],
        ...props,
    });
}

describe('AppMessageThread — mail header', () => {
    it('turns the meta line into a header with name, <email>, Aan/Onderwerp', () => {
        const { container, getByText } = renderThread(mailNode({
            emailField: 'email', toField: 'to', subjectField: 'subject',
        }));
        const head = container.querySelector('[data-app-thread-mailhead="true"]');
        expect(head).toBeTruthy();
        expect(getByText('Daniel de Vries')).toBeTruthy();
        expect(getByText('<daniel@acme.nl>')).toBeTruthy();
        // Second line shows only the fields that are set and filled.
        expect(head.textContent).toContain('To: jan@klant.nl');
        expect(head.textContent).toContain('Subject: Offerte 2231');
    });

    it('shows an avatar with the author initials only when showAvatar is on', () => {
        const on = renderThread(mailNode({ showAvatar: true }));
        const avatar = on.container.querySelector('[data-app-thread-avatar]');
        expect(avatar).toBeTruthy();
        expect(avatar.textContent).toBe('DV'); // Daniel de Vries → first + last word

        // Avatar alone still activates the header, but a plain field set does not.
        const off = renderThread(mailNode({ subjectField: 'subject' }));
        expect(off.container.querySelector('[data-app-thread-avatar]')).toBeNull();
        expect(off.container.querySelector('[data-app-thread-mailhead="true"]')).toBeTruthy();
    });

    it('leaves the plain author/time meta unchanged when no mail props are set', () => {
        const { container } = renderThread(mailNode());
        expect(container.querySelector('[data-app-thread-mailhead]')).toBeNull();
        // The ordinary meta line is still there.
        expect(container.querySelector('[data-app-thread-meta]')).toBeTruthy();
    });
});

/**
 * message_thread.centerMeta (spec: componentSpecs.js). 'inline' prefixes system
 * (center) rows with their timestamp; the default 'hidden' leaves them as today.
 */
describe('AppMessageThread — centerMeta', () => {
    const SYS = [
        { kind: 'system', body: 'Tekeningen gelezen', at: '2026-08-14T07:23:00Z' },
    ];
    const sysNode = (props = {}) => node({
        source: { kind: 'static', value: SYS },
        bodyField: 'body', timestampField: 'at',
        sideField: 'kind', sideMap: [{ value: 'system', side: 'center', tone: 'neutral' }],
        ...props,
    });

    it('hidden (default) shows no timestamp on the system row', () => {
        const { container } = renderThread(sysNode());
        const row = container.querySelector('[data-app-thread-side="center"]');
        expect(row.textContent).toBe('Tekeningen gelezen');
    });

    it('inline prefixes the system row with its timestamp', () => {
        const { container } = renderThread(sysNode({ centerMeta: 'inline' }));
        const row = container.querySelector('[data-app-thread-side="center"]');
        expect(row.textContent).toContain('·');
        expect(row.textContent).toContain('Tekeningen gelezen');
        // The prefix carries the formatted stamp before the body.
        expect(row.textContent.indexOf('Tekeningen gelezen')).toBeGreaterThan(0);
    });
});

/**
 * A mail sync writes attachments and activity to their OWN tables, keyed by the
 * provider's message id. Neither could reach the thread before: attachmentsField
 * reads the message row, and sideMap can only colour rows already in `source`.
 */
describe('AppMessageThread — attachments and events from their own tables', () => {
    const MAILS = [
        { id: 'm1', pid: 'p1', body: 'Hoi', at: '2026-03-01T09:00:00Z' },
        { id: 'm2', pid: 'p2', body: 'Nog een', at: '2026-03-01T11:00:00Z' },
    ];
    const ATTS = [
        { pid: 'p1', filename: 'bon.pdf' },
        { pid: 'p1', filename: 'tekening.pdf' },
        { pid: 'p2', filename: 'offerte.pdf' },
    ];
    const EVENTS = [
        { detail: 'Tekeningen gelezen', at: '2026-03-01T10:00:00Z' },
    ];

    const mailNode = (props = {}) => node({
        source: { kind: 'static', value: MAILS },
        bodyField: 'body', timestampField: 'at',
        sideField: null, sideMap: [], attachmentsField: null,
        ...props,
    });

    it('hangs each message its own attachments, matched on the shared id', () => {
        const { container } = renderThread(mailNode({
            attachmentsSource: { kind: 'static', value: ATTS },
            attachmentMatchKey: 'pid',
            attachmentLabelKey: 'filename',
        }));
        const chipRows = [...container.querySelectorAll('[data-app-thread-chips="attachments"]')];
        expect(chipRows).toHaveLength(2);
        expect(chipRows[0].textContent).toContain('bon.pdf');
        expect(chipRows[0].textContent).toContain('tekening.pdf');
        // The second mail must NOT inherit the first one's files.
        expect(chipRows[1].textContent).toBe('offerte.pdf');
    });

    it('drops the events into the conversation in time order', () => {
        const { container } = renderThread(mailNode({
            eventsSource: { kind: 'static', value: EVENTS },
            eventsBodyField: 'detail', eventsTimestampField: 'at',
        }));
        const rows = [...container.querySelectorAll('[data-app-thread-side]')];
        // 09:00 mail, 10:00 event, 11:00 mail — the event belongs BETWEEN them,
        // which is the whole point of merging rather than listing separately.
        expect(rows.map((r) => r.getAttribute('data-app-thread-side')))
            .toEqual(['left', 'center', 'left']);
        expect(rows[1].textContent).toContain('Tekeningen gelezen');
    });

    it('leaves the thread untouched when neither source is set', () => {
        const { container } = renderThread(mailNode());
        expect(container.querySelectorAll('[data-app-thread-side]')).toHaveLength(2);
        expect(container.querySelector('[data-app-thread-chips="attachments"]')).toBeNull();
    });
});

/**
 * A zip that unpacks to 243 drawings hangs all of them off ONE mail. Rendered
 * flat that is a wall of chips taller than the viewport: the conversation is
 * buried and the reply box leaves the screen.
 */
describe('AppMessageThread — a message with a very long file list', () => {
    const MANY = Array.from({ length: 243 }, (_, i) => ({ filename: `deel-${i}.pdf` }));
    const bigNode = () => node({
        source: { kind: 'static', value: [{ kind: 'requester', body: 'Zie bijlagen', files: MANY }] },
        attachmentsField: 'files', attachmentLabelKey: 'filename',
    });

    it('shows a handful and offers the rest, instead of all 243', () => {
        const { container } = renderThread(bigNode());
        const group = container.querySelector('[data-app-thread-chips="attachments"]');
        expect(group.getAttribute('data-app-thread-chips-total')).toBe('243');
        // 6 chips + one toggle — nothing near the full list.
        expect(group.querySelectorAll('span')).toHaveLength(6);
        const toggle = group.querySelector('[data-app-thread-chips-toggle="more"]');
        expect(toggle.textContent).toBe('+237 more');
    });

    it('expands into a scroll box, so the thread keeps its height', () => {
        const { container } = renderThread(bigNode());
        fireEvent.click(container.querySelector('[data-app-thread-chips-toggle="more"]'));
        const group = container.querySelector('[data-app-thread-chips="attachments"]');
        expect(group.querySelectorAll('span')).toHaveLength(243);
        // The cap moves from the count to the height — an open list scrolls.
        expect(group.className).toContain('overflow-y-auto');
        expect(group.querySelector('[data-app-thread-chips-toggle="less"]')).toBeTruthy();
    });

    it('leaves a short list alone — no toggle at all', () => {
        const { container } = renderThread(node());
        const group = container.querySelector('[data-app-thread-chips="attachments"]');
        expect(group.querySelectorAll('span')).toHaveLength(1);
        expect(group.querySelector('[data-app-thread-chips-toggle]')).toBeNull();
    });
});

/**
 * A mail header floated ABOVE the sheet and pushed to one side reads as a chat
 * nameplate: it drifts away from the body it belongs to, and on the right-hand
 * side it sits opposite the text it describes. Every mail client puts it inside,
 * above a rule — and so does the design this was built from.
 */
describe('AppMessageThread — where the mail header sits', () => {
    const mailNode = (props = {}) => node({
        htmlField: 'html',
        emailField: 'email', toField: 'to', subjectField: 'subject', showAvatar: true,
        source: { kind: 'static', value: [{
            kind: 'agent', author: 'Tom Smit', email: 'tom@x.nl', to: 'verkoop@x.nl',
            subject: 'Bestelbon', html: '<p>Hoi</p>', at: '2026-03-01T09:00:00Z',
        }] },
        ...props,
    });

    it('puts the header inside the sheet, above a rule', () => {
        const { container } = renderThread(mailNode());
        const card = container.querySelector('[data-app-thread-html="true"]');
        const head = container.querySelector('[data-app-thread-mailhead="true"]');
        expect(card.contains(head)).toBe(true);
        expect(head.style.borderBottom).toContain('1px solid');
        // The sheet is always white, so the header cannot use theme tokens —
        // in dark mode those are near-white and would disappear on it.
        expect(head.querySelector('span').textContent).toBe('TS');
        expect(head.textContent).toContain('To: verkoop@x.nl');
    });

    it('keeps it above the bubble when there is no sheet to put it in', () => {
        const { container } = renderThread(mailNode({ htmlField: null }));
        const card = container.querySelector('[data-app-thread-side]');
        const head = container.querySelector('[data-app-thread-mailhead="true"]');
        expect(head).toBeTruthy();
        expect(card.contains(head)).toBe(false);
    });
});
