/**
 * highlight.js, with the web's seventeen grammars under the web's names
 * (languages.ts). The only module that imports highlight.js, reached through
 * lazyModules.ts, so the grammars are compiled the first time an answer holds
 * a code block rather than at start-up.
 *
 * Returns hljs's own HTML (`<span class="hljs-keyword">…`); hljsHtml.ts turns
 * that into styled runs. The HTML is hljs's public output — its token tree is
 * an internal — so this survives a highlight.js upgrade.
 */

import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import php from 'highlight.js/lib/languages/php';
import python from 'highlight.js/lib/languages/python';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

import { GRAMMAR_OF } from './languages';

type Grammar = Parameters<typeof hljs.registerLanguage>[1];

const GRAMMARS: Readonly<Record<string, Grammar>> = {
    bash, cpp, csharp, css, go, java, javascript, json, markdown, php, python, ruby, rust, sql, typescript, xml, yaml,
};

for (const [name, grammar] of Object.entries(GRAMMAR_OF)) {
    const definition = GRAMMARS[grammar];
    // hljs catches a grammar that fails to compile and carries on without it.
    if (definition) hljs.registerLanguage(name, definition);
}

/**
 * The web's rule: a registered language is highlighted as that language,
 * anything else (no tag, or one the web does not register) is auto-detected.
 */
export function highlightHtml(code: string, language: string): string {
    if (language && hljs.getLanguage(language)) return hljs.highlight(code, { language }).value;
    return hljs.highlightAuto(code).value;
}
