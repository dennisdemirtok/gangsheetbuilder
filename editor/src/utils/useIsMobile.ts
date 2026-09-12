import { useEffect, useState } from "react";

/**
 * The editor swaps between a three-column desktop shell and a single-column
 * phone shell at this width. Kept here so the canvas and the app shell can
 * never disagree about which one is showing.
 */
export const MOBILE_QUERY = "(max-width: 900px)";

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== "undefined" && window.matchMedia(MOBILE_QUERY).matches,
  );

  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY);
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener("change", onChange);
    setIsMobile(mq.matches);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return isMobile;
}
