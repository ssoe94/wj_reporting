import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const modelPath = new URL('../src/pages/quality/inspection-requests/roleShiftSettingsModel.ts', import.meta.url);
const shiftSource = fs.readFileSync(modelPath, 'utf8').replace(/import \{ createInspectionKey \} from '\.\/workflow';/, "const createInspectionKey = () => 'synthetic-key';");
const shiftUrl = 'data:text/javascript;base64,' + Buffer.from(shiftSource.replace(/import type[^;]+;/g, '')).toString('base64');
const teamSource = fs.readFileSync(new URL('../src/pages/quality/inspection-requests/roomTeamModel.ts', import.meta.url), 'utf8').replace(/import type[^;]+;/g, '').replace("'./roleShiftSettingsModel.ts'", JSON.stringify(shiftUrl));
const { stripTypeScriptTypes } = await import('node:module');
const shiftJsUrl = 'data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(shiftSource, {mode:'transform'})).toString('base64');
const teamJs = stripTypeScriptTypes(teamSource.replace(JSON.stringify(shiftUrl), JSON.stringify(shiftJsUrl)), {mode:'transform'});
const { currentInspectionShifts } = await import('data:text/javascript;base64,' + Buffer.from(teamJs).toString('base64'));
import type { InspectionRoleSetting } from '../src/pages/quality/inspection-requests/roleModel.ts';
const day: InspectionRoleSetting = { id: 1, version: 1, code: 'DAY', label: 'day', timezone: 'Asia/Shanghai', start_time: '08:00', end_time: '20:00', appearance_assignee: 1, dimension_assignee: 2, active: true, effective_from: '2026-10-06T00:00:00Z', effective_until: '2026-10-08T12:00:00Z' };
const night = { ...day, id: 2, code: 'NIGHT', start_time: '20:00', end_time: '08:00', effective_from: '2026-10-06T12:00:00Z', effective_until: '2026-10-09T00:00:00Z' };
test('team changes at Shanghai shift boundary and retains prior overnight shift', () => {
  const settings = [day, night];
  assert.deepEqual(currentInspectionShifts(settings, new Date('2026-10-07T00:00:00Z')).map(s => s.id), [1]);
  assert.deepEqual(currentInspectionShifts(settings, new Date('2026-10-07T11:59:59Z')).map(s => s.id), [1]);
  assert.deepEqual(currentInspectionShifts(settings, new Date('2026-10-07T12:00:00Z')).map(s => s.id), [2]);
  assert.deepEqual(currentInspectionShifts(settings, new Date('2026-10-07T23:59:59Z')).map(s => s.id), [2]);
});
test('inactive, expired, uncovered and invalid periods never show an assignment', () => {
  assert.deepEqual(currentInspectionShifts([{ ...day, active: false }, { ...day, effective_from: null }, { ...day, timezone: 'Asia/Seoul' }], new Date('2026-10-07T01:00:00Z')), []);
  assert.deepEqual(currentInspectionShifts([day, night], new Date('2026-10-09T01:00:00Z')), []);
  assert.deepEqual(currentInspectionShifts([day], new Date('invalid')), []);
});
