/**
 * shortcuts.ts — the editor's keyboard shortcuts: one catalogue that both the
 * key handler and the "Keyboard shortcuts" sheet read, so the sheet can never
 * list a shortcut that does not work (or miss one that does).
 *
 * Digits are matched on `event.code`, not `event.key`: with Shift held,
 * `key` is the shifted symbol ('&' for 7 on a US layout, '/' on others).
 * AltGr (Ctrl+Alt on many European layouts) types characters and is never
 * taken as a shortcut.
 */

export type ShortcutAction =
    | 'bold' | 'italic' | 'underline' | 'strike' | 'code' | 'link'
    | 'heading1' | 'heading2' | 'heading3' | 'paragraph'
    | 'bulletList' | 'orderedList' | 'taskList' | 'blockquote' | 'codeBlock'
    | 'undo' | 'redo' | 'find' | 'shortcuts';

export interface ShortcutDef {
    /** Undefined for rows that only document built-in keys (Tab, Shift+Enter). */
    action?: ShortcutAction;
    /** i18n key in the editor namespace and its English text. */
    labelKey: string;
    label: string;
    /** Key parts; 'Mod' is ⌘ on Apple platforms and Ctrl elsewhere. */
    keys: string[];
    group: 'text' | 'blocks' | 'document';
    match?: (e: KeyLike) => boolean;
}

export interface KeyLike {
    key: string;
    code?: string;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
    getModifierState?: (key: string) => boolean;
}

const mod = (e: KeyLike) => e.ctrlKey || e.metaKey;
const altGr = (e: KeyLike) => !!e.getModifierState?.('AltGraph');
const letter = (e: KeyLike, l: string) => (e.key || '').toLowerCase() === l;
const digit = (e: KeyLike, d: string) => e.code === `Digit${d}` || e.code === `Numpad${d}`;

const plain = (l: string) => (e: KeyLike) => mod(e) && !e.shiftKey && !e.altKey && letter(e, l);
const shifted = (l: string) => (e: KeyLike) => mod(e) && e.shiftKey && !e.altKey && letter(e, l);
const shiftDigit = (d: string) => (e: KeyLike) => mod(e) && e.shiftKey && !e.altKey && digit(e, d);
const altDigit = (d: string) => (e: KeyLike) => mod(e) && e.altKey && !e.shiftKey && !altGr(e) && digit(e, d);

export const SHORTCUTS: ShortcutDef[] = [
    // Handled by the engine itself (listed so the sheet is complete).
    { labelKey: 'editor.shortcut_bold', label: 'Bold', keys: ['Mod', 'B'], group: 'text' },
    { labelKey: 'editor.shortcut_italic', label: 'Italic', keys: ['Mod', 'I'], group: 'text' },
    { labelKey: 'editor.shortcut_underline', label: 'Underline', keys: ['Mod', 'U'], group: 'text' },
    { action: 'strike', labelKey: 'editor.shortcut_strike', label: 'Strikethrough', keys: ['Mod', 'Shift', 'X'], group: 'text', match: shifted('x') },
    { action: 'code', labelKey: 'editor.shortcut_code', label: 'Inline code', keys: ['Mod', 'E'], group: 'text', match: plain('e') },
    { action: 'link', labelKey: 'editor.shortcut_link', label: 'Add or edit link', keys: ['Mod', 'K'], group: 'text', match: plain('k') },
    { action: 'heading1', labelKey: 'editor.shortcut_heading1', label: 'Heading 1', keys: ['Mod', 'Alt', '1'], group: 'blocks', match: altDigit('1') },
    { action: 'heading2', labelKey: 'editor.shortcut_heading2', label: 'Heading 2', keys: ['Mod', 'Alt', '2'], group: 'blocks', match: altDigit('2') },
    { action: 'heading3', labelKey: 'editor.shortcut_heading3', label: 'Heading 3', keys: ['Mod', 'Alt', '3'], group: 'blocks', match: altDigit('3') },
    { action: 'paragraph', labelKey: 'editor.shortcut_paragraph', label: 'Normal text', keys: ['Mod', 'Alt', '0'], group: 'blocks', match: altDigit('0') },
    { action: 'orderedList', labelKey: 'editor.shortcut_ordered', label: 'Numbered list', keys: ['Mod', 'Shift', '7'], group: 'blocks', match: shiftDigit('7') },
    { action: 'bulletList', labelKey: 'editor.shortcut_bullet', label: 'Bullet list', keys: ['Mod', 'Shift', '8'], group: 'blocks', match: shiftDigit('8') },
    { action: 'taskList', labelKey: 'editor.shortcut_task', label: 'Task list', keys: ['Mod', 'Shift', '9'], group: 'blocks', match: shiftDigit('9') },
    { action: 'blockquote', labelKey: 'editor.shortcut_quote', label: 'Quote', keys: ['Mod', 'Shift', '.'], group: 'blocks', match: (e) => mod(e) && e.shiftKey && !e.altKey && (e.code === 'Period' || e.key === '>') },
    { action: 'codeBlock', labelKey: 'editor.shortcut_code_block', label: 'Code block', keys: ['Mod', 'Alt', 'C'], group: 'blocks', match: (e) => mod(e) && e.altKey && !e.shiftKey && !altGr(e) && e.code === 'KeyC' },
    { labelKey: 'editor.shortcut_indent', label: 'Indent a list item', keys: ['Tab'], group: 'blocks' },
    { labelKey: 'editor.shortcut_outdent', label: 'Outdent a list item', keys: ['Shift', 'Tab'], group: 'blocks' },
    { labelKey: 'editor.shortcut_line_break', label: 'Line break in the same paragraph', keys: ['Shift', 'Enter'], group: 'blocks' },
    { labelKey: 'editor.shortcut_slash', label: 'Insert a block', keys: ['/'], group: 'blocks' },
    { labelKey: 'editor.shortcut_undo', label: 'Undo', keys: ['Mod', 'Z'], group: 'document' },
    { labelKey: 'editor.shortcut_redo', label: 'Redo', keys: ['Mod', 'Shift', 'Z'], group: 'document' },
    { action: 'find', labelKey: 'editor.shortcut_find', label: 'Find in document', keys: ['Mod', 'F'], group: 'document', match: plain('f') },
    { action: 'shortcuts', labelKey: 'editor.shortcut_sheet', label: 'Show keyboard shortcuts', keys: ['Mod', '/'], group: 'document', match: (e) => mod(e) && !e.altKey && (e.key === '/' || e.code === 'Slash') },
];
/** What a formatting shortcut does, as an editor chain step. */
export const SHORTCUT_COMMANDS: Partial<Record<ShortcutAction, (chain: any) => any>> = {
    strike: (c) => c.toggleStrike(),
    code: (c) => c.toggleCode(),
    heading1: (c) => c.toggleHeading({ level: 1 }),
    heading2: (c) => c.toggleHeading({ level: 2 }),
    heading3: (c) => c.toggleHeading({ level: 3 }),
    paragraph: (c) => c.setParagraph(),
    bulletList: (c) => c.toggleBulletList(),
    orderedList: (c) => c.toggleOrderedList(),
    taskList: (c) => c.toggleTaskList(),
    blockquote: (c) => c.toggleBlockquote(),
    codeBlock: (c) => c.setCodeBlock(),
};

/** The action a key event triggers, or null. */
export function matchShortcut(e: KeyLike): ShortcutAction | null {
    for (const s of SHORTCUTS) if (s.action && s.match && s.match(e)) return s.action;
    return null;
}

export function isApplePlatform(): boolean {
    if (typeof navigator === 'undefined') return false;
    const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
    const platform = nav.userAgentData?.platform || nav.platform || '';
    return /mac|iphone|ipad|ipod/i.test(platform);
}

/** How a key part is shown on this platform. */
export function keyLabel(part: string, apple = isApplePlatform()): string {
    if (part === 'Mod') return apple ? '⌘' : 'Ctrl';
    if (part === 'Alt') return apple ? '⌥' : 'Alt';
    if (part === 'Shift') return apple ? '⇧' : 'Shift';
    return part;
}
