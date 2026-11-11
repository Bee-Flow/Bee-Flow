import { CircleDot } from 'lucide-react';
import type { ComponentExtension } from '../../componentRegistry.types';
import AppRadio from '../AppRadio';

const entry: ComponentExtension = {
    Component: AppRadio,
    icon: CircleDot,
    sample: { props: { name: 'choice', label: 'Choice', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] } },
};

export default entry;
