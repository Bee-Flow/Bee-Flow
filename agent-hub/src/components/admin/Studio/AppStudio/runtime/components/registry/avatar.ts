import { CircleUserRound } from 'lucide-react';
import type { ComponentExtension } from '../../componentRegistry.types';
import AppAvatar from '../AppAvatar';

const entry: ComponentExtension = {
    Component: AppAvatar,
    icon: CircleUserRound,
    sample: { props: { name: 'Ada Lovelace', size: 'md' } },
};

export default entry;
