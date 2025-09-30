import { useState, useMemo } from 'react';
import { Plus, Trash } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ComboBox } from '@/components/ui/ComboBox';
import { useLang } from '@/i18n';
import { Card, CardHeader, CardContent } from '@/components/ui/card';

export interface DefectEntry {
  id: string;
  type: string;
  quantity: number;
}

interface DefectTypeInputProps {
  defectType: 'processing' | 'outsourcing';
  value: DefectEntry[];
  onChange: (entries: DefectEntry[]) => void;
  historyOptions?: string[];
  onSelect?: (type: string) => void;
  disabled?: boolean;
  className?: string;
}

export function DefectTypeInput({
  defectType,
  value,
  onChange,
  historyOptions = [],
  onSelect,
  disabled = false,
  className = '',
}: DefectTypeInputProps) {
  const { t } = useLang();
  const [currentType, setCurrentType] = useState('');
  const [currentQuantity, setCurrentQuantity] = useState<number | ''>('');

  const totalQuantity = useMemo(() => {
    return value.reduce((sum, entry) => sum + entry.quantity, 0);
  }, [value]);

  const handleAddEntry = () => {
    const trimmedType = currentType.trim();
    const quantity = Number(currentQuantity);

    if (trimmedType && quantity > 0) {
      // 중복 유형 방지
      if (value.some(entry => entry.type === trimmedType)) {
        // Optionally, show an error message to the user
        console.warn(`Defect type "${trimmedType}" already exists.`);
        return;
      }
      const newEntry: DefectEntry = {
        id: `${Date.now()}`,
        type: trimmedType,
        quantity: quantity,
      };
      onChange([...value, newEntry]);
      if (onSelect) {
        onSelect(trimmedType);
      }
      setCurrentType('');
      setCurrentQuantity('');
    }
  };

  const handleDeleteEntry = (id: string) => {
    onChange(value.filter(entry => entry.id !== id));
  };

  const handleSelectDefectType = (type: string) => {
    setCurrentType(type);
    if (onSelect) {
      onSelect(type);
    }
  }

  const title = defectType === 'processing' ? t('processing_defect') : t('assembly_outsourcing_defect');

  const badgeClassFor = (sum: number) => {
    if (sum === 0) return 'bg-gray-200 text-gray-800';
    if (sum > 0) return 'bg-red-200 text-red-800';
    return 'bg-blue-200 text-blue-800';
  };

  return (
    <Card className={className}>
      <CardHeader className="py-3">
        <div className="flex justify-between items-center">
          <div className="text-base font-semibold">{title}</div>
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-600">{t('sum')}:</span>
            <span className={`px-2 py-0.5 rounded-md font-semibold text-sm ${badgeClassFor(totalQuantity)}`}>
              {totalQuantity}
            </span>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-start gap-2">
          <ComboBox
            options={historyOptions}
            value={currentType}
            onChange={setCurrentType}
            onSelect={handleSelectDefectType}
            placeholder={t('defect_type_placeholder')}
            allowCustomInput={true}
            disabled={disabled}
            className="w-full"
          />
          <Input
            type="number"
            inputMode="numeric"
            min={1}
            className="w-24 text-center"
            placeholder={t('quantity')}
            value={currentQuantity}
            onChange={(e) => setCurrentQuantity(e.target.value === '' ? '' : Number(e.target.value))}
            onKeyDown={(e) => e.key === 'Enter' && handleAddEntry()}
            disabled={disabled}
          />
          <Button
            type="button"
            size="icon"
            onClick={handleAddEntry}
            disabled={disabled || !currentType.trim() || !(Number(currentQuantity) > 0)}
            aria-label={t('add')}
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>
        
        {value.length > 0 && (
          <div className="max-h-40 overflow-y-auto space-y-2 pr-2">
            {value.map((entry) => (
              <div key={entry.id} className="flex items-center justify-between bg-gray-50 p-2 rounded-md">
                <div className="flex-1 truncate">
                  <span className="font-medium text-sm">{entry.type}</span>
                </div>
                <div className="flex items-center gap-2 pl-2">
                  <span className="text-sm font-semibold">{entry.quantity}</span>
                  {!disabled && (
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6 text-gray-500 hover:text-red-500"
                      onClick={() => handleDeleteEntry(entry.id)}
                      aria-label={t('delete')}
                    >
                      <Trash className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
