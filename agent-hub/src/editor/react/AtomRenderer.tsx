/**
 * AtomRenderer — the React side of an atom node (image, mermaid, math, formula,
 * chart): BeeEditor portals one into every atom host the view mounts.
 */
import React from 'react';
import ChartViewJs from '../nodeviews/ChartView.jsx';
import FormulaViewJs from '../nodeviews/FormulaView';
import ImageViewJs from '../nodeviews/ImageView';
import MathViewJs from '../nodeviews/MathView.jsx';
import MermaidViewJs from '../nodeviews/MermaidView.jsx';

/** An atom node as the engine hands it over (a plain JSON node). */
export interface AtomNode { type: string; attrs?: Record<string, any>; [key: string]: unknown }

interface NodeViewProps { node: AtomNode; view: any; editable: boolean; selected?: boolean; inline?: boolean }

// The node views are JavaScript components; their props are described here.
const ChartView = ChartViewJs;
const FormulaView = FormulaViewJs;
const ImageView = ImageViewJs as unknown as React.ComponentType<NodeViewProps>;
const MathView = MathViewJs;
const MermaidView = MermaidViewJs;

interface BoundaryProps { type: string; label: string; children?: React.ReactNode }
interface BoundaryState { error: unknown }

/**
 * One bad node view must not take the document down with it.
 *
 * Node views render content the user never authored directly — a chart spec or
 * mermaid source can arrive from an ingested document or an AI write. Without a
 * boundary here the nearest one wraps ALL of BeeEditor, so a single malformed
 * spec replaced the whole editor with the error screen, and its retry remounted
 * from the same content and crashed again: the notebook could not be opened.
 */
class AtomErrorBoundary extends React.Component<BoundaryProps, BoundaryState> {
  constructor(props: BoundaryProps) { super(props); this.state = { error: null }; }

  static getDerivedStateFromError(error: unknown): BoundaryState { return { error }; }

  componentDidCatch(error: unknown) {
    console.error(`[BeeEditor] ${this.props.type} node view failed to render`, error);
  }

  render() {
    if (this.state.error) {
      return (
        <span
          className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] select-none [background:var(--bg-tertiary)] [color:var(--text-tertiary)]! [border:1px_dashed_var(--border-default)]"
          title={String((this.state.error as { message?: string } | null)?.message || this.state.error)}
        >
          {this.props.label}
        </span>
      );
    }
    return this.props.children;
  }
}

interface AtomRendererProps { node: AtomNode; view: any; selected: boolean; editable: boolean; brokenLabel: string }

export default function AtomRenderer({ node, view, selected, editable, brokenLabel }: AtomRendererProps) {
  let el = null;
  if (node.type === 'image') el = <ImageView node={node} view={view} selected={selected} editable={editable} />;
  else if (node.type === 'mermaid') el = <MermaidView node={node} view={view} editable={editable} />;
  else if (node.type === 'mathBlock') el = <MathView node={node} view={view} inline={false} editable={editable} />;
  else if (node.type === 'mathInline') el = <MathView node={node} view={view} inline editable={editable} />;
  else if (node.type === 'formula') el = <FormulaView node={node} view={view} editable={editable} />;
  else if (node.type === 'chart') el = <ChartView node={node} view={view} editable={editable} />;
  if (!el) return null;
  return <AtomErrorBoundary type={node.type} label={brokenLabel}>{el}</AtomErrorBoundary>;
}
