import { useEffect, useState } from "react";

/**
 * Reactive media-query hook — replaces scattered `window.innerWidth` reads so
 * layout responds correctly to resize and never goes stale.
 */
export function useMediaQuery(query) {
  const [matches, setMatches] = useState(
    () => typeof window !== "undefined" && window.matchMedia(query).matches
  );

  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = (e) => setMatches(e.matches);
    setMatches(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}

/** True on desktop (>= 1024px), matching the CSS breakpoint in design.css. */
export const useIsDesktop = () => useMediaQuery("(min-width: 1024px)");
