export const extractInjectionMachineInfo = (name?: string | null) => {
    if (!name) return { machineNumber: undefined, tonLabel: undefined };
    const trimmed = name.trim();
    const hoMatch = trimmed.match(/(\d+)\s*호기/i);
    const hyphenMatch = trimmed.match(/-(\s*)(\d+)/);
    const tonMatch = trimmed.match(/(\d+)\s*T/i);

    const machineNumber = hoMatch
        ? parseInt(hoMatch[1], 10)
        : hyphenMatch
            ? parseInt(hyphenMatch[2], 10)
            : undefined;

    const tonLabel = tonMatch ? `${tonMatch[1].toUpperCase()}T` : undefined;

    return { machineNumber, tonLabel };
};

export const formatInjectionMachineLabel = (
    name: string | null | undefined,
    t: (key: string) => string
) => {
    if (!name) return '';
    const { machineNumber, tonLabel } = extractInjectionMachineInfo(name);
    const machine = machineNumber ? `${machineNumber}${t('호기')}` : name.trim();
    return tonLabel ? `${machine} - ${machineNumber ? tonLabel : ''}` : machine;
};

export const getInjectionMachineOrder = (name?: string | null) => {
    const { machineNumber } = extractInjectionMachineInfo(name);
    if (typeof machineNumber === 'number') return machineNumber;
    if (!name) return Number.MAX_SAFE_INTEGER;
    const fallbackMatch = name.match(/(\d+)/);
    return fallbackMatch ? parseInt(fallbackMatch[1], 10) : Number.MAX_SAFE_INTEGER;
};

export const getMachiningLineOrder = (name?: string | null) => {
    if (!name) return Number.MAX_SAFE_INTEGER;
    const match = name.match(/([A-D])/i);
    if (!match) return Number.MAX_SAFE_INTEGER;
    const orderMap: Record<string, number> = { A: 0, B: 1, C: 2, D: 3 };
    return orderMap[match[1].toUpperCase()] ?? Number.MAX_SAFE_INTEGER;
};

export const sortMachineSummary = <T extends { machine_name: string | null }>(
    rows: T[],
    planType: 'injection' | 'machining'
) => {
    const sorter = planType === 'injection' ? getInjectionMachineOrder : getMachiningLineOrder;
    return [...rows].sort((a, b) => sorter(a.machine_name) - sorter(b.machine_name));
};
