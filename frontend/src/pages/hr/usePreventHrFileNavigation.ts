import { useEffect } from 'react';
import { isHrFileDrag } from '../../domains/hr/file-drop';

/** An external file missed outside a drop target must not replace the upload page. */
export function usePreventHrFileNavigation(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const preventFileNavigation = (event: DragEvent) => {
      if (isHrFileDrag(event.dataTransfer)) event.preventDefault();
    };
    window.addEventListener('dragover', preventFileNavigation);
    window.addEventListener('drop', preventFileNavigation);
    return () => {
      window.removeEventListener('dragover', preventFileNavigation);
      window.removeEventListener('drop', preventFileNavigation);
    };
  }, [active]);
}
