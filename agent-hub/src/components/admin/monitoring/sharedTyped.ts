import { Empty as EmptyJs, MetricTile as MetricTileJs } from './shared';
import MarkdownRendererJs from '../../renderers/MarkdownRenderer';

// MarkdownRenderer is plain JS: TypeScript reads every destructured prop
// without a default as required. These are the props the TypeScript
// monitoring views pass (same approach as blog/jsComponents.ts).

export const Empty = EmptyJs;

export const MetricTile = MetricTileJs;

export const MarkdownRenderer = MarkdownRendererJs;
