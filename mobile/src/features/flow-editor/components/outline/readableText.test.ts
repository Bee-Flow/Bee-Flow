import { readableExample, readablePath, readableRule, readableSummary, readableText } from './readableText';

const LABELS = new Map([
    ['act_4d4307a', 'gmail search'],
    ['ai_1', 'Classify'],
]);

describe('readableText', () => {
    it('names every {{reference}} in a text the way its pill does', () => {
        expect(readableText('Summarise {{steps.act_4d4307a.output.body}}', LABELS)).toBe('Summarise ‹gmail search ▸ Body›');
        expect(readableText('Hi {{ trigger.output.first_name }}, your {{loop.row.total}} is due ({{item.id}})', LABELS)).toBe(
            'Hi ‹Trigger ▸ First name›, your ‹Loop item · row ▸ Total› is due (‹Current row ▸ Id›)',
        );
        expect(readableText('{{steps.act_4d4307a.output}}', LABELS)).toBe('‹gmail search›');
        expect(readableText('{{steps.act_4d4307a.output.results[*].from_email}}', LABELS)).toBe('‹gmail search ▸ From email›');
    });

    it('says "Previous step" for a step that is gone, as the pill does', () => {
        expect(readableText('{{steps.gone.output.x}}', LABELS)).toBe('‹Previous step ▸ X›');
    });

    it('leaves text alone that holds no reference, and bare words in a template', () => {
        expect(readableText('Send the steps.a.output.x report', LABELS)).toBe('Send the steps.a.output.x report');
        expect(readableText('{{ not a path }} and {{}}', LABELS)).toBe('{{ not a path }} and {{}}');
        expect(readableText(undefined, LABELS)).toBe('');
        expect(readableText(42, LABELS)).toBe('');
    });

    it('names the paths inside a hand-written formula between {{ }}', () => {
        expect(readableText('Total: {{ upper(steps.ai_1.output.name) }}', LABELS)).toBe('Total: {{ upper(‹Classify ▸ Name›) }}');
    });

    it('names bare paths in an expression, and a {{reference}} in one only once', () => {
        expect(readableText('steps.ai_1.output.score > 5 && item.paid == false', LABELS, { expression: true })).toBe(
            '‹Classify ▸ Score› > 5 && ‹Current row ▸ Paid› == false',
        );
        expect(readableText('{{steps.ai_1.output.score}} > 5', LABELS, { expression: true })).toBe('‹Classify ▸ Score› > 5');
    });
});

describe('readablePath', () => {
    it('names a list by its step and field — a trailing [*] is the list itself', () => {
        expect(readablePath('steps.act_4d4307a.output.results', LABELS)).toBe('‹gmail search ▸ Results›');
        expect(readablePath('steps.act_4d4307a.output.results[*]', LABELS)).toBe('‹gmail search ▸ Results›');
        expect(readablePath(' trigger.output.items ', LABELS)).toBe('‹Trigger ▸ Items›');
        expect(readablePath('{{steps.act_4d4307a.output.results}}', LABELS)).toBe('‹gmail search ▸ Results›');
    });

    it('names a column as the list picker does', () => {
        expect(readablePath('steps.act_4d4307a.output.results[*].subject', LABELS)).toBe('‹gmail search ▸ Subject (inside each row)›');
    });

    it('is empty without a path', () => {
        expect(readablePath('', LABELS)).toBe('');
        expect(readablePath(null, LABELS)).toBe('');
        expect(readablePath('[*]', LABELS)).toBe('');
    });
});

describe('readableRule', () => {
    it('keeps the web’s sentence where it has one', () => {
        expect(readableRule('contains(item.subject, "isv")', LABELS)).toBe('Subject contains “isv”');
    });

    it('names the references where the sentence falls back to the expression', () => {
        expect(readableRule('steps.ai_1.output.score * 2 > trigger.output.cap', LABELS)).toBe('‹Classify ▸ Score› * 2 > ‹Trigger ▸ Cap›');
        expect(readableRule('', LABELS)).toBe('');
    });
});

describe('readableSummary and readableExample', () => {
    it('names a card line and leaves the muted words alone', () => {
        expect(readableSummary('GET https://api.test/{{trigger.output.id}}', LABELS)).toBe('GET https://api.test/‹Trigger ▸ Id›');
        expect(readableSummary({ muted: 'no prompt yet' }, LABELS)).toEqual({ muted: 'no prompt yet' });
    });

    it('writes an empty field’s example in its pills’ words', () => {
        expect(readableExample('Offerte {{trigger.output.bedrijf}}')).toBe('Offerte ‹Trigger ▸ Bedrijf›');
        expect(readableExample('{{steps.extract.output.naam}}')).toBe('‹Previous step ▸ Naam›');
        expect(readableExample('steps.step1.output.amount > 1000', true)).toBe('‹Previous step ▸ Amount› > 1000');
        expect(readableExample('https://api.example.com/endpoint')).toBe('https://api.example.com/endpoint');
        expect(readableExample(undefined)).toBeUndefined();
    });
});
