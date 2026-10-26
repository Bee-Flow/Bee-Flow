import {
  Bold, Italic, Underline as UnderlineIcon, Strikethrough, List, ListOrdered, Quote,
  Heading1, Heading2, Heading3, AlignLeft, AlignCenter, AlignRight,
  Highlighter, Wand2, RefreshCw, Scissors, Expand, Code, Link as LinkIcon,
  ChevronDown, CheckSquare, Palette, Pilcrow,
} from 'lucide-react';
import type React from 'react';
import type { TranslateFn } from '@/hooks/useTranslation';
import { selectionText } from '../editorDom';
import {
  Btn as BtnJs, Dropdown as DropdownJs, Item as ItemJs, MenuDivider as MenuDividerJs,
  MenuLabel as MenuLabelJs, BubbleDivider as BubbleDividerJs, mkTt,
  FONT_FAMILIES, PALETTE, HIGHLIGHTS,
} from '../toolbarPrimitives.jsx';
import useFloatingRectJs from '../useFloatingRect.js';
import type { AskState } from './AskPortal';

// The toolbar primitives are JavaScript components; their props are described here.
type SetOpen = (next: boolean | ((open: boolean) => boolean)) => void;
type Icon = React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
const Btn = BtnJs;
const Item = ItemJs;
const Dropdown = DropdownJs;
const MenuDivider = MenuDividerJs;
const MenuLabel = MenuLabelJs;
const BubbleDivider = BubbleDividerJs;
const useFloatingRect = useFloatingRectJs;

interface Props {
  view: any;
  editor: any;
  t: TranslateFn;
  askAiEnabled: boolean;
  /** Run an AI action ('rewrite' | 'shorten' | 'expand') on the selection. */
  onAction: (key: string) => void;
  onAsk: (anchor: AskState['anchor'], from: number, to: number, text: string) => void;
  /** The ask box or link editor is open: the bubble steps aside. */
  askOpen: boolean;
  onLink?: () => void;
}

// FormatBubble — the contextual formatter shown on a text selection. It is now
// the PRIMARY formatting surface (the persistent toolbar was demoted): inline
// marks + "turn into" block type + alignment + colour/highlight/font + AI.
export default function FormatBubble({ view, editor, t, askAiEnabled, onAction, onAsk, askOpen, onLink }: Props) {
  const rect = useFloatingRect(view, { enabled: !askOpen });
  if (!rect || !editor) return null;
  const tt = mkTt(t);
  const chain = () => editor.chain().focus();
  const align = (a: string) => editor.isActive({ align: a });
  const currentColor = editor.getAttributes('textStyle').color || null;
  const currentFont = editor.getAttributes('textStyle').fontFamily || null;
  const isPlain = !editor.isActive('heading') && !editor.isActive('bulletList') && !editor.isActive('orderedList') && !editor.isActive('taskList') && !editor.isActive('blockquote');

  // Above the selection, flipping below when there's no room; clamp horizontally.
  const W = 360;
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1200;
  const left = Math.max(8, Math.min(rect.left, vw - W - 8));
  const above = rect.top - 46;
  const top = above < 8 ? rect.bottom + 8 : above;

  const turnLabel = editor.isActive('heading', { level: 1 }) ? 'H1'
    : editor.isActive('heading', { level: 2 }) ? 'H2'
    : editor.isActive('heading', { level: 3 }) ? 'H3'
    : editor.isActive('bulletList') ? '•'
    : editor.isActive('orderedList') ? '1.'
    : editor.isActive('taskList') ? '☑'
    : editor.isActive('blockquote') ? '❝'
    : tt('notebooks.paragraph', 'Text');

  return (
    <div className="fixed z-[9998] flex items-center flex-wrap px-1.5 py-1 rounded-xl shadow-xl border backdrop-blur-md"
      style={{ top, left, gap: 2, maxWidth: 'min(94vw, 540px)', background: 'var(--bg-primary)', borderColor: 'var(--border-default)' }}
      role="toolbar" aria-label={tt('notebooks.format', 'Format')}
      onMouseDown={(e) => e.preventDefault()}>
      <Btn onClick={() => chain().toggleBold().run()} active={editor.isActive('bold')} icon={Bold} title={tt('notebooks.bold', 'Bold')} />
      <Btn onClick={() => chain().toggleItalic().run()} active={editor.isActive('italic')} icon={Italic} title={tt('notebooks.italic', 'Italic')} />
      <Btn onClick={() => chain().toggleUnderline().run()} active={editor.isActive('underline')} icon={UnderlineIcon} title={tt('notebooks.underline', 'Underline')} />
      <Btn onClick={() => chain().toggleStrike().run()} active={editor.isActive('strike')} icon={Strikethrough} title={tt('notebooks.strikethrough', 'Strikethrough')} />
      <Btn onClick={() => chain().toggleCode().run()} active={editor.isActive('code')} icon={Code} title={tt('notebooks.inline_code', 'Inline code')} />
      <Btn onClick={() => chain().toggleHighlight().run()} active={editor.isActive('highlight')} icon={Highlighter} title={tt('notebooks.highlight', 'Highlight')} />
      <Btn onClick={() => onLink?.()} active={editor.isActive('link')} icon={LinkIcon} title={tt('notebooks.insert_link', 'Insert link')} />

      <BubbleDivider />

      {/* Turn into block type */}
      <Dropdown trigger={(open, setOpen) => (
        <button onMouseDown={(e) => { e.preventDefault(); setOpen((o) => !o); }} className="flex items-center gap-1 px-1.5 py-1 rounded-md text-[11px] font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]" title={tt('notebooks.turn_into', 'Turn into')}>
          <span className="min-w-[14px] text-center">{turnLabel}</span><ChevronDown className="w-3 h-3 opacity-50" />
        </button>
      )}>
        {(setOpen) => (
          <>
            <Item icon={Pilcrow} label={tt('notebooks.paragraph', 'Text')} active={isPlain} onClick={() => { chain().setParagraph().run(); setOpen(false); }} />
            <Item icon={Heading1} label={tt('notebooks.heading_1', 'Heading 1')} active={editor.isActive('heading', { level: 1 })} onClick={() => { chain().toggleHeading({ level: 1 }).run(); setOpen(false); }} />
            <Item icon={Heading2} label={tt('notebooks.heading_2', 'Heading 2')} active={editor.isActive('heading', { level: 2 })} onClick={() => { chain().toggleHeading({ level: 2 }).run(); setOpen(false); }} />
            <Item icon={Heading3} label={tt('notebooks.heading_3', 'Heading 3')} active={editor.isActive('heading', { level: 3 })} onClick={() => { chain().toggleHeading({ level: 3 }).run(); setOpen(false); }} />
            <MenuDivider />
            <Item icon={List} label={tt('notebooks.bullet_list', 'Bullet list')} active={editor.isActive('bulletList')} onClick={() => { chain().toggleBulletList().run(); setOpen(false); }} />
            <Item icon={ListOrdered} label={tt('notebooks.numbered_list', 'Numbered list')} active={editor.isActive('orderedList')} onClick={() => { chain().toggleOrderedList().run(); setOpen(false); }} />
            <Item icon={CheckSquare} label={tt('notebooks.task_list', 'Task list')} active={editor.isActive('taskList')} onClick={() => { chain().toggleTaskList().run(); setOpen(false); }} />
            <Item icon={Quote} label={tt('notebooks.blockquote', 'Quote')} active={editor.isActive('blockquote')} onClick={() => { chain().toggleBlockquote().run(); setOpen(false); }} />
          </>
        )}
      </Dropdown>

      {/* Alignment */}
      <Dropdown trigger={(open, setOpen) => (
        <button onMouseDown={(e) => { e.preventDefault(); setOpen((o) => !o); }} className={`flex items-center gap-0.5 p-1.5 rounded-md ${align('center') || align('right') ? 'text-[var(--accent-primary)] bg-[var(--accent-primary)]/10' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'}`} title={tt('notebooks.alignment', 'Alignment')}>
          <AlignLeft className="w-3.5 h-3.5" /><ChevronDown className="w-2.5 h-2.5 opacity-50" />
        </button>
      )}>
        {(setOpen) => (
          <>
            <Item icon={AlignLeft} label={tt('notebooks.align_left', 'Align left')} active={align('left')} onClick={() => { chain().setTextAlign('left').run(); setOpen(false); }} />
            <Item icon={AlignCenter} label={tt('notebooks.align_center', 'Center')} active={align('center')} onClick={() => { chain().setTextAlign('center').run(); setOpen(false); }} />
            <Item icon={AlignRight} label={tt('notebooks.align_right', 'Align right')} active={align('right')} onClick={() => { chain().setTextAlign('right').run(); setOpen(false); }} />
          </>
        )}
      </Dropdown>

      {/* Colour / highlight / font */}
      <Dropdown trigger={(open, setOpen) => (
        <button onMouseDown={(e) => { e.preventDefault(); setOpen((o) => !o); }} className={`flex items-center gap-1 p-1.5 rounded-md hover:bg-[var(--bg-tertiary)] ${currentColor || currentFont ? 'bg-[var(--accent-primary)]/10' : ''}`} title={tt('notebooks.text_style', 'Text style')}>
          <Palette className="w-3.5 h-3.5" style={{ color: currentColor || 'currentColor' }} /><ChevronDown className="w-2.5 h-2.5 opacity-50" />
        </button>
      )}>
        {(setOpen) => (
          <div className="p-2.5 min-w-[208px]">
            <MenuLabel>{tt('notebooks.text_color', 'Text color')}</MenuLabel>
            <div className="grid grid-cols-8 gap-1 mb-1.5">
              {PALETTE.map((c) => (
                <button key={c} onMouseDown={(e) => { e.preventDefault(); chain().setColor(c).run(); }} className="w-5 h-5 rounded-md border hover:scale-110 transition-transform" style={{ background: c, borderColor: currentColor === c ? 'white' : 'transparent', boxShadow: currentColor === c ? `0 0 0 2px ${c}` : 'none' }} />
              ))}
            </div>
            <div className="flex items-center justify-between mb-2">
              <label className="flex items-center gap-1.5 text-[10px] cursor-pointer text-[var(--text-secondary)]">
                <input type="color" value={currentColor || '#000000'} onChange={(e) => chain().setColor(e.target.value).run()} className="w-5 h-5 rounded cursor-pointer border-0 bg-transparent p-0" />
                {tt('notebooks.custom', 'Custom')}
              </label>
              <button onMouseDown={(e) => { e.preventDefault(); chain().unsetColor().run(); }} className="text-[10px] [color:var(--text-muted)]!">✕ {tt('notebooks.reset', 'Reset')}</button>
            </div>
            <MenuLabel>{tt('notebooks.highlight', 'Highlight')}</MenuLabel>
            <div className="grid grid-cols-8 gap-1 mb-1.5">
              {HIGHLIGHTS.map((c) => (
                <button key={c} onMouseDown={(e) => { e.preventDefault(); chain().toggleHighlight({ color: c }).run(); }} className="w-5 h-5 rounded-md border hover:scale-110 transition-transform" style={{ background: c, borderColor: 'transparent' }} />
              ))}
            </div>
            <MenuLabel>{tt('notebooks.font', 'Font')}</MenuLabel>
            <div className="max-h-[150px] overflow-y-auto custom-scrollbar -mx-1">
              {FONT_FAMILIES.map((f) => (
                <button key={f.label} onMouseDown={(e) => { e.preventDefault(); f.value ? chain().setFontFamily(f.value).run() : chain().unsetFontFamily().run(); setOpen(false); }} className={`flex items-center w-full px-2 py-1 text-[11px] rounded hover:bg-[var(--bg-tertiary)] ${f.value === currentFont ? 'text-[var(--accent-primary)] font-semibold' : 'text-[var(--text-secondary)]'}`} style={{ fontFamily: f.css }}>{f.label}</button>
              ))}
            </div>
          </div>
        )}
      </Dropdown>

      {askAiEnabled && (
        <>
          <BubbleDivider />
          {([['rewrite', RefreshCw, tt('notebooks.ai_action_rewrite', 'Rewrite')], ['shorten', Scissors, tt('notebooks.ai_action_shorten', 'Shorten')], ['expand', Expand, tt('notebooks.ai_action_expand', 'Expand')]] as const).map(([k, Icon, label]) => (
            <button key={k} onClick={() => onAction(k)} className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] hover:bg-[var(--bg-tertiary)] [color:var(--text-secondary)]!">
              <Icon className="w-3 h-3" /> {label}
            </button>
          ))}
          <button onClick={() => onAsk({ top: rect.top, left: rect.left }, view.selectionFlat?.()?.from ?? 0, view.selectionFlat?.()?.to ?? 0, selectionText(view))}
            className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] [color:var(--accent-primary)]!">
            <Wand2 className="w-3 h-3" /> {tt('notebooks.ask_ai', 'Ask AI')}
          </button>
        </>
      )}
    </div>
  );
}
