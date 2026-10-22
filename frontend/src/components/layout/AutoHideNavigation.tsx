import { useEffect, useRef, useState, type ReactNode } from 'react';

/** A fading cover keeps the native scrollbar draggable and the menu scrollable. */
export function AutoHideNavigation({ children, label }: { children: ReactNode; label: string }) {
  const [scrolling, setScrolling] = useState(false);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (idleTimer.current !== null) clearTimeout(idleTimer.current);
  }, []);

  const onScroll = () => {
    setScrolling(true);
    if (idleTimer.current !== null) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => {
      idleTimer.current = null;
      setScrolling(false);
    }, 700);
  };

  return <div className={`main-navigation-scroll${scrolling ? ' is-scrolling' : ''}`}>
    <nav aria-label={label} className="main-navigation" onScroll={onScroll}>{children}</nav>
  </div>;
}
