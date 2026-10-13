/**
 * The block-insert catalogue, shared by the status-strip Insert menu and the
 * slash menu (`slashOnly` items appear in the slash menu alone).
 */
import {
  Heading1, Heading2, Heading3, List, ListOrdered, CheckSquare, Quote, Code,
  Table2, Minus, ImageIcon, Sigma,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { TranslateFn } from '../../hooks/useTranslation';
import { mkTt } from './toolbarPrimitives.jsx';

/** An editor command chain (`view.chain().focus()`): every step returns the chain. */
type Chain = any;

/** One entry: `apply` extends the chain, or `action` names a step BeeEditor runs itself. */
export interface InsertItem {
  key: string;
  icon: LucideIcon;
  label: string;
  keywords: string;
  slashOnly?: boolean;
  apply?: (c: Chain) => Chain;
  action?: 'image' | 'math';
}

export function buildInsertItems(t: TranslateFn): InsertItem[] {
  const tt = mkTt(t);
  return [
    { key: 'h1', icon: Heading1, label: tt('notebooks.heading_1', 'Heading 1'), keywords: 'h1 title', apply: (c) => c.toggleHeading({ level: 1 }) },
    { key: 'h2', icon: Heading2, label: tt('notebooks.heading_2', 'Heading 2'), keywords: 'h2 subtitle', apply: (c) => c.toggleHeading({ level: 2 }) },
    { key: 'h3', icon: Heading3, label: tt('notebooks.heading_3', 'Heading 3'), keywords: 'h3', apply: (c) => c.toggleHeading({ level: 3 }) },
    { key: 'bullet', icon: List, label: tt('notebooks.bullet_list', 'Bullet list'), keywords: 'ul unordered', apply: (c) => c.toggleBulletList() },
    { key: 'ordered', icon: ListOrdered, label: tt('notebooks.numbered_list', 'Numbered list'), keywords: 'ol numbered', apply: (c) => c.toggleOrderedList() },
    { key: 'task', icon: CheckSquare, label: tt('notebooks.task_list', 'Task list'), keywords: 'todo checkbox', apply: (c) => c.toggleTaskList() },
    { key: 'quote', icon: Quote, label: tt('notebooks.blockquote', 'Quote'), keywords: 'blockquote', apply: (c) => c.toggleBlockquote() },
    { key: 'code', icon: Code, label: tt('notebooks.code_block', 'Code block'), keywords: 'pre snippet', apply: (c) => c.setCodeBlock() },
    // Slash-menu only. The toolbar has a dedicated Table button whose size
    // picker sits right next to the Insert menu, so offering a second entry
    // point that silently inserts a fixed 3×3 read as the picker being broken
    // (BFSF-316). Typing "/table" is a keyboard flow where a sensible default
    // is what you want, so it stays there.
    { key: 'table', icon: Table2, label: tt('notebooks.table', 'Table'), keywords: 'grid', slashOnly: true, apply: (c) => c.insertTable({ rows: 3, cols: 3, withHeaderRow: true }) },
    { key: 'divider', icon: Minus, label: tt('notebooks.divider', 'Divider'), keywords: 'hr rule horizontal', apply: (c) => c.setHorizontalRule() },
    { key: 'image', icon: ImageIcon, label: tt('notebooks.upload_image', 'Image'), keywords: 'picture photo', action: 'image' },
    { key: 'math', icon: Sigma, label: tt('notebooks.math_formula', 'Math'), keywords: 'formula latex equation', action: 'math' },
  ];
}
