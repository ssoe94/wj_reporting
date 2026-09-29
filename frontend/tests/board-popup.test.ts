import assert from "node:assert/strict";
import test from "node:test";

import { openBoardPopup } from "../src/domains/boards/board-popup.ts";

function click(overrides: Record<string, boolean | number> = {}) {
  let prevented = false;
  const event = {
    button: 0,
    defaultPrevented: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    preventDefault: () => { prevented = true; },
    ...overrides,
  };
  return { event, wasPrevented: () => prevented };
}

test("board card opens a separate popup and keeps the hub page in place", () => {
  const { event, wasPrevented } = click();
  const popup = { opener: {} } as Window;
  const calls: string[][] = [];
  const opened = openBoardPopup(event, "/boards/injection", (url, target, features) => {
    calls.push([url, target, features]);
    return popup;
  });

  assert.equal(opened, true);
  assert.equal(wasPrevented(), true);
  assert.deepEqual(calls, [["/boards/injection", "_blank", "popup=yes,width=1920,height=1080"]]);
  assert.equal(popup.opener, null);
});

test("blocked popup leaves the anchor's native new-window navigation available", () => {
  const { event, wasPrevented } = click();
  assert.equal(openBoardPopup(event, "/boards/moulds", () => null), false);
  assert.equal(wasPrevented(), false);

  const failed = click();
  assert.equal(openBoardPopup(failed.event, "/boards/moulds", () => {
    throw new Error("popup denied");
  }), false);
  assert.equal(failed.wasPrevented(), false);
});

test("modified, non-primary, and already handled clicks retain normal link behavior", () => {
  for (const overrides of [
    { ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true },
    { button: 1 }, { defaultPrevented: true },
  ]) {
    const { event, wasPrevented } = click(overrides);
    let called = false;
    assert.equal(openBoardPopup(event, "/boards/overview", () => {
      called = true;
      return null;
    }), false);
    assert.equal(called, false);
    assert.equal(wasPrevented(), false);
  }
});
