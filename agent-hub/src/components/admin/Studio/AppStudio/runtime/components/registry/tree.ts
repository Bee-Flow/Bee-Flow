import { ListTree } from 'lucide-react';
import type { ComponentExtension } from '../../componentRegistry.types';
import AppTree from '../AppTree';

const entry: ComponentExtension = {
    Component: AppTree,
    icon: ListTree,
    sample: {
        props: {
            parentKey: 'parent',
            source: { kind: 'static', value: [{ id: 'a', title: 'Folder' }, { id: 'b', title: 'Item', parent: 'a' }] },
        },
    },
};

export default entry;
