import { Atom } from 'lucide-react';
import AppReactBlock from '../reactBlock/AppReactBlock';
import type { ComponentExtension } from '../../componentRegistry.types';

/**
 * `react_block`: the builder's own React component in a sealed frame (../reactBlock/). The
 * React runtime the frame runs is its own chunk, loaded when an app draws a block.
 */
const reactBlock: ComponentExtension = {
    Component: AppReactBlock as ComponentExtension['Component'],
    icon: Atom,
    sample: { props: {} },
};

export default reactBlock;
