import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

/** Keep native scrolling, with a fading thumb that never reserves menu width. */
export function AutoHideNavigation({ children, label }: { children: ReactNode; label: string }) {
  const navigation = useRef<HTMLElement>(null);
  const [scrolling, setScrolling] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [thumb, setThumb] = useState({ top: 0, height: 0 });
  const drag = useRef<{ y: number; scrollTop: number } | null>(null);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (idleTimer.current !== null) clearTimeout(idleTimer.current);
  }, []);

  const syncThumb = useCallback(() => {
    const nav = navigation.current;
    if (!nav) return;
    const height = nav.scrollHeight > nav.clientHeight
      ? Math.min(nav.clientHeight, Math.max(32, nav.clientHeight ** 2 / nav.scrollHeight)) : 0;
    const top = height ? nav.scrollTop / (nav.scrollHeight - nav.clientHeight) * (nav.clientHeight - height) : 0;
    setThumb(previous => previous.top === top && previous.height === height ? previous : { top, height });
  }, []);

  useEffect(() => {
    syncThumb();
    const nav = navigation.current;
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(syncThumb);
    if (nav) {
      observer?.observe(nav);
      if (nav.firstElementChild) observer?.observe(nav.firstElementChild);
    }
    window.addEventListener('resize', syncThumb);
    return () => { observer?.disconnect(); window.removeEventListener('resize', syncThumb); };
  }, [children, syncThumb]);

  const onScroll = () => {
    syncThumb();
    setScrolling(true);
    if (idleTimer.current !== null) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => {
      idleTimer.current = null;
      setScrolling(false);
    }, 700);
  };

  const endDrag = () => { drag.current = null; setDragging(false); };

  return <div className={`main-navigation-scroll${scrolling || dragging ? ' is-scrolling' : ''}`}>
    <nav ref={navigation} tabIndex={0} aria-label={label} className="main-navigation" onScroll={onScroll}>{children}</nav>
    {thumb.height > 0 && <div aria-hidden="true" className="main-navigation-scroll__thumb"
      style={{ height: thumb.height, transform: `translateY(${thumb.top}px)` }}
      onPointerDown={event => {
        if (event.button !== 0 || !navigation.current) return;
        event.preventDefault();
        drag.current = { y: event.clientY, scrollTop: navigation.current.scrollTop };
        setDragging(true);
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={event => {
        const nav = navigation.current;
        if (!drag.current || !nav) return;
        nav.scrollTop = drag.current.scrollTop + (event.clientY - drag.current.y)
          * (nav.scrollHeight - nav.clientHeight) / Math.max(1, nav.clientHeight - thumb.height);
      }}
      onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag}
    />}
  </div>;
}
