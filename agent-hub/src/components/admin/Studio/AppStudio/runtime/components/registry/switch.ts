import { ToggleRight } from 'lucide-react';
import type { ComponentExtension } from '../../componentRegistry.types';
import AppSwitch from '../AppSwitch';

const entry: ComponentExtension = {
    Component: AppSwitch,
    icon: ToggleRight,
    sample: { props: { name: 'enabled', label: 'Enabled' } },
};

export default entry;
