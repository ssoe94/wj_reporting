import { extractInjectionMachineInfo } from './productionUtils';

export type FieldTerminalType = 'injection' | 'machining';

export type FieldTerminalUser = {
  type: FieldTerminalType;
  stationId: string;
  stationLabel: string;
  username: string;
};

export type FieldStation = {
  id: string;
  type: FieldTerminalType;
  label: string;
  shortLabel: string;
  machineFilterValue: string;
};

export const injectionStations: FieldStation[] = Array.from({ length: 17 }, (_, index) => {
  const no = index + 1;
  const padded = String(no).padStart(2, '0');
  return {
    id: `imm${padded}`,
    type: 'injection',
    label: `注塑${padded}`,
    shortLabel: `${no}号机`,
    machineFilterValue: String(no),
  };
});

export const machiningStations: FieldStation[] = [
  { id: 'assy01', type: 'machining', label: '加工A', shortLabel: 'A线', machineFilterValue: 'A' },
  { id: 'assy02', type: 'machining', label: '加工B', shortLabel: 'B线', machineFilterValue: 'B' },
  { id: 'assy03', type: 'machining', label: '加工C', shortLabel: 'C线', machineFilterValue: 'C' },
  { id: 'assy04', type: 'machining', label: '加工D', shortLabel: 'D线', machineFilterValue: 'D' },
];

export const allFieldStations: FieldStation[] = [...injectionStations, ...machiningStations];

export function getFieldStationById(stationId?: string | null): FieldStation | null {
  if (!stationId) return null;
  return allFieldStations.find((station) => station.id.toLowerCase() === stationId.toLowerCase()) ?? null;
}

export function parseFieldTerminalUser(username?: string | null): FieldTerminalUser | null {
  const value = (username || '').trim().toLowerCase();
  const immMatch = value.match(/^imm(\d{2})$/);
  if (immMatch) {
    const station = getFieldStationById(`imm${immMatch[1]}`);
    if (!station) return null;
    return {
      type: 'injection',
      stationId: station.id,
      stationLabel: station.label,
      username: value,
    };
  }

  const assyMatch = value.match(/^assy(\d{2})$/);
  if (assyMatch) {
    const station = getFieldStationById(`assy${assyMatch[1]}`);
    if (!station) return null;
    return {
      type: 'machining',
      stationId: station.id,
      stationLabel: station.label,
      username: value,
    };
  }

  return null;
}

export function matchesFieldStation(machineName: string | null | undefined, station: FieldStation): boolean {
  const value = (machineName || '').trim();
  if (!value) return false;

  if (station.type === 'injection') {
    const { machineNumber } = extractInjectionMachineInfo(value);
    return typeof machineNumber === 'number' && String(machineNumber) === station.machineFilterValue;
  }

  const upper = value.toUpperCase();
  return upper.includes(`${station.machineFilterValue}-`) || upper.includes(`${station.machineFilterValue}线`) || upper.includes(`${station.machineFilterValue}流水线`);
}
