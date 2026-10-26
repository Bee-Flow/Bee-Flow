import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import useTranslation from '@/hooks/useTranslation';
import CellValueJs from '../cellValue';
import { CLAMP_STYLE } from './gridConstants';

// cellValue.jsx is still JavaScript; its JSDoc types the props.
export const CellValue = CellValueJs;

/**
 * The cell-level pieces of the App Studio data grid: the peek panel for a
 * clipped cell, the inline editor and the click-to-edit cell. Moved out of
 * AppDataGrid.jsx verbatim.
 */

/**
 * The panel that shows what a clamped cell is hiding.
 *
 * Fixed to the viewport rather than positioned inside the row: the cell lives
 * in a scroll container with `overflow: auto`, and an absolutely-positioned
 * panel would be clipped by exactly the box it needs to escape. It flips above
 * the cell near the bottom of the window, and scrolls internally rather than
 * growing past the fold — some of these notes run to a dozen sentences.
 *
 * aria-hidden, and deliberately so. The full text is already in the DOM (the
 * clamp hides it visually, it does not remove it), so a screen reader reads the
 * cell in full without this. Announcing it twice would be worse than not at all.
 */
export interface PeekState {
    text: string;
    top: number;
    bottom: number;
    left: number;
    above: boolean;
}

export function CellPeek({ peek }: { peek: PeekState | null }) {
    if (!peek) return null;
    const WIDTH = 420;
    const left = Math.max(8, Math.min(peek.left, window.innerWidth - WIDTH - 8));
    return (
        <div
            aria-hidden="true"
            data-app-cell-peek="true"
            className="fixed z-50 border p-2.5 text-xs shadow-lg"
            style={{
                left,
                ...(peek.above ? { bottom: window.innerHeight - peek.bottom + 6 } : { top: peek.top + 6 }),
                width: WIDTH,
                maxHeight: '40vh',
                overflowY: 'auto',
                whiteSpace: 'pre-wrap',
                background: 'var(--bg-card)',
                borderColor: 'var(--border-default)',
                borderRadius: 'var(--app-radius)',
                color: 'var(--text-primary)',
            }}
        >
            {peek.text}
        </div>
    );
}

/** Formats a column can edit as a native date control. */
const DATE_EDIT: Record<string, string> = { date: 'date', datetime: 'datetime-local' };

const EDIT_INPUT_CLASS = 'w-full bg-transparent border px-1.5 py-0.5 text-inherit outline-none focus:border-[var(--app-primary)]';
const EDIT_INPUT_STYLE = { borderColor: 'var(--border-default)', borderRadius: 'var(--app-radius)', color: 'var(--text-primary)' };

/**
 * The editor half of an editable cell — mounted only while the cell is open.
 *
 * `datetime-local` wants 'YYYY-MM-DDTHH:mm' and a stored ISO string carries
 * seconds and a zone, which the control silently rejects (it renders blank, so
 * the value looks deleted). Slice it to what the control accepts and hand back
 * what the column stores.
 */
interface EditOption { value: unknown; label?: unknown }

interface GridColumnSpec {
    key: string;
    label?: string;
    toneMap?: Array<{ value: unknown; label?: unknown }>;
    [extra: string]: unknown;
}

interface CellEditorProps {
    initial: unknown;
    format: string;
    options: EditOption[] | null;
    onCommit: (next: unknown) => void;
    onCancel: () => void;
}

function CellEditor({ initial, format, options, onCommit, onCancel }: CellEditorProps) {
    const { t } = useTranslation();
    const [draft, setDraft] = useState<unknown>(() => {
        if (initial == null) return '';
        if (format === 'datetime') return String(initial).slice(0, 16);
        if (format === 'date') return String(initial).slice(0, 10);
        return initial;
    });
    const ref = useRef<HTMLInputElement & HTMLSelectElement>(null);
    useEffect(() => { ref.current?.focus(); }, []);

    const commit = () => {
        const raw = draft;
        const next = format === 'number' && raw !== '' && Number.isFinite(Number(raw)) ? Number(raw) : raw;
        onCommit(next);
    };
    // Escape must not also commit. It fires before blur, so the cancel has to
    // close the editor in a way the blur handler can see — hence onCancel
    // unmounting us rather than a flag we would have to read back.
    const onKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); return; }
        // Enter commits. Tab does NOT get intercepted: letting the browser move
        // focus is what makes tabbing along a row work, and blur commits on the
        // way out.
        if (e.key === 'Enter' && format !== 'textarea') { e.preventDefault(); commit(); }
    };

    if (options) {
        return (
            <select
                ref={ref}
                value={(draft ?? '') as string}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commit}
                onKeyDown={onKeyDown}
                className={EDIT_INPUT_CLASS}
                style={EDIT_INPUT_STYLE}
                aria-label={t('studio_apps_runtime.grid.edit_cell', 'Edit cell')}
            >
                {/* A blank option so a value can be cleared — without it a
                    required-looking dropdown can never go back to empty. */}
                <option value="">—</option>
                {options.map((o) => <option key={String(o.value)} value={o.value as string}>{String(o.label ?? o.value)}</option>)}
            </select>
        );
    }

    return (
        <input
            ref={ref}
            value={(draft ?? '') as string}
            type={DATE_EDIT[format] || (format === 'number' ? 'number' : 'text')}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={onKeyDown}
            className={EDIT_INPUT_CLASS}
            style={EDIT_INPUT_STYLE}
            aria-label={t('studio_apps_runtime.grid.edit_cell', 'Edit cell')}
        />
    );
}

/**
 * An editable cell — the display value until you ask to change it.
 *
 * This used to render a live <input> for EVERY row of an editable column, from
 * the first paint. A backlog of forty items with four editable columns was a
 * wall of a hundred and sixty boxes: the data was there, but nothing in it
 * could be read at a glance, and the screen looked like a form rather than a
 * table. Now the cell shows its value and opens an editor on click, Enter or
 * F2 — the same gesture every spreadsheet has taught people to expect.
 *
 * Tab is deliberately NOT intercepted: the browser moves focus to the next
 * cell's trigger, and blur commits on the way past. Enter commits and closes
 * rather than stepping down a row — with the grid virtualized, the row below
 * may not exist in the DOM to receive focus, and a key that usually works is
 * worse than one that never claimed to.
 */
interface EditableCellProps {
    value: unknown;
    format: string;
    col: GridColumnSpec;
    row: unknown;
    now: number | null;
    onCommit: (next: unknown) => void;
    clamp?: number;
}

export function EditableCell({ value, format, col, row, now, onCommit, clamp = 0 }: EditableCellProps) {
    const { t } = useTranslation();
    const [editing, setEditing] = useState(false);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const close = (focusBack: boolean) => {
        setEditing(false);
        if (focusBack) triggerRef.current?.focus();
    };

    // A tick box has exactly two states and no text to type: clicking IS the
    // edit. Opening an editor to choose between two values would be ceremony.
    const isToggle = format === 'check' || format === 'boolean';
    // A column that names its values can only hold one of them — offer the list
    // rather than free text, which is how 'doing' used to become 'diong'.
    const options = Array.isArray(col?.toneMap) && col.toneMap.length
        ? col.toneMap.map((m) => ({ value: m.value, label: m.label ?? m.value }))
        : null;

    if (editing) {
        return (
            <CellEditor
                initial={value}
                format={format}
                options={options}
                onCommit={(next) => { close(true); if (next !== value) onCommit(next); }}
                onCancel={() => close(true)}
            />
        );
    }

    return (
        <button
            ref={triggerRef}
            type="button"
            onClick={() => (isToggle ? onCommit(!value) : setEditing(true))}
            onKeyDown={(e) => {
                if (e.key !== 'F2') return;
                e.preventDefault();
                if (isToggle) onCommit(!value); else setEditing(true);
            }}
            className="app-grid-editable w-full app-focusable"
            // A button centres its text in the UA stylesheet, which would undo
            // the column's alignment — the numbers would drift back off the
            // right edge they were just lined up on.
            //
            // The clamp has to land HERE, not only on the wrapper outside. A
            // button is an atomic box in its parent's inline flow, so a
            // -webkit-line-clamp above it counted the whole button as one line
            // and clipped nothing: every editable text column ignored the
            // reader's "Long text" setting entirely, and one chatty AI note
            // made a row forty lines tall.
            style={{ textAlign: 'inherit', ...(clamp ? CLAMP_STYLE[clamp] : null) }}
            data-app-clamped={clamp ? 'true' : undefined}
            aria-label={col?.label || col?.key
                ? t('studio_apps_runtime.grid.edit_column', 'Edit {name}', { name: col?.label || col?.key })
                : t('studio_apps_runtime.grid.edit_cell', 'Edit cell')}
        >
            <CellValue value={value} format={format} col={col} row={row} now={now} />
        </button>
    );
}
