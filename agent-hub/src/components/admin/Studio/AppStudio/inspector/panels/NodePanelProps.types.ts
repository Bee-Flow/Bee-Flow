import type { AppNode } from '../appDefinition';
import type { InspectorPanelProps } from '../registry';

/** What the inspector hands a per-type Content panel, with `P` the shape of that component's own props. */
export type NodePanelProps<P> = Omit<InspectorPanelProps, 'node'> & { node: AppNode<P> };
