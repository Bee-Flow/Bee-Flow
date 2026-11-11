import { SlidersHorizontal } from 'lucide-react';
import type { ComponentExtension } from '../../componentRegistry.types';
import AppSlider from '../AppSlider';

const entry: ComponentExtension = {
    Component: AppSlider,
    icon: SlidersHorizontal,
    sample: { props: { name: 'level', label: 'Level', min: 0, max: 100, step: 1 } },
};

export default entry;
