type BoardPopupClick = {
  button: number;
  defaultPrevented: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  preventDefault: () => void;
};

type OpenPopup = (url: string, target: string, features: string) => Window | null;

export function openBoardPopup(
  event: BoardPopupClick,
  href: string,
  openPopup: OpenPopup = (url, target, features) => window.open(url, target, features),
) {
  if (event.defaultPrevented || event.button !== 0
    || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;

  try {
    const popup = openPopup(href, "_blank", "popup=yes,width=1920,height=1080");
    if (!popup) return false;
    try {
      popup.opener = null;
    } catch {
      // Browser controls may restrict access to the newly opened window.
    }
    event.preventDefault();
    return true;
  } catch {
    // Keep the anchor's native new-window action available when JS opening fails.
    return false;
  }
}
