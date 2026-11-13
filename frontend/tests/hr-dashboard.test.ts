import assert from 'node:assert/strict';
import test from 'node:test';
import { dashboardAncestorIds, dashboardSearch } from '../src/domains/hr/dashboard.ts';
import type { DashboardNode, DashboardPerson } from '../src/domains/hr/dashboard.ts';

test('dashboard search finds a code or a normalized name without matching all staff on a blank query', () => {
  const people = [
    { key: 'first', code: 'SYN-001', name: '가상 직원' },
    { key: 'second', code: 'SYN-002', name: '测试乙' },
  ] as DashboardPerson[];
  assert.deepEqual(dashboardSearch(people, '가상\t직원'.normalize('NFD')).map(person => person.key), ['first']);
  assert.deepEqual(dashboardSearch(people, 'syn-002').map(person => person.key), ['second']);
  assert.deepEqual(dashboardSearch(people, '   '), []);
});

test('search expands the person’s exact organization path even when parts have the same label', () => {
  const nodes = [
    { id: 'root', parent_id: null, name: '测试公司' },
    { id: 'a', parent_id: 'root', name: '测试甲组' },
    { id: 'b', parent_id: 'root', name: '测试乙组' },
    { id: 'a1', parent_id: 'a', name: '测试小组' },
    { id: 'b1', parent_id: 'b', name: '测试小组' },
  ] as DashboardNode[];
  const index = new Map(nodes.map(node => [node.id, node]));
  assert.deepEqual([...dashboardAncestorIds('a1', index)], ['a1', 'a', 'root']);
  assert.deepEqual([...dashboardAncestorIds('b1', index)], ['b1', 'b', 'root']);
});
