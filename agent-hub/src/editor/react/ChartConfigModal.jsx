/**
 * ChartConfigModal — pick a chart type + which column holds the labels and which
 * column(s) hold the series, then snapshot the table into a `chart` block. Kept
 * self-contained (tokens + lucide + the dependency-free shared Modal, which
 * brings Escape, the focus trap and focus restore) so the editor stays free of
 * app coupling.
 */
import { BarChart3, LineChart as LineIcon, PieChart as PieIcon, AreaChart as AreaIcon, X } from 'lucide-react';
import React, { useId, useState } from 'react';
import { mkTt } from './toolbarPrimitives.jsx';
import Modal from '../../components/shared/Modal';

// The chart types travel as DATA, so each row carries its translation key
// beside the English instead of a bare label. `id` is the chart TYPE — the
// React list key, the value handed to setType(), the one compared against the
// current type — and `key` is the translation key; they were the same field
// (`key: 'bar'`) until the labels became translatable, which is why the two
// names are now spelled apart. `en` is the fallback argument to tt(), never
// the rendered default.
const TYPES = [
  { id: 'bar', key: 'notebooks.chart_type_bar', en: 'Bar', icon: BarChart3 },
  { id: 'line', key: 'notebooks.chart_type_line', en: 'Line', icon: LineIcon },
  { id: 'area', key: 'notebooks.chart_type_area', en: 'Area', icon: AreaIcon },
  { id: 'pie', key: 'notebooks.chart_type_pie', en: 'Pie', icon: PieIcon },
];

export default function ChartConfigModal({ columns, rows, t, onCreate, onClose }) {
  // The shared pass-through, not a local copy: the hand-rolled shim this
  // replaced called the ONE-argument `t(k)` and judged the result itself, so it
  // could never forward params — `tt(key, 'Labels ({axis})', { axis: 'X' })`
  // put `{axis}` on the screen. See mkTt's own comment.
  const tt = mkTt(t);
  const titleId = useId();
  const [type, setType] = useState('bar');
  const [labelCol, setLabelCol] = useState(0);
  const [seriesCols, setSeriesCols] = useState(() => columns.map((_, i) => i).filter((i) => i !== 0).slice(0, type === 'pie' ? 1 : undefined));
  const [title, setTitle] = useState('');

  const toggleSeries = (i) => {
    if (type === 'pie') { setSeriesCols([i]); return; }
    setSeriesCols((prev) => (prev.includes(i) ? prev.filter((x) => x !== i) : [...prev, i]).sort((a, b) => a - b));
  };

  const create = () => {
    const labels = rows.map((r) => r[labelCol] ?? '');
    const cols = type === 'pie' ? seriesCols.slice(0, 1) : seriesCols;
    const series = cols.map((ci) => ({ name: columns[ci] || `Column ${ci + 1}`, data: rows.map((r) => Number(r[ci]) || 0) }));
    onCreate({ type, title: title.trim() || null, labels, series });
  };

  const valid = seriesCols.length > 0 && rows.length > 0 && labelCol != null;

  // z 10060: above the editor's floating toolbars and their menus. A press
  // inside the panel still stops at the panel, as it did before the move to
  // Modal, so the editor's outside-press handlers never see it.
  return (
    <Modal open onClose={onClose} variant="bare" size="auto" zIndex={10060} labelledBy={titleId} className="max-w-[420px]">
      <div className="w-full rounded-2xl border shadow-2xl" style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-default)' }} onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
          <h3 id={titleId} className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{tt('notebooks.create_chart', 'Create chart')}</h3>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-[var(--bg-tertiary)]" style={{ color: 'var(--text-secondary)' }}><X className="w-4 h-4" /></button>
        </div>

        <div className="p-4 space-y-3">
          <div className="grid grid-cols-4 gap-1.5">
            {TYPES.map(({ id, key, en, icon: Icon }) => (
              <button key={id}
                onClick={() => { setType(id); if (id === 'pie') setSeriesCols((p) => p.slice(0, 1)); }}
                className="flex flex-col items-center gap-1 py-2 rounded-lg border text-[11px] transition-colors"
                style={type === id ? { borderColor: 'var(--accent-primary)', color: 'var(--accent-primary)', background: 'var(--accent-primary)10' } : { borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}>
                <Icon className="w-4 h-4" /> {tt(key, en)}
              </button>
            ))}
          </div>

          <label className="block">
            <span className="text-[11px] font-medium" style={{ color: 'var(--text-secondary)' }}>{tt('notebooks.chart_title', 'Title (optional)')}</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} className="mt-1 w-full px-2.5 py-1.5 rounded-lg border text-[12px] outline-none"
              style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }} />
          </label>

          <label className="block">
            <span className="text-[11px] font-medium" style={{ color: 'var(--text-secondary)' }}>{tt('notebooks.chart_labels', 'Labels (X axis)')}</span>
            <select value={labelCol} onChange={(e) => setLabelCol(+e.target.value)} className="mt-1 w-full px-2.5 py-1.5 rounded-lg border text-[12px] outline-none"
              style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}>
              {columns.map((c, i) => <option key={i} value={i}>{c || `Column ${i + 1}`}</option>)}
            </select>
          </label>

          <div>
            <span className="text-[11px] font-medium" style={{ color: 'var(--text-secondary)' }}>
              {type === 'pie' ? tt('notebooks.chart_value', 'Values') : tt('notebooks.chart_series', 'Series (Y axis)')}
            </span>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {columns.map((c, i) => (i === labelCol ? null : (
                <button key={i} onClick={() => toggleSeries(i)}
                  className="px-2.5 py-1 rounded-full border text-[11px] transition-colors"
                  style={seriesCols.includes(i) ? { borderColor: 'var(--accent-primary)', color: 'var(--accent-primary)', background: 'var(--accent-primary)10' } : { borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}>
                  {c || `Column ${i + 1}`}
                </button>
              )))}
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 px-4 py-3 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
          <button onClick={onClose} className="px-3 py-1.5 rounded-lg text-[12px] font-medium hover:bg-[var(--bg-tertiary)]" style={{ color: 'var(--text-secondary)' }}>{tt('notebooks.cancel', 'Cancel')}</button>
          <button onClick={create} disabled={!valid} className="px-3 py-1.5 rounded-lg text-[12px] font-semibold text-white disabled:opacity-40" style={{ background: 'var(--accent-primary)' }}>{tt('notebooks.create', 'Create')}</button>
        </div>
      </div>
    </Modal>
  );
}
