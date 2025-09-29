# Assembly 불량 기록 시스템 구현 가이드라인

## 구현 개요

Assembly 가공 생산 기록의 불량 기록 UI를 기존 시스템에서 요구사항에 맞게 개선하는 단계별 구현 가이드입니다.

## 구현 순서

### Phase 1: 기본 구조 변경 (Priority: High)

#### 1.1 명칭 및 레이아웃 변경
```typescript
// AssemblyReportForm.tsx 수정
// 1. 입고불량 → 사출불량 명칭 변경
// 2. 가공불량과 외주불량을 2열 그리드로 재배치
```

**변경 대상 파일:**
- `src/components/AssemblyReportForm.tsx`
- `src/i18n.tsx`

**구체적 변경사항:**
```tsx
// 기존 구조
<div className="space-y-4">
  <Card>사출불량 (구 입고불량)</Card>
  <Card>가공불량</Card>
  <Card>외주불량 (단순 숫자)</Card>
</div>

// 신규 구조
<div className="space-y-4">
  <Card>사출불량</Card>
  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
    <Card>가공불량 (동적 관리)</Card>
    <Card>외주불량 (동적 관리)</Card>
  </div>
</div>
```

#### 1.2 i18n 키 업데이트
```typescript
// i18n.tsx에 추가
ko: {
  // 명칭 변경
  'injection_defect': '사출불량',
  'processing_defects_title': '가공불량',
  'outsourcing_defects_title': '외주불량',

  // 새로운 기능 키
  'defect_type_placeholder': '불량 유형',
  'defect_quantity_placeholder': '수량',
  'add_defect_entry': '추가',
  'defect_total': '총 불량수',
},
zh: {
  'injection_defect': '注塑不良',
  'processing_defects_title': '加工不良',
  'outsourcing_defects_title': '外包不良',
  'defect_type_placeholder': '不良类型',
  'defect_quantity_placeholder': '数量',
  'add_defect_entry': '添加',
  'defect_total': '总不良数',
}
```

### Phase 2: ComboBox 컴포넌트 구현 (Priority: High)

#### 2.1 기본 ComboBox 컴포넌트
**파일**: `src/components/ui/ComboBox.tsx`

```typescript
import { useState, useRef, useEffect } from 'react';
import { ChevronDown } from 'lucide-react';

interface ComboBoxProps {
  options: string[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  allowCustomInput?: boolean;
  className?: string;
}

export function ComboBox({
  options,
  value,
  onChange,
  placeholder = '',
  disabled = false,
  allowCustomInput = false,
  className = ''
}: ComboBoxProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [inputValue, setInputValue] = useState(value);
  const [activeIndex, setActiveIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // 필터링된 옵션
  const filteredOptions = options.filter(option =>
    option.toLowerCase().includes(inputValue.toLowerCase())
  );

  // 키보드 네비게이션
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (!isOpen) setIsOpen(true);
        else setActiveIndex(prev =>
          prev < filteredOptions.length - 1 ? prev + 1 : 0
        );
        break;

      case 'ArrowUp':
        e.preventDefault();
        if (isOpen) {
          setActiveIndex(prev => prev > 0 ? prev - 1 : filteredOptions.length - 1);
        }
        break;

      case 'Enter':
        e.preventDefault();
        if (isOpen && activeIndex >= 0) {
          handleSelectOption(filteredOptions[activeIndex]);
        } else if (allowCustomInput && inputValue.trim()) {
          handleSelectOption(inputValue.trim());
        }
        break;

      case 'Escape':
        setIsOpen(false);
        setActiveIndex(-1);
        break;
    }
  };

  // 옵션 선택 처리
  const handleSelectOption = (option: string) => {
    setInputValue(option);
    onChange(option);
    setIsOpen(false);
    setActiveIndex(-1);
  };

  // 입력값 변경 처리
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value;
    setInputValue(newValue);
    setIsOpen(true);
    setActiveIndex(-1);

    if (allowCustomInput) {
      onChange(newValue);
    }
  };

  return (
    <div className={`relative ${className}`}>
      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          value={inputValue}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          onFocus={() => setIsOpen(true)}
          onBlur={() => setTimeout(() => setIsOpen(false), 200)}
          placeholder={placeholder}
          disabled={disabled}
          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent pr-8"
        />
        <ChevronDown
          className="absolute right-2 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none"
        />
      </div>

      {isOpen && filteredOptions.length > 0 && (
        <ul
          ref={listRef}
          className="absolute z-10 w-full mt-1 bg-white border border-gray-300 rounded-md shadow-lg max-h-60 overflow-auto"
        >
          {filteredOptions.map((option, index) => (
            <li
              key={option}
              className={`px-3 py-2 cursor-pointer hover:bg-blue-50 ${
                index === activeIndex ? 'bg-blue-100' : ''
              }`}
              onClick={() => handleSelectOption(option)}
            >
              {option}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

#### 2.2 ComboBox 사용 예시
```typescript
// DefectTypeInput.tsx에서 사용
<ComboBox
  options={historyOptions}
  value={currentType}
  onChange={setCurrentType}
  placeholder="불량 유형을 선택하거나 입력하세요"
  allowCustomInput={true}
  className="flex-1 min-w-[200px]"
/>
```

### Phase 3: DefectTypeInput 컴포넌트 구현 (Priority: High)

#### 3.1 DefectTypeInput 컴포넌트
**파일**: `src/components/assembly/DefectTypeInput.tsx`

```typescript
import { useState, useMemo } from 'react';
import { Plus, Edit, Trash, Check, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ComboBox } from '@/components/ui/ComboBox';
import { useLang } from '@/i18n';

interface DefectEntry {
  id: string;
  type: string;
  quantity: number;
}

interface DefectTypeInputProps {
  defectType: 'processing' | 'outsourcing';
  value: DefectEntry[];
  onChange: (entries: DefectEntry[]) => void;
  historyOptions?: string[];
  disabled?: boolean;
  className?: string;
}

export function DefectTypeInput({
  defectType,
  value,
  onChange,
  historyOptions = [],
  disabled = false,
  className = ''
}: DefectTypeInputProps) {
  const { t } = useLang();
  const [currentType, setCurrentType] = useState('');
  const [currentQuantity, setCurrentQuantity] = useState<number | ''>('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editType, setEditType] = useState('');
  const [editQuantity, setEditQuantity] = useState<number | ''>('');

  // 추가 버튼 활성화 조건
  const canAdd = useMemo(() => {
    return (
      currentType.trim().length >= 2 &&
      currentQuantity !== '' &&
      Number(currentQuantity) > 0 &&
      !value.some(entry => entry.type === currentType.trim())
    );
  }, [currentType, currentQuantity, value]);

  // 총 불량수 계산
  const totalQuantity = useMemo(() => {
    return value.reduce((sum, entry) => sum + entry.quantity, 0);
  }, [value]);

  // 불량 항목 추가
  const handleAddEntry = () => {
    if (!canAdd) return;

    const newEntry: DefectEntry = {
      id: `${Date.now()}-${Math.random()}`,
      type: currentType.trim(),
      quantity: Number(currentQuantity)
    };

    onChange([...value, newEntry]);
    setCurrentType('');
    setCurrentQuantity('');
  };

  // 불량 항목 삭제
  const handleDeleteEntry = (id: string) => {
    onChange(value.filter(entry => entry.id !== id));
  };

  // 편집 시작
  const handleStartEdit = (entry: DefectEntry) => {
    setEditingId(entry.id);
    setEditType(entry.type);
    setEditQuantity(entry.quantity);
  };

  // 편집 저장
  const handleSaveEdit = () => {
    if (!editingId || !editType.trim() || !editQuantity || Number(editQuantity) <= 0) {
      return;
    }

    const updatedEntries = value.map(entry =>
      entry.id === editingId
        ? { ...entry, type: editType.trim(), quantity: Number(editQuantity) }
        : entry
    );

    onChange(updatedEntries);
    setEditingId(null);
    setEditType('');
    setEditQuantity('');
  };

  // 편집 취소
  const handleCancelEdit = () => {
    setEditingId(null);
    setEditType('');
    setEditQuantity('');
  };

  const title = defectType === 'processing'
    ? t('processing_defects_title')
    : t('outsourcing_defects_title');

  return (
    <div className={`space-y-4 p-4 border border-gray-200 rounded-lg ${className}`}>
      {/* 제목 및 총합 */}
      <div className="flex justify-between items-center">
        <h4 className="font-semibold text-gray-800">{title}</h4>
        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-600">{t('defect_total')}:</span>
          <span className="px-2 py-1 bg-gray-100 rounded font-semibold">
            {totalQuantity}
          </span>
        </div>
      </div>

      {/* 입력 섹션 */}
      <div className="flex gap-2 items-end">
        <div className="flex-1 min-w-[200px]">
          <ComboBox
            options={historyOptions}
            value={currentType}
            onChange={setCurrentType}
            placeholder={t('defect_type_placeholder')}
            allowCustomInput={true}
            disabled={disabled}
          />
        </div>

        <div className="w-24">
          <Input
            type="number"
            min="1"
            value={currentQuantity}
            onChange={(e) => setCurrentQuantity(e.target.value === '' ? '' : Number(e.target.value))}
            placeholder={t('defect_quantity_placeholder')}
            disabled={disabled}
          />
        </div>

        <Button
          type="button"
          onClick={handleAddEntry}
          disabled={!canAdd || disabled}
          className="px-3 py-2"
        >
          <Plus className="w-4 h-4 mr-1" />
          {t('add_defect_entry')}
        </Button>
      </div>

      {/* 불량 목록 */}
      {value.length > 0 && (
        <div className="space-y-2">
          {value.map((entry) => (
            <div
              key={entry.id}
              className={`flex items-center justify-between p-3 border rounded ${
                editingId === entry.id ? 'bg-blue-50 border-blue-200' : 'bg-gray-50 border-gray-200'
              }`}
            >
              {editingId === entry.id ? (
                // 편집 모드
                <>
                  <div className="flex gap-2 flex-1">
                    <Input
                      value={editType}
                      onChange={(e) => setEditType(e.target.value)}
                      className="flex-1"
                    />
                    <Input
                      type="number"
                      min="1"
                      value={editQuantity}
                      onChange={(e) => setEditQuantity(e.target.value === '' ? '' : Number(e.target.value))}
                      className="w-20"
                    />
                  </div>
                  <div className="flex gap-1 ml-2">
                    <Button size="sm" onClick={handleSaveEdit}>
                      <Check className="w-3 h-3" />
                    </Button>
                    <Button size="sm" variant="ghost" onClick={handleCancelEdit}>
                      <X className="w-3 h-3" />
                    </Button>
                  </div>
                </>
              ) : (
                // 표시 모드
                <>
                  <div className="flex-1">
                    <span className="font-medium">{entry.type}</span>
                    <span className="ml-2 text-gray-600">: {entry.quantity}개</span>
                  </div>
                  <div className="flex gap-1 ml-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => handleStartEdit(entry)}
                      disabled={disabled}
                    >
                      <Edit className="w-3 h-3" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => handleDeleteEntry(entry.id)}
                      disabled={disabled}
                    >
                      <Trash className="w-3 h-3" />
                    </Button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

### Phase 4: AssemblyReportForm 통합 (Priority: High)

#### 4.1 기존 FormData 상태 확장
```typescript
// AssemblyReportForm.tsx 수정
interface DefectEntry {
  id: string;
  type: string;
  quantity: number;
}

// formData에 새 필드 추가
const [formData, setFormData] = useState({
  // 기존 필드들...
  injection_defect: initialData?.injection_defect || 0,  // 명칭 변경됨
  processing_defect: 0,  // 자동 계산
  outsourcing_defect: 0, // 자동 계산
});

// 새로운 동적 불량 상태
const [processingDefectsEntries, setProcessingDefectsEntries] = useState<DefectEntry[]>([]);
const [outsourcingDefectsEntries, setOutsourcingDefectsEntries] = useState<DefectEntry[]>([]);
```

#### 4.2 불량 카드 JSX 수정
```tsx
{/* 불량기록 카드 */}
<Card className="h-full flex flex-col">
  <CardHeader className="font-semibold text-blue-700">
    {t('defect_record')}
  </CardHeader>
  <CardContent className="flex-1 space-y-4">

    {/* 사출불량 (기존 구조 유지) */}
    <Card className="border-green-200">
      <CardHeader className="py-2 font-medium text-green-700">
        <button
          type="button"
          className="w-full flex flex-row items-center justify-between cursor-pointer"
          onClick={() => setIncomingOpen(o => !o)}
        >
          <span>{t('injection_defect')}</span>
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-600">{t('sum')}:</span>
            <span className="px-2 py-0.5 rounded-md font-semibold bg-green-50 text-green-700">
              {totalInjection}
            </span>
          </div>
        </button>
      </CardHeader>
      {incomingOpen && (
        <CardContent>
          {/* 기존 사출불량 상세 항목들 */}
        </CardContent>
      )}
    </Card>

    {/* 가공 & 외주불량 (2열 그리드) */}
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <DefectTypeInput
        defectType="processing"
        value={processingDefectsEntries}
        onChange={setProcessingDefectsEntries}
        historyOptions={processingHistory}
        disabled={isLoading}
      />

      <DefectTypeInput
        defectType="outsourcing"
        value={outsourcingDefectsEntries}
        onChange={setOutsourcingDefectsEntries}
        historyOptions={outsourcingHistory}
        disabled={isLoading}
      />
    </div>

  </CardContent>
</Card>
```

#### 4.3 집계값 자동 계산
```typescript
// 불량 항목 변경 시 집계값 자동 계산
useEffect(() => {
  const processingTotal = processingDefectsEntries.reduce((sum, entry) => sum + entry.quantity, 0);
  const outsourcingTotal = outsourcingDefectsEntries.reduce((sum, entry) => sum + entry.quantity, 0);

  setFormData(prev => ({
    ...prev,
    processing_defect: processingTotal,
    outsourcing_defect: outsourcingTotal
  }));
}, [processingDefectsEntries, outsourcingDefectsEntries]);
```

### Phase 5: API 통합 (Priority: Medium)

#### 5.1 불량 히스토리 Hook
**파일**: `src/hooks/useDefectHistory.ts`

```typescript
import { useQuery } from '@tanstack/react-query';
import api from '@/lib/api';

interface UseDefectHistoryOptions {
  defectType: 'processing' | 'outsourcing';
  enabled?: boolean;
}

export function useDefectHistory({ defectType, enabled = true }: UseDefectHistoryOptions) {
  return useQuery({
    queryKey: ['defect-history', defectType],
    queryFn: async () => {
      const response = await api.get('/assembly/defect-types/history/', {
        params: { type: defectType, limit: 50 }
      });
      return response.data[`${defectType}_types`] || [];
    },
    enabled,
    staleTime: 5 * 60 * 1000, // 5분간 캐시
    cacheTime: 10 * 60 * 1000, // 10분간 보존
  });
}

// AssemblyReportForm.tsx에서 사용
const { data: processingHistory = [] } = useDefectHistory({
  defectType: 'processing'
});
const { data: outsourcingHistory = [] } = useDefectHistory({
  defectType: 'outsourcing'
});
```

#### 5.2 저장 페이로드 수정
```typescript
// handleSubmit 함수 수정
const handleSubmit = async (e: React.FormEvent) => {
  e.preventDefault();

  try {
    const payload = {
      ...formData,
      // 동적 불량 항목 추가
      processing_defects_entries: processingDefectsEntries,
      outsourcing_defects_entries: outsourcingDefectsEntries,
      // 기존 집계값도 함께 전송 (호환성)
      processing_defect: processingDefectsEntries.reduce((sum, e) => sum + e.quantity, 0),
      outsourcing_defect: outsourcingDefectsEntries.reduce((sum, e) => sum + e.quantity, 0),
    };

    await onSubmit(payload);

    // 성공 시 동적 불량 목록 초기화
    setProcessingDefectsEntries([]);
    setOutsourcingDefectsEntries([]);

  } catch (error) {
    // 에러 처리
  }
};
```

### Phase 6: 백엔드 API 구현 (Priority: Medium)

#### 6.1 Django 모델 확장
**파일**: `backend/assembly/models.py`

```python
class AssemblyDefectEntry(models.Model):
    """동적 불량 항목 모델"""

    DEFECT_CATEGORIES = [
        ('processing', '가공불량'),
        ('outsourcing', '외주불량'),
    ]

    report = models.ForeignKey(
        'AssemblyReport',
        on_delete=models.CASCADE,
        related_name='defect_entries'
    )
    defect_category = models.CharField(max_length=20, choices=DEFECT_CATEGORIES)
    defect_type = models.CharField(max_length=100)  # 불량 유형명
    quantity = models.PositiveIntegerField()        # 불량 수량
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = 'assembly_defect_entries'
        indexes = [
            models.Index(fields=['report', 'defect_category']),
            models.Index(fields=['defect_type']),
        ]
```

#### 6.2 시리얼라이저 수정
**파일**: `backend/assembly/serializers.py`

```python
class DefectEntrySerializer(serializers.ModelSerializer):
    class Meta:
        model = AssemblyDefectEntry
        fields = ['id', 'defect_category', 'defect_type', 'quantity']

class AssemblyReportSerializer(serializers.ModelSerializer):
    processing_defects_entries = DefectEntrySerializer(
        many=True, read_only=True, source='defect_entries.processing'
    )
    outsourcing_defects_entries = DefectEntrySerializer(
        many=True, read_only=True, source='defect_entries.outsourcing'
    )

    class Meta:
        model = AssemblyReport
        fields = [
            # 기존 필드들...
            'processing_defects_entries',
            'outsourcing_defects_entries',
        ]

    def create(self, validated_data):
        # 동적 불량 항목 처리
        processing_entries = self.context['request'].data.get('processing_defects_entries', [])
        outsourcing_entries = self.context['request'].data.get('outsourcing_defects_entries', [])

        report = super().create(validated_data)

        # 불량 항목 생성
        for entry in processing_entries:
            AssemblyDefectEntry.objects.create(
                report=report,
                defect_category='processing',
                defect_type=entry['type'],
                quantity=entry['quantity']
            )

        for entry in outsourcing_entries:
            AssemblyDefectEntry.objects.create(
                report=report,
                defect_category='outsourcing',
                defect_type=entry['type'],
                quantity=entry['quantity']
            )

        return report
```

#### 6.3 히스토리 API 뷰
**파일**: `backend/assembly/views.py`

```python
@action(detail=False, methods=['get'])
def defect_history(self, request):
    """불량 유형 히스토리 조회"""
    defect_type = request.query_params.get('type')  # 'processing' or 'outsourcing'
    limit = int(request.query_params.get('limit', 50))

    if defect_type not in ['processing', 'outsourcing']:
        return Response({'error': 'Invalid defect type'}, status=400)

    # 최근 1년간 사용된 불량 유형 조회 (사용자별)
    user = request.user
    one_year_ago = timezone.now() - timezone.timedelta(days=365)

    # 사용 빈도 기준으로 정렬
    types = (
        AssemblyDefectEntry.objects
        .filter(
            report__created_by=user,
            defect_category=defect_type,
            created_at__gte=one_year_ago
        )
        .values('defect_type')
        .annotate(
            frequency=models.Count('defect_type'),
            last_used=models.Max('created_at')
        )
        .order_by('-frequency', '-last_used')[:limit]
    )

    # 전역 히스토리 (개인 히스토리가 부족할 때)
    if len(types) < 10:
        global_types = (
            AssemblyDefectEntry.objects
            .filter(defect_category=defect_type, created_at__gte=one_year_ago)
            .values('defect_type')
            .annotate(frequency=models.Count('defect_type'))
            .order_by('-frequency')[:limit - len(types)]
        )
        types = list(types) + list(global_types)

    result = {
        f'{defect_type}_types': [item['defect_type'] for item in types]
    }

    return Response(result)
```

### Phase 7: 테스트 구현 (Priority: Low)

#### 7.1 컴포넌트 테스트
**파일**: `src/components/__tests__/DefectTypeInput.test.tsx`

```typescript
import { render, screen, fireEvent } from '@testing-library/react';
import { DefectTypeInput } from '../assembly/DefectTypeInput';

describe('DefectTypeInput', () => {
  const mockOnChange = jest.fn();
  const defaultProps = {
    defectType: 'processing' as const,
    value: [],
    onChange: mockOnChange,
    historyOptions: ['치수불량', '표면결함', '조립불량'],
  };

  beforeEach(() => {
    mockOnChange.mockClear();
  });

  it('should render correctly', () => {
    render(<DefectTypeInput {...defaultProps} />);

    expect(screen.getByPlaceholderText('불량 유형')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('수량')).toBeInTheDocument();
    expect(screen.getByText('추가')).toBeInTheDocument();
  });

  it('should add defect entry when valid input provided', () => {
    render(<DefectTypeInput {...defaultProps} />);

    const typeInput = screen.getByPlaceholderText('불량 유형');
    const quantityInput = screen.getByPlaceholderText('수량');
    const addButton = screen.getByText('추가');

    fireEvent.change(typeInput, { target: { value: '치수불량' } });
    fireEvent.change(quantityInput, { target: { value: '5' } });
    fireEvent.click(addButton);

    expect(mockOnChange).toHaveBeenCalledWith([
      expect.objectContaining({
        type: '치수불량',
        quantity: 5,
        id: expect.any(String),
      })
    ]);
  });

  it('should prevent duplicate defect types', () => {
    const props = {
      ...defaultProps,
      value: [{ id: '1', type: '치수불량', quantity: 3 }],
    };

    render(<DefectTypeInput {...props} />);

    const typeInput = screen.getByPlaceholderText('불량 유형');
    const quantityInput = screen.getByPlaceholderText('수량');
    const addButton = screen.getByText('추가');

    fireEvent.change(typeInput, { target: { value: '치수불량' } });
    fireEvent.change(quantityInput, { target: { value: '5' } });

    expect(addButton).toBeDisabled();
  });
});
```

### Phase 8: 문서화 및 최종 검증 (Priority: Low)

#### 8.1 사용자 매뉴얼 작성
**파일**: `docs/assembly-defect-guide.md`

```markdown
# 가공 생산 기록 불량 입력 가이드

## 개요
가공 생산 기록에서 불량 정보를 입력하는 방법을 설명합니다.

## 불량 카테고리
1. **사출불량**: 사출 공정에서 발생한 불량 (기존 입고불량에서 명칭 변경)
2. **가공불량**: 가공 공정에서 발생한 불량 (동적 입력)
3. **외주불량**: 외주 업체에서 발생한 불량 (동적 입력)

## 입력 방법
### 가공불량/외주불량 입력
1. 불량 유형 선택 또는 직접 입력
2. 불량 수량 입력
3. "추가" 버튼 클릭
4. 추가된 불량 목록에서 수정/삭제 가능

### 히스토리 기능
- 이전에 입력한 불량 유형이 드롭다운에 자동 표시
- 자주 사용하는 유형일수록 상단에 배치
- 새로운 불량 유형도 자유롭게 입력 가능
```

#### 8.2 개발자 문서
**파일**: `docs/development/defect-system-dev-guide.md`

```markdown
# 불량 관리 시스템 개발 가이드

## 아키텍처 개요
- **Frontend**: React + TypeScript
- **Backend**: Django REST Framework
- **Database**: PostgreSQL

## 주요 컴포넌트
1. `ComboBox`: 히스토리 기반 자동완성 입력
2. `DefectTypeInput`: 불량 유형 동적 관리
3. `AssemblyReportForm`: 메인 폼 통합

## API 엔드포인트
- `GET /assembly/defect-types/history/`: 불량 유형 히스토리
- `POST /assembly/reports/`: 생산 기록 저장 (불량 포함)

## 확장 가능성
- 다국어 불량 유형 매핑
- 불량 분석 대시보드
- 불량 처리 워크플로
```

## 구현 체크리스트

### Phase 1 ✓
- [ ] AssemblyReportForm 레이아웃 변경
- [ ] 사출불량 명칭 변경
- [ ] i18n 키 추가/수정

### Phase 2 ✓
- [ ] ComboBox 기본 구현
- [ ] 키보드 네비게이션
- [ ] 히스토리 기반 자동완성

### Phase 3 ✓
- [ ] DefectTypeInput 기본 구현
- [ ] 동적 불량 목록 관리
- [ ] 인라인 편집 기능

### Phase 4 ✓
- [ ] AssemblyReportForm 통합
- [ ] 상태 관리 연동
- [ ] 집계값 자동 계산

### Phase 5 ✓
- [ ] useDefectHistory 훅
- [ ] API 통합
- [ ] 에러 핸들링

### Phase 6 ✓
- [ ] Django 모델 확장
- [ ] 시리얼라이저 수정
- [ ] 히스토리 API 구현

### Phase 7 ✓
- [ ] 단위 테스트
- [ ] 통합 테스트
- [ ] E2E 테스트

### Phase 8 ✓
- [ ] 사용자 매뉴얼
- [ ] 개발자 문서
- [ ] 성능 최적화

이 구현 가이드라인을 따라 단계적으로 개발하면 안정적이고 사용자 친화적인 불량 관리 시스템을 구축할 수 있습니다.