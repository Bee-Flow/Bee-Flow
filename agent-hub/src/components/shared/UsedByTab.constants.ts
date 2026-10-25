import { FolderKanban, MessageSquare, NotebookPen } from 'lucide-react';
import type { CSSProperties } from 'react';
import type { KindVisual } from './UsedByTab.types';

const USAGE_ROLES = Object.freeze([
    'read', 'write', 'readwrite', 'contains', 'invokes', 'chat', 'ai_step', 'answer_block',
]);

/**
 * Kinds that appear in a usage list but are not Studio kinds (kindColors
 * knows the ten things you MAKE; a chat or a project is where a thing is
 * USED). A chat borrows the agent's blue — Agents artboard 1b draws the Chat
 * row with `message-square` in `--type-ai`.
 */
export const EXTRA_KIND: Readonly<Record<string, KindVisual | undefined>> = Object.freeze({
    chat: { Icon: MessageSquare, color: 'var(--type-ai)' },
    project: { Icon: FolderKanban, color: 'var(--text-secondary)' },
    notebook: { Icon: NotebookPen, color: 'var(--text-secondary)' },
});

/** Studio deep-link segment per kind — only kinds with a detail page. */
export const STUDIO_PATH: Readonly<Record<string, string | undefined>> = Object.freeze({
    automation: 'automations',
    agent: 'agents',
    app: 'apps',
    webpage: 'webpages',
    kb: 'knowledge',
    skill: 'skills',
    datatable: 'datatables',
    solution: 'solutions',
});

export const HEAD_STYLE: CSSProperties = {
    display: 'grid',
    gridTemplateColumns: '1fr 120px 120px 32px',
    gap: 12,
    padding: '8px 14px',
    borderBottom: '1px solid var(--border-default)',
    fontSize: 10,
    letterSpacing: '.08em',
    textTransform: 'uppercase',
    fontWeight: 600,
    color: 'var(--text-tertiary)',
};

export const ROW_STYLE: CSSProperties = {
    display: 'grid',
    gridTemplateColumns: '1fr 120px 120px 32px',
    gap: 12,
    alignItems: 'center',
    padding: '9px 14px',
};

/**
 * Singular/plural noun per kind, for the pills and the untitled fallback.
 * Keys `usage.kind_<kind>` / `usage.kind_<kind>_plural`, English fallbacks
 * inline so the i18n guard can read them.
 */
export const KIND_NOUNS: Readonly<Record<string, readonly [string, string] | undefined>> = Object.freeze({
    automation: ['automation', 'automations'],
    datatable: ['table', 'tables'],
    app: ['app', 'apps'],
    webpage: ['webpage', 'webpages'],
    form: ['form', 'forms'],
    agent: ['agent', 'agents'],
    skill: ['skill', 'skills'],
    kb: ['knowledge base', 'knowledge bases'],
    meeting: ['meeting note', 'meeting notes'],
    solution: ['solution', 'solutions'],
    chat: ['chat', 'chats'],
    project: ['project', 'projects'],
    notebook: ['notebook', 'notebooks'],
    other: ['item', 'items'],
});
