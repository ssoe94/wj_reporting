import { useEffect, useRef } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

let bodyLockCount = 0;
let bodyOverflowBeforeLock = "";

function lockBodyScroll() {
  if (bodyLockCount === 0) {
    bodyOverflowBeforeLock = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  bodyLockCount += 1;
}

function unlockBodyScroll() {
  bodyLockCount = Math.max(0, bodyLockCount - 1);
  if (bodyLockCount === 0) {
    document.body.style.overflow = bodyOverflowBeforeLock;
  }
}

function getFocusableElements(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter((element) => element.tabIndex >= 0 && element.getAttribute("aria-hidden") !== "true");
}

function focusWithoutScroll(element: HTMLElement) {
  try {
    element.focus({ preventScroll: true });
  } catch {
    // Android WebView and older Firefox versions only support focus() without
    // an options object. A modal must remain operable when that overload is absent.
    element.focus();
  }
}

export function useModalFocusTrap<T extends HTMLElement>({
  enabled = true,
  initialFocusSelector = "[data-modal-initial-focus]",
  onEscape,
}: {
  enabled?: boolean;
  initialFocusSelector?: string;
  onEscape?: () => void;
} = {}) {
  const containerRef = useRef<T>(null);
  const onEscapeRef = useRef(onEscape);

  useEffect(() => {
    onEscapeRef.current = onEscape;
  }, [onEscape]);

  useEffect(() => {
    if (!enabled) return;
    const container = containerRef.current;
    if (!container) return;

    const previousActiveElement = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    container.dataset.modalFocusTrap = "true";
    lockBodyScroll();

    const isTopmostTrap = () => {
      const traps = document.querySelectorAll<HTMLElement>("[data-modal-focus-trap='true']");
      return traps[traps.length - 1] === container;
    };
    const focusFirst = () => {
      const preferred = container.querySelector<HTMLElement>(initialFocusSelector);
      const target = preferred && preferred.tabIndex >= 0
        ? preferred
        : getFocusableElements(container)[0] ?? container;
      focusWithoutScroll(target);
    };
    const animationFrame = window.requestAnimationFrame(focusFirst);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isTopmostTrap()) return;
      if (event.key === "Escape" && onEscapeRef.current) {
        event.preventDefault();
        onEscapeRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = getFocusableElements(container);
      if (focusable.length === 0) {
        event.preventDefault();
        focusWithoutScroll(container);
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !container.contains(document.activeElement))) {
        event.preventDefault();
        focusWithoutScroll(last);
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        focusWithoutScroll(first);
      }
    };
    const handleFocusIn = (event: FocusEvent) => {
      if (!isTopmostTrap() || container.contains(event.target as Node)) return;
      focusFirst();
    };

    document.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("focusin", handleFocusIn, true);
    return () => {
      window.cancelAnimationFrame(animationFrame);
      document.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("focusin", handleFocusIn, true);
      delete container.dataset.modalFocusTrap;
      unlockBodyScroll();
      if (previousActiveElement?.isConnected) {
        focusWithoutScroll(previousActiveElement);
      }
    };
  }, [enabled, initialFocusSelector]);

  return containerRef;
}
