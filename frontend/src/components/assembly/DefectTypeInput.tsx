import { useMemo, useEffect } from 'react';
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
  onDeleteHistory?: (type: string) => void; // 히스토리 삭제 핸들러
  disabled?: boolean;
  className?: string;
}

export function DefectTypeInput({
  defectType,
  value,
  onChange,
  historyOptions = [],
  onSelect,
  onDeleteHistory,
  disabled = false,
  className = '',
}: DefectTypeInputProps) {
  const { t, lang } = useLang();

  const totalQuantity = useMemo(() => {
    return value.reduce((sum, entry) => sum + entry.quantity, 0);
  }, [value]);

  // 자동으로 빈 행 추가 (최소 1개 행 유지)
  useEffect(() => {
    if (value.length === 0) {
      onChange([{ id: `${Date.now()}`, type: '', quantity: 0 }]);
    }
  }, [value.length, onChange]);

  const handleAddRow = () => {
    const newEntry: DefectEntry = {
      id: `${Date.now()}`,
      type: '',
      quantity: 0,
    };
    onChange([...value, newEntry]);
  };

  const handleDeleteRow = (id: string) => {
    // 최소 1개 행 유지
    if (value.length <= 1) {
      onChange([{ id: `${Date.now()}`, type: '', quantity: 0 }]);
    } else {
      onChange(value.filter(entry => entry.id !== id));
    }
  };

  const handleTypeChange = (id: string, newType: string) => {
    const updated = value.map(entry =>
      entry.id === id ? { ...entry, type: newType } : entry
    );
    onChange(updated);

    // 히스토리에 추가
    if (newType.trim() && onSelect) {
      onSelect(newType.trim());
    }
  };

  const handleQuantityChange = (id: string, newQuantity: string) => {
    const quantity = newQuantity === '' ? 0 : Number(newQuantity);
    const updated = value.map(entry =>
      entry.id === id ? { ...entry, quantity: quantity } : entry
    );
    onChange(updated);
  };

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
        {/* 테이블 헤더 */}
        <div className="grid grid-cols-[1fr_100px_40px] gap-2 text-sm font-medium text-gray-600 pb-1 border-b">
          <div>{lang === 'zh' ? '不良类型' : '불량 유형'}</div>
          <div className="text-center">{lang === 'zh' ? '数量' : '수량'}</div>
          <div></div>
        </div>

        {/* 데이터 행들 */}
        <div className="max-h-64 overflow-y-auto space-y-3 -mx-2 px-2">
          {value.map((entry) => (
            <div key={entry.id} className="grid grid-cols-[1fr_100px_40px] gap-2 items-center py-1">
              <ComboBox
                options={historyOptions}
                value={entry.type}
                onChange={(newType) => handleTypeChange(entry.id, newType)}
                onSelect={(newType) => handleTypeChange(entry.id, newType)}
                onDelete={onDeleteHistory}
                placeholder={lang === 'zh' ? '选择或输入类型' : '유형 선택 또는 입력'}
                allowCustomInput={true}
                disabled={disabled}
                className="w-full"
              />
              <Input
                type="number"
                inputMode="numeric"
                min={0}
                className="text-center"
                placeholder="0"
                value={entry.quantity === 0 ? '' : entry.quantity}
                onChange={(e) => handleQuantityChange(entry.id, e.target.value)}
                disabled={disabled}
              />
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="h-8 w-8 text-gray-500 hover:text-red-500"
                onClick={() => handleDeleteRow(entry.id)}
                disabled={disabled}
                aria-label={lang === 'zh' ? '删除' : '삭제'}
              >
                <Trash className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>

        {/* 행 추가 버튼 */}
        <div className="pt-2 border-t">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={handleAddRow}
            disabled={disabled}
            className="w-full gap-2"
          >
            <Plus className="h-4 w-4" />
            {lang === 'zh' ? '添加행' : '행 추가'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
