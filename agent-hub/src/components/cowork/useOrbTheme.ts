import { useLayoutEffect, useState } from 'react';
import { orbDefaults } from './coworkOrbAppearance';

function mix(a: string, b: string, weight: number) {
    const channel = (hex: string, pos: number) => parseInt(hex.slice(pos,pos+2),16);
    return '#' + [1,3,5].map(pos => Math.round(channel(a,pos)*(1-weight)+channel(b,pos)*weight).toString(16).padStart(2,'0')).join('');
}

function themeColor(css: CSSStyleDeclaration, name: string, fallback: string) {
    const raw = css.getPropertyValue(name).trim().toLowerCase();
    if (!raw.startsWith('#') || (raw.length !== 4 && raw.length !== 7)) return fallback;
    const digits = [...raw.slice(1)];
    if (!digits.every(c => '0123456789abcdef'.includes(c))) return fallback;
    return digits.length === 3 ? '#' + digits.map(c => c + c).join('') : raw;
}

function readOrbPalette() {
    const css = getComputedStyle(document.documentElement);
    const accent = themeColor(css, '--accent-primary',orbDefaults.rimColor);
    const ink = themeColor(css, '--text-primary',orbDefaults.coreColor);
    const ai = themeColor(css, '--type-ai',orbDefaults.mistColor);
    const hue = mix(accent, ai, .22);
    const preset = document.documentElement.dataset.theme || 'light';
    const lightSurface = ['light','glass','paper','sepia'].includes(preset);
    if (['light','paper','sepia','glass','glass-dark','high-contrast'].includes(preset)) {
        const warm = preset === 'paper' || preset === 'sepia';
        const pearl = warm ? '#ffe9c6' : '#e2edff';
        const mineral = mix(warm ? '#53414a' : '#415676', accent, .28);
        if (preset === 'high-contrast') return {
            lightSurface, coreColor:'#090b10',rimColor:'#4c5060',mistColor:'#b4bdcb',deepColor:'#8993a1',
            starColor:'#ffffff',nerveColor:mix(accent,'#ffffff',.3),pulseColor:'#ffffff',
        };
        return {
            lightSurface, coreColor:mix(mineral,'#101523',.76),rimColor:mix(mineral,pearl,.12),
            mistColor:mix(mineral,pearl,.55),deepColor:mix(mineral,pearl,.32),
            starColor:mix(pearl,'#ffffff',.48),nerveColor:mix(mineral,pearl,.72),
            pulseColor:mix(accent,'#ffffff',.89),
        };
    }
    return {
        lightSurface, coreColor: mix(hue,'#080a10',.82), rimColor: mix(hue,ink,.15),
        mistColor: mix(hue,'#ffffff',.36), deepColor: mix(hue,'#a3a4ac',.4),
        starColor: mix(hue,'#ffffff',.78), nerveColor: mix(hue,'#ffffff',.62),
        pulseColor: mix(accent,'#ffffff',.87),
    };
}

export function useOrbTheme() {
    const [palette,setPalette] = useState(() => readOrbPalette());
    useLayoutEffect(() => {
        const observer = new MutationObserver(() => setPalette(readOrbPalette()));
        observer.observe(document.documentElement,{attributes:true,attributeFilter:['data-theme','style','class']});
        return () => observer.disconnect();
    },[]);
    return palette;
}
