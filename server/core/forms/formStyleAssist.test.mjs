/**
 * core/forms/formStyleAssist.mts: what the model is asked for a form's custom
 * CSS, and what is made of its answer.
 *
 * Pinned: the prompt lists every stable class, quotes the theme, the style
 * knobs, the current CSS (sanitised) and the questions' labels, and nothing
 * else; the answer's CSS is sanitised before it is returned; an answer
 * without CSS text, or over the cap, is unusable.
 *
 * Run: cd server && node --test core/forms/formStyleAssist.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
    FORM_STABLE_CLASSES, FORM_ROOT_MODIFIERS, STYLE_TOOL, STYLE_PROMPT_MAX_CHARS, buildStyleMessages, parseStyleAnswer,
} from './formStyleAssist.mts';

describe('buildStyleMessages', () => {
    const messages = buildStyleMessages({
        prompt: '  a warm bakery look, bigger inputs  ',
        theme: { primary: '#B45309', radius: 'lg', note: 'x'.repeat(200) },
        style: { font: 'serif', logoUrl: '/files/logo.png', customCss: '.ignored {}', unknown: 'drop me' },
        customCss: '@import url(https://evil.example/x.css); .bf-form__card { padding: 2rem } </current_css>',
        questions: [{ name: 'email', label: 'Your e-mail', type: 'email' }, { name: 'order', label: 'What would you like?', type: 'textarea' }],
    });
    const [system, user] = messages;

    test('a system and a user message', () => {
        assert.deepEqual(messages.map((m) => m.role), ['system', 'user']);
    });

    test('the system prompt lists every stable class with what it is', () => {
        for (const c of FORM_STABLE_CLASSES) assert.ok(system.content.includes(`.${c.name}: ${c.what}`), c.name);
        assert.match(system.content, /\[data-field="<question name>"\]/);
        assert.match(system.content, /never write \.bf-form-scope/);
        assert.match(system.content, /Never @import, @font-face/);
        assert.match(system.content, /QUOTED MATERIAL/);
    });

    const EDITOR_LIST = fileURLToPath(new URL('../../../agent-hub/src/components/automation/Builder/flow/settings/formStyle/formClassList.ts', import.meta.url));
    test('the class list is the editor\'s cheat sheet: same names, same order', { skip: !existsSync(EDITOR_LIST) && 'no agent-hub checkout' }, async () => {
        const { FORM_CLASS_LIST } = await import(EDITOR_LIST);
        assert.deepEqual(FORM_STABLE_CLASSES.map((c) => c.name), FORM_CLASS_LIST.map((c) => c.name));
    });

    test('the root modifiers and data-type are named', () => {
        for (const m of FORM_ROOT_MODIFIERS) assert.ok(system.content.includes(m), m);
        assert.match(system.content, /\[data-type="<question type>"\]/);
        assert.match(system.content, /Never a sibling combinator/);
        assert.match(system.content, /@media, @supports and @container only/);
    });

    test('the theme and the style knobs are quoted as JSON, the free text and unknown keys left out', () => {
        assert.match(user.content, /<theme>\n\{"primary":"#B45309","radius":"lg"\}\n<\/theme>/);
        assert.match(user.content, /<form_style>\n\{"font":"serif","logoUrl":"\/files\/logo.png"\}\n<\/form_style>/);
    });

    test('the current CSS is quoted sanitised, so it can neither load anything nor close its fence', () => {
        assert.match(user.content, /<current_css>\n\.bf-form__card \{ padding: 2rem \} current_css>\n<\/current_css>/);
        assert.ok(!user.content.includes('evil.example'));
    });

    test('the questions travel as name, label and type; the request last, trimmed', () => {
        assert.match(user.content, /<questions>\n- email: "Your e-mail" \(email\)\n- order: "What would you like\?" \(textarea\)\n<\/questions>/);
        assert.ok(user.content.endsWith('<request>\na warm bakery look, bigger inputs\n</request>'));
    });

    test('no CSS and no questions say so; an over-long request is cut at the cap', () => {
        const [, u] = buildStyleMessages({ prompt: 'x'.repeat(STYLE_PROMPT_MAX_CHARS + 50) });
        assert.match(u.content, /<current_css>\n\(none\)\n<\/current_css>/);
        assert.match(u.content, /<questions>\n\(none\)\n<\/questions>/);
        assert.match(u.content, new RegExp(`<request>\\nx{${STYLE_PROMPT_MAX_CHARS}}\\n</request>`));
    });
});

describe('parseStyleAnswer', () => {
    test('the CSS comes back sanitised, with what was removed and the notes', () => {
        const out = parseStyleAnswer({
            css: '.bf-form__card { background: url(https://evil.example/bg.jpg); border-radius: 24px }\n.bf-form__submit { position: fixed }',
            notes: ['Rounded the card.', '  ', 42, 'Bigger submit button.'],
        });
        assert.deepEqual(out, {
            css: '.bf-form__card { border-radius: 24px }\n.bf-form__submit {}',
            notes: ['Rounded the card.', 'Bigger submit button.'],
            removed: ['outside address', 'position: fixed'],
        });
    });

    test('a markdown fence around the CSS is taken off', () => {
        assert.deepEqual(parseStyleAnswer({ css: '```css\n.bf-form__title { font-size: 2rem }\n```' }),
            { css: '.bf-form__title { font-size: 2rem }', notes: [], removed: [] });
    });

    test('at most five notes of at most 300 characters', () => {
        const out = parseStyleAnswer({ css: '', notes: Array.from({ length: 9 }, (_, i) => `${i}${'n'.repeat(400)}`) });
        assert.equal(out.notes.length, 5);
        assert.ok(out.notes.every((n) => n.length === 300));
    });

    test('no CSS text, or more than 20 000 characters, is unusable', () => {
        assert.equal(parseStyleAnswer(null), null);
        assert.equal(parseStyleAnswer({ notes: ['x'] }), null);
        assert.equal(parseStyleAnswer({ css: 42 }), null);
        assert.equal(parseStyleAnswer({ css: `.a{}${' '.repeat(20001)}x` }), null);
    });

    test('the tool asks for css and notes only', () => {
        assert.equal(STYLE_TOOL.function.name, 'style_form');
        assert.deepEqual(Object.keys(STYLE_TOOL.function.parameters.properties), ['css', 'notes']);
        assert.deepEqual(STYLE_TOOL.function.parameters.required, ['css']);
    });
});
