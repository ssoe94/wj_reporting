import test from 'node:test';
import assert from 'node:assert/strict';
import { boardPartQueryKey, prefetchBoardParts } from '../src/domains/production/board-part-prefetch.ts';

test('prefetch deduplicates parts, runs sequentially and continues after a failed part', async () => {
  const loaded: string[] = [];
  let active = 0;
  await prefetchBoardParts([' part-a ', 'PART-A', 'PART-B', '', 'PART-C'], async part => {
    assert.equal(++active, 1);
    await Promise.resolve();
    loaded.push(part);
    active--;
    if (part === 'PART-B') throw new Error('offline');
  }, () => false);
  assert.deepEqual(loaded, ['PART-A', 'PART-B', 'PART-C']);
});

test('date changes use separate cache keys and cancellation stops queued parts', async () => {
  assert.deepEqual(boardPartQueryKey(' part-a ', '2026-09-16'), boardPartQueryKey('PART-A', '2026-09-16'));
  assert.notDeepEqual(boardPartQueryKey('PART-A', '2026-09-16'), boardPartQueryKey('PART-A', '2026-09-17'));
  let stopped = false;
  const loaded: string[] = [];
  await prefetchBoardParts(['A', 'B'], async part => { loaded.push(part); stopped = true; }, () => stopped);
  assert.deepEqual(loaded, ['A']);
});
