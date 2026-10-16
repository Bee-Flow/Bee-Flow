import { useEffect, useRef, useState, type RefObject } from 'react';

/** True once the element has scrolled into view (or at once without IntersectionObserver). */
export default function useInViewOnce<T extends Element>(): [RefObject<T | null>, boolean] {
    const ref = useRef<T>(null);
    const [seen, setSeen] = useState(false);
    useEffect(() => {
        const el = ref.current;
        if (!el || seen) return undefined;
        if (typeof IntersectionObserver !== 'function') {
            setSeen(true);
            return undefined;
        }
        const observer = new IntersectionObserver((entries) => {
            if (entries.some((e) => e.isIntersecting)) {
                setSeen(true);
                observer.disconnect();
            }
        }, { threshold: 0.25 });
        observer.observe(el);
        return () => observer.disconnect();
    }, [seen]);
    return [ref, seen];
}
