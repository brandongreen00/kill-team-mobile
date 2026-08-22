import { useEffect, useState } from 'preact/hooks';

/**
 * The three-column layout breakpoint, kept in sync with the media query in styles.css.
 *
 * 1200px, not 900px. At 900px a 360px rail and a 320px log leave the board **220px** — worse
 * than the phone layout it was supposed to improve on. Between a phone and 1200px the stage +
 * command sheet IS the right layout: a tablet gets a big board and a sheet, not three
 * columns squeezed together.
 */
export const DESKTOP_QUERY = '(min-width: 1200px)';

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
