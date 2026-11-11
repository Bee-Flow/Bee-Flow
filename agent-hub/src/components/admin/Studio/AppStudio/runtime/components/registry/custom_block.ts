import { CodeXml } from 'lucide-react';
import CustomBlockLoader from '../customBlock/CustomBlockLoader';
import type { ComponentExtension } from '../../componentRegistry.types';

/**
 * `custom_block`: the builder's own HTML template and stylesheet in a frame without script
 * (../customBlock/). The renderer loads its own chunk when an app draws a block.
 */
const customBlock: ComponentExtension = {
    Component: CustomBlockLoader as ComponentExtension['Component'],
    icon: CodeXml,
    sample: {
        props: {
            block: {
                template: '<div class="note"><strong>Hello {{ name }}</strong><span>This block is yours: write its template and stylesheet.</span></div>',
                css: '.note{display:flex;flex-direction:column;gap:4px;padding:16px;border:1px solid var(--bf-border);border-radius:var(--bf-radius);background:var(--bf-surface)}strong{color:var(--bf-primary)}',
                inputs: { name: { kind: 'static', value: 'there' } },
            },
        },
    },
};

export default customBlock;
