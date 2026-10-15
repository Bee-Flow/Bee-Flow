import type { ReactNode } from 'react';
import type { AppNode } from '../../inspector/appDefinition';

/** The props every runtime component receives; `P` is the shape of its node's props. */
export interface NodeProps<P = Record<string, unknown>> {
    node: AppNode<P>;
    children?: ReactNode;
}
