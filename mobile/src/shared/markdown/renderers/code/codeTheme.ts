/**
 * The code block's paint: the web's, whatever the app theme. The web renders
 * every fenced block on the same dark panel (MarkdownRenderer.jsx's
 * CollapsibleCodeBlock) and colours tokens with highlight.js's GitHub Dark
 * theme (`highlight.js/styles/github-dark.min.css`); both are ported here and
 * codeTheme.test.ts reads the stylesheet and the web file to hold them equal.
 */

import { StyleSheet, type TextStyle } from 'react-native';

/** The panel, from CollapsibleCodeBlock's inline styles. */
export const CODE_PANEL = {
    background: '#1e1e2e',
    border: 'rgba(255, 255, 255, 0.08)',
    headerBackground: 'rgba(255,255,255,0.05)',
    headerBorder: 'rgba(255,255,255,0.06)',
    headerText: '#94a3b8',
    copied: '#10b981',
    /** `.hljs` — GitHub Dark's base text colour. */
    text: '#c9d1d9',
} as const;

const KEYWORD = '#ff7b72';
const ENTITY = '#d2a8ff';
const CONSTANT = '#79c0ff';
const STRING = '#a5d6ff';
const VARIABLE = '#ffa657';
const COMMENT = '#8b949e';
const TAG = '#7ee787';

/** GitHub Dark, by scope (`title.function_` for `.hljs-title.function_`). */
export const GITHUB_DARK: Readonly<Record<string, TextStyle>> = {
    doctag: { color: KEYWORD },
    keyword: { color: KEYWORD },
    'template-tag': { color: KEYWORD },
    'template-variable': { color: KEYWORD },
    type: { color: KEYWORD },
    'variable.language_': { color: KEYWORD },
    title: { color: ENTITY },
    'title.class_': { color: ENTITY },
    'title.class_.inherited__': { color: ENTITY },
    'title.function_': { color: ENTITY },
    attr: { color: CONSTANT },
    attribute: { color: CONSTANT },
    literal: { color: CONSTANT },
    meta: { color: CONSTANT },
    number: { color: CONSTANT },
    operator: { color: CONSTANT },
    variable: { color: CONSTANT },
    'selector-attr': { color: CONSTANT },
    'selector-class': { color: CONSTANT },
    'selector-id': { color: CONSTANT },
    regexp: { color: STRING },
    string: { color: STRING },
    built_in: { color: VARIABLE },
    symbol: { color: VARIABLE },
    comment: { color: COMMENT },
    code: { color: COMMENT },
    formula: { color: COMMENT },
    name: { color: TAG },
    quote: { color: TAG },
    'selector-tag': { color: TAG },
    'selector-pseudo': { color: TAG },
    subst: { color: CODE_PANEL.text },
    section: { color: '#1f6feb', fontWeight: 'bold' },
    bullet: { color: '#f2cc60' },
    emphasis: { color: CODE_PANEL.text, fontStyle: 'italic' },
    strong: { color: CODE_PANEL.text, fontWeight: 'bold' },
    addition: { color: '#aff5b4', backgroundColor: '#033a16' },
    deletion: { color: '#ffdcd7', backgroundColor: '#67060c' },
};

/** The same, as one sheet, so a run's style is a lookup and never a fresh object. */
export const SCOPE_STYLES = StyleSheet.create(GITHUB_DARK as Record<string, TextStyle>);

/**
 * The theme key that paints a scope: the compound (`variable.language_`) when
 * the theme names it, else its base (`title.function_` → `title` would do as
 * well), else nothing — the run inherits its parent's colour.
 */
export function paintedScope(scope: string): string | null {
    if (GITHUB_DARK[scope]) return scope;
    const base = scope.split('.', 1)[0] ?? '';
    return GITHUB_DARK[base] ? base : null;
}
