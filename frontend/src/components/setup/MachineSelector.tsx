import React from 'react';
import machines from '@/constants/machines';
import { useLang } from '@/i18n';

interface MachineSelectorProps {
  selectedMachine: number | null;
  onMachineChange: (machineId: number) => void;
  disabled?: boolean;
  className?: string;
  placeholder?: string;
}

export default function MachineSelector({
  selectedMachine,
  onMachineChange,
  disabled = false,
  className = 'w-full px-3 py-2 border border-gray-300 rounded-md',
  placeholder
}: MachineSelectorProps) {
  const { t } = useLang();

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const value = e.target.value;
    if (value) {
      onMachineChange(parseInt(value));
    }
  };

  return (
    <select
      value={selectedMachine?.toString() || ''}
      onChange={handleChange}
      disabled={disabled}
      className={className}
    >
      <option value="">
        {placeholder || t('ct_table.select_option')}
      </option>
      {machines
        .filter(m => m.id >= 1 && m.id <= 17)
        .sort((a, b) => a.id - b.id)
        .map(machine => (
          <option key={machine.id} value={machine.id.toString()}>
            {t('ct_table.machine_option', { id: machine.id, ton: machine.ton })}
          </option>
        ))}
    </select>
  );
}