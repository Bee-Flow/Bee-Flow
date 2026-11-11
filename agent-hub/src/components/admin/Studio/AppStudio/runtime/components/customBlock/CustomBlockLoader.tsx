import { useEffect, useState, type ComponentType } from 'react';
import { importWithReload } from '@/utils/lazyWithReload';
import { logger } from '@/utils/logger';
import type { NodeProps } from '../appNode.types';

/**
 * App Studio runtime: 'custom_block', loaded when an app draws one. The template engine, the
 * stylesheet sanitiser and the frame pipeline (./AppCustomBlock.tsx and what it imports) are
 * their own chunk, so only an app that uses a block pays for them.
 *
 * Until the chunk is in, the block's place holds an empty box of its default height. A host
 * that renders once and reads the result (the headless render behind the screenshots and the
 * look snapshots) awaits `loadCustomBlock()` before it renders: the block then draws on the
 * first render, as it did when it was part of the runtime.
 */

type BlockComponent = ComponentType<NodeProps<never>>;

let loaded: BlockComponent | null = null;
let loading: Promise<BlockComponent> | null = null;

/** The block's component; one fetch for every block on the page. */
export function loadCustomBlock(): Promise<BlockComponent> {
    loading ??= importWithReload(() => import('./AppCustomBlock')).then(
        (mod) => {
            loaded = mod.default as BlockComponent;
            return loaded;
        },
        (err: unknown) => {
            loading = null;
            throw err;
        },
    );
    return loading;
}

export default function CustomBlockLoader(props: NodeProps<never>) {
    const [Block, setBlock] = useState<BlockComponent | null>(() => loaded);
    useEffect(() => {
        if (Block) return undefined;
        let live = true;
        loadCustomBlock().then(
            (component) => { if (live) setBlock(() => component); },
            (err: unknown) => logger.warn('custom block: the component did not load', err),
        );
        return () => { live = false; };
    }, [Block]);
    if (!Block) return <div className="min-h-24 w-full" data-custom-block-loading="true" aria-busy="true" />;
    return <Block {...props} />;
}
