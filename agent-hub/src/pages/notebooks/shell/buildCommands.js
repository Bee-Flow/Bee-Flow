/**
 * buildCommands — produce the ⌘K command list from handlers the page already
 * owns. Editor commands go through the shared editor facade
 * (getEditor().chain().focus()...), which works for any engine; page actions
 * (generate / export / view toggles) call existing handlers. No new capability.
 */
import {
    Bold, Italic, Underline as UnderlineIcon, Strikethrough, Code, Highlighter,
    Heading1, Heading2, Heading3, List, ListOrdered, ListChecks, Quote, Code2,
    Minus, Table2, FileDown, FileText, PenLine, Cloud, PanelLeft, MessageSquare, History,
    MessagesSquare, ListTree, MessageSquarePlus, Type, FileUp, Search, Keyboard,
} from 'lucide-react';

/** ⌘ on a Mac, Ctrl elsewhere — for the shortcut hints next to a command. */
const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '') ? '⌘' : 'Ctrl+';
const ALT = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '') ? '⌥' : 'Alt+';

export default function buildCommands(ctx = {}) {
    const {
        t = (k, fb) => fb || k,
        editorRef,
        onExport,
        hasExportContent = true,
        signRequestConfigured = false,
        onSign,
        nextcloudConfigured = false,
        onNextcloud,
        onToggleLeft,
        onToggleRight,
        onVersions,
        onComments,
        onToggleToc,
        onNewChat,
        onRename,
        onImport,
        onFind,
        onShortcuts,
        // A viewer gets no formatting or inserting: the editor is read-only.
        readOnly = false,
    } = ctx;

    // Run an editor chain command via the shared facade. Optional-chained so a
    // missing method is a no-op rather than a crash.
    const ed = (apply) => () => {
        const editor = editorRef?.current?.getEditor?.();
        if (!editor?.chain) return;
        const chain = editor.chain().focus();
        apply(chain).run();
    };

    const FORMAT = t('notebooks.cmd_group_format', 'Format');
    const INSERT = t('notebooks.cmd_group_insert', 'Insert');
    const EXPORT = t('notebooks.cmd_group_export', 'Export');
    const VIEW = t('notebooks.cmd_group_view', 'View');
    const NOTEBOOK = t('notebooks.cmd_group_notebook', 'Notebook');

    const cmds = [
        // ── Format ──
        { id: 'bold', group: FORMAT, icon: Bold, label: t('notebooks.bold', 'Bold'), keywords: 'strong', run: ed(c => c.toggleBold()) },
        { id: 'italic', group: FORMAT, icon: Italic, label: t('notebooks.italic', 'Italic'), keywords: 'emphasis', run: ed(c => c.toggleItalic()) },
        { id: 'underline', group: FORMAT, icon: UnderlineIcon, label: t('notebooks.underline', 'Underline'), run: ed(c => c.toggleUnderline()) },
        { id: 'strike', group: FORMAT, icon: Strikethrough, label: t('notebooks.strikethrough', 'Strikethrough'), run: ed(c => c.toggleStrike()) },
        { id: 'code', group: FORMAT, icon: Code, label: t('notebooks.inline_code', 'Inline code'), run: ed(c => c.toggleCode()) },
        { id: 'highlight', group: FORMAT, icon: Highlighter, label: t('notebooks.highlight', 'Highlight'), run: ed(c => c.toggleHighlight()) },
        { id: 'h1', group: FORMAT, icon: Heading1, label: t('notebooks.heading_1', 'Heading 1'), run: ed(c => c.toggleHeading({ level: 1 })) },
        { id: 'h2', group: FORMAT, icon: Heading2, label: t('notebooks.heading_2', 'Heading 2'), run: ed(c => c.toggleHeading({ level: 2 })) },
        { id: 'h3', group: FORMAT, icon: Heading3, label: t('notebooks.heading_3', 'Heading 3'), run: ed(c => c.toggleHeading({ level: 3 })) },
        { id: 'bullet', group: FORMAT, icon: List, label: t('notebooks.bullet_list', 'Bullet list'), run: ed(c => c.toggleBulletList()) },
        { id: 'ordered', group: FORMAT, icon: ListOrdered, label: t('notebooks.numbered_list', 'Numbered list'), run: ed(c => c.toggleOrderedList()) },
        { id: 'task', group: FORMAT, icon: ListChecks, label: t('notebooks.task_list', 'Task list'), run: ed(c => c.toggleTaskList()) },

        // ── Insert ──
        { id: 'quote', group: INSERT, icon: Quote, label: t('notebooks.blockquote', 'Quote'), run: ed(c => c.toggleBlockquote()) },
        { id: 'codeblock', group: INSERT, icon: Code2, label: t('notebooks.code_block', 'Code block'), run: ed(c => c.setCodeBlock()) },
        { id: 'table', group: INSERT, icon: Table2, label: t('notebooks.table', 'Table'), run: ed(c => c.insertTable({ rows: 3, cols: 3, withHeaderRow: true })) },
        { id: 'divider', group: INSERT, icon: Minus, label: t('notebooks.divider', 'Divider'), run: ed(c => c.setHorizontalRule()) },

        // ── Export ──
        { id: 'export-pdf', group: EXPORT, icon: FileDown, label: t('notebooks.export_pdf', 'Export as PDF'), enabled: hasExportContent && !!onExport, run: () => onExport?.('pdf') },
        { id: 'export-docx', group: EXPORT, icon: FileText, label: t('notebooks.export_word', 'Export as Word'), enabled: hasExportContent && !!onExport, run: () => onExport?.('docx') },
        { id: 'export-sign', group: EXPORT, icon: PenLine, label: t('notebooks.send_for_signing', 'Send for signing'), enabled: signRequestConfigured && hasExportContent && !!onSign, run: () => onSign?.() },
        { id: 'export-nextcloud', group: EXPORT, icon: Cloud, label: t('notebooks.export_nextcloud', 'Save to Nextcloud'), enabled: nextcloudConfigured && hasExportContent && !!onNextcloud, run: () => onNextcloud?.() },

        // ── View ──
        { id: 'toggle-sources', group: VIEW, icon: PanelLeft, label: t('notebooks.toggle_sources', 'Toggle Sources'), enabled: !!onToggleLeft, run: () => onToggleLeft?.() },
        { id: 'toggle-chat', group: VIEW, icon: MessageSquare, label: t('notebooks.toggle_chat', 'Toggle AI Chat'), hint: `${MOD}J`, enabled: !!onToggleRight, run: () => onToggleRight?.() },
        { id: 'versions', group: VIEW, icon: History, label: t('notebooks.version_history', 'Version history'), hint: `${ALT}${MOD}H`, keywords: 'history restore compare name', enabled: !!onVersions, run: () => onVersions?.() },
        { id: 'comments', group: VIEW, icon: MessagesSquare, label: t('notebooks.toggle_comments', 'Comments'), hint: `${ALT}${MOD}M`, enabled: !!onComments, run: () => onComments?.() },
        { id: 'toc', group: VIEW, icon: ListTree, label: t('notebooks.toggle_toc', 'Toggle Table of Contents'), enabled: !!onToggleToc, run: () => onToggleToc?.() },
        { id: 'find', group: VIEW, icon: Search, label: t('notebooks.find_in_document', 'Find in document'), hint: `${MOD}F`, enabled: !!onFind, run: () => onFind?.() },
        { id: 'shortcuts', group: VIEW, icon: Keyboard, label: t('notebooks.keyboard_shortcuts', 'Keyboard shortcuts'), hint: `${MOD}/`, keywords: 'keys help ?', enabled: !!onShortcuts, run: () => onShortcuts?.() },

        // ── Notebook ──
        { id: 'new-chat', group: NOTEBOOK, icon: MessageSquarePlus, label: t('notebooks.new_chat', 'New chat'), enabled: !!onNewChat, run: () => onNewChat?.() },
        { id: 'rename', group: NOTEBOOK, icon: Type, label: t('notebooks.rename_notebook_cmd', 'Rename notebook'), enabled: !!onRename && !readOnly, run: () => onRename?.() },
        { id: 'import', group: NOTEBOOK, icon: FileUp, label: t('notebooks.import_file_cmd', 'Import a file into the document'), enabled: !!onImport && !readOnly, run: () => onImport?.() },
    ];

    // Formatting and inserting change the document: not for a viewer.
    return readOnly ? cmds.filter((c) => c.group !== FORMAT && c.group !== INSERT) : cmds;
}
