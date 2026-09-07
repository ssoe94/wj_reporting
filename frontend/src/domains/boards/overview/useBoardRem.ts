import { useEffect, useState } from "react";

/** Recharts takes pixel dimensions; match them to the board's responsive rem canvas. */
export function useBoardRem() {
  const [rem, setRem] = useState(16);
  useEffect(() => {
    const update = () => setRem(parseFloat(getComputedStyle(document.documentElement).fontSize) || 16);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return rem;
}
