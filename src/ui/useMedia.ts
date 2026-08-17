import { useEffect, useState } from 'preact/hooks';

/** Desktop layout breakpoint, kept in sync with the media query in styles.css. */
export const DESKTOP_QUERY = '(min-width: 900px)';

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' && 'matchMedia' in window ? window.matchMedia(query).matches : false,
  );
  useEffect(() => {
    if (typeof window === 'undefined' || !('matchMedia' in window)) return;
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

export const useIsDesktop = (): boolean => useMediaQuery(DESKTOP_QUERY);
