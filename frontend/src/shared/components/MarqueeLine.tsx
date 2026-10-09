import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import "./MarqueeLine.css";

const MARQUEE_GAP_PX = 40;
const MARQUEE_SPEED_PX_PER_SEC = 32;

/**
 * Keeps the line's frame fixed. When the content is wider than its line, it flows
 * right-to-left as a seamless loop instead of being cut off; the copy used for
 * the loop is inert so buttons are not duplicated for keyboard or screen readers.
 * With reduced motion the line stays still and the caller's ellipsis applies.
 */
export function MarqueeLine({ className, title, watch, children }: {
  className: string;
  title?: string;
  watch: string;
  children: ReactNode;
}) {
  const frameRef = useRef<HTMLSpanElement>(null);
  const contentRef = useRef<HTMLSpanElement>(null);
  const [shift, setShift] = useState(0);

  useLayoutEffect(() => {
    const frame = frameRef.current;
    const content = contentRef.current;
    if (!frame || !content) return undefined;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const measure = () => {
      const overflow = content.scrollWidth - frame.clientWidth;
      setShift(!reduced?.matches && overflow > 1 ? content.scrollWidth + MARQUEE_GAP_PX : 0);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(frame);
    observer?.observe(content);
    reduced?.addEventListener?.("change", measure);
    return () => {
      observer?.disconnect();
      reduced?.removeEventListener?.("change", measure);
    };
  }, [watch]);

  const style = shift
    ? { "--marquee-shift": `${shift}px`, "--marquee-duration": `${Math.max(6, shift / MARQUEE_SPEED_PX_PER_SEC).toFixed(1)}s` } as CSSProperties
    : undefined;
  return (
    <span className={`${className} marquee-line${shift ? " is-flowing" : ""}`} ref={frameRef} title={title}>
      <span className="marquee-line__track" style={style}>
        <span className="marquee-line__content" ref={contentRef}>{children}</span>
        {shift ? <span aria-hidden="true" className="marquee-line__content" inert>{children}</span> : null}
      </span>
    </span>
  );
}
