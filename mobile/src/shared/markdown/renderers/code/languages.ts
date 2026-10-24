/**
 * The code block's languages, as the web's MarkdownRenderer registers and
 * names them. languages.test.ts holds both tables to the web file.
 *
 * GRAMMAR_OF maps every name the web registers with highlight.js to the
 * grammar module it registers under that name (`py` → python, `html` → xml);
 * LANGUAGE_LABELS is the header's pretty name, and a language missing from it
 * is shown capitalised, as on the web.
 */

import { LANG_LABELS } from '@/shared/markdown/mirror/markdownRules';

export const GRAMMAR_OF: Readonly<Record<string, string>> = {
    python: 'python',
    py: 'python',
    javascript: 'javascript',
    js: 'javascript',
    typescript: 'typescript',
    ts: 'typescript',
    html: 'xml',
    xml: 'xml',
    css: 'css',
    json: 'json',
    bash: 'bash',
    sh: 'bash',
    shell: 'bash',
    sql: 'sql',
    yaml: 'yaml',
    yml: 'yaml',
    java: 'java',
    csharp: 'csharp',
    cs: 'csharp',
    cpp: 'cpp',
    c: 'cpp',
    go: 'go',
    rust: 'rust',
    ruby: 'ruby',
    rb: 'ruby',
    php: 'php',
    markdown: 'markdown',
    md: 'markdown',
};

export const LANGUAGE_LABELS: Readonly<Record<string, string>> = LANG_LABELS;

/** The header's name for a fence's language; '' for none (the header then says "Code"). */
export function languageLabel(language: string): string {
    if (!language) return '';
    return LANGUAGE_LABELS[language.toLowerCase()] ?? language.charAt(0).toUpperCase() + language.slice(1);
}

/**
 * The web's "compact" snippet: one or two lines with no language, which it
 * draws as a wrapping inline-code chip instead of a full block with a header.
 */
export function isCompactSnippet(code: string, language: string): boolean {
    return !language && code.split('\n').length <= 2;
}
