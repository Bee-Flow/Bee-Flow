import { describe, it, expect } from 'vitest';
import { REACT_THEME_VARS } from '@shared/cmsReact/compile.mjs';
import { buildReactFrameDoc, readSiteTheme, scriptJson, themeCss, THEME_VARS } from './frameDoc';

const RUNTIME = '(function(){window.__bfReactMount=function(){};})();';

function doc(over: Partial<Parameters<typeof buildReactFrameDoc>[0]> = {}) {
    return buildReactFrameDoc({
        runtime: RUNTIME,
        compiled: 'module.exports.default = function () { return null; };',
        css: '',
        theme: themeCss(readSiteTheme(null)),
        props: {},
        mode: 'public',
        ...over,
    });
}

describe('buildReactFrameDoc', () => {
    it('holds viewport meta, base target, theme, root, runtime and the mount call in that order', () => {
        const html = doc({ css: '.x{color:red}' });
        const order = [
            '<meta name="viewport" content="width=device-width, initial-scale=1">',
            '<base target="_top">',
            ':root{--bf-primary:',
            '.x{color:red}',
            '<div id="root"></div>',
            RUNTIME,
            '__bfReactMount(function(module,exports,require){',
        ].map((s) => html.indexOf(s));
        expect(order.every((i) => i >= 0)).toBe(true);
        expect([...order].sort((a, b) => a - b)).toEqual(order);
    });

    it('opens links in a new tab in the editor preview, never over the editor', () => {
        expect(doc({ mode: 'editor' })).toContain('<base target="_blank">');
        expect(doc({ mode: 'editor' })).toContain('{"mode":"editor"}');
    });

    it('defangs </script in the compiled code and the runtime, and </style in the css', () => {
        const html = doc({
            runtime: 'var a="</script>";',
            compiled: 'var s = "</SCRIPT><img src=x onerror=alert(1)>";',
            css: 'p::after{content:"</style><img src=x onerror=alert(1)>"}',
        });
        expect(html.match(/<\/script>/gi)).toHaveLength(2); // the two closing tags of our own scripts
        expect(html).toContain('"<\\/script><img');
        expect(html.match(/<\/style>/gi)).toHaveLength(2);
    });

    it('escapes < in the props JSON, so a prop value cannot end the script', () => {
        const html = doc({ props: { title: '</script><script>alert(1)</script>', n: 2 } });
        expect(html).toContain('"title":"\\u003c/script>\\u003cscript>alert(1)\\u003c/script>"');
        expect(scriptJson({ a: '<!--' })).toBe('{"a":"\\u003c!--"}');
        expect(JSON.parse(scriptJson({ a: '<b>' }))).toEqual({ a: '<b>' });
    });

    it('keeps a trailing line comment of the compiled code from swallowing the closing brace', () => {
        expect(doc({ compiled: 'x = 1 // end' })).toContain('x = 1 // end\n},');
    });
});

describe('site theme', () => {
    it('passes exactly the variables the compiler documents', () => {
        expect(THEME_VARS.map(([name]) => name)).toEqual([...REACT_THEME_VARS]);
    });

    it('reads the marketing tokens where the block sits, with a fallback each', () => {
        const el = document.createElement('section');
        el.style.setProperty('--brand-primary', '#123456');
        el.style.setProperty('--radius-base', '4px');
        document.body.appendChild(el);
        const theme = readSiteTheme(el);
        expect(theme['--bf-primary']).toBe('#123456');
        expect(theme['--bf-radius']).toBe('4px');
        expect(theme['--bf-text']).toBe('#0F172A');
        el.remove();
    });

    it('cannot break out of its declaration', () => {
        const css = themeCss({ '--bf-primary': 'red;}</style><script>x()</script>' });
        expect(css).not.toMatch(/[<>]/);
        expect(css.startsWith(':root{--bf-primary:red/stylescriptx()/script;')).toBe(true);
    });
});
