import { Suspense, type ComponentProps } from 'react';
import { lazy } from '@/utils/lazyWithReload';
import { registerInspector } from '../registry';

/**
 * The inspector panel of custom_block, registered here and loaded when a block is selected:
 * the panel brings the template engine, the stylesheet sanitiser and the preview frame
 * (./CustomBlockInspector.tsx), which the editor does not need until then.
 */
const CustomBlockInspector = lazy(() => import('./CustomBlockInspector'));

export default function CustomBlockPanel(props: ComponentProps<typeof CustomBlockInspector>) {
    return (
        <Suspense fallback={null}>
            <CustomBlockInspector {...props} />
        </Suspense>
    );
}

registerInspector('custom_block', CustomBlockPanel, { props: ['block'] });
