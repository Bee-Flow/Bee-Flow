import { useId } from 'react';
import type { LogoProps } from './integrationLogos.types';

export default function FirefliesLogo({ size = 18, className }: LogoProps) {
    const gradient = useId();
    return (
        <svg width={size} height={size} className={className} style={{ display: 'block' }} xmlns="http://www.w3.org/2000/svg" viewBox="22 20 24 24">
            <defs>
                <linearGradient id={gradient} x1="40" y1="40" x2="14" y2="14" gradientUnits="userSpaceOnUse">
                    <stop stopColor="#FF3C82" />
                    <stop offset="0.5" stopColor="#9B4AB0" />
                    <stop offset="1" stopColor="#3B73FF" />
                </linearGradient>
            </defs>
            <path d="M30.5749 22H24V28.5267H30.5749V22Z" fill={`url(#${gradient})`} />
            <path d="M38.3633 29.8789H31.7883V36.4056H38.3633V29.8789Z" fill={`url(#${gradient})`} />
            <path d="M38.3633 22H31.7883V28.5267H43.9998V27.594C43.9997 26.1104 43.4058 24.6875 42.3489 23.6384C41.2919 22.5894 39.8585 22 38.3638 22H38.3633Z" fill={`url(#${gradient})`} />
            <path d="M24 29.8789V36.4056C24.0002 37.8892 24.594 39.3121 25.6509 40.3612C26.7079 41.4103 28.1413 41.9996 29.636 41.9996H30.5749V29.8789H24Z" fill={`url(#${gradient})`} />
        </svg>
    );
}
