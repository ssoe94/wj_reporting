# DefectTypeInput 컴포넌트 설계 명세

## 컴포넌트 개요

동적 불량 유형 및 수량 관리를 위한 복합 입력 컴포넌트입니다. ComboBox를 통한 히스토리 기반 자동완성과 직접 입력을 지원하며, 추가된 불량 항목들을 리스트 형태로 관리합니다.

## TypeScript 인터페이스

```typescript
interface DefectEntry {
  id: string;
  type: string;      // 불량 유형명
  quantity: number;  // 수량
  timestamp?: Date;  // 추가 시점 (옵션)
}

interface DefectTypeInputProps {
  defectType: 'processing' | 'outsourcing';
  value: DefectEntry[];
  onChange: (entries: DefectEntry[]) => void;
  historyOptions?: string[];
  disabled?: boolean;
  className?: string;
  maxEntries?: number;
  allowDuplicateTypes?: boolean;
}
```

## 컴포넌트 구조

### 1. 입력 섹션 (상단)
```tsx
<div className="defect-input-section">
  {/* 불량 유형 ComboBox */}
  <ComboBox
    options={historyOptions}
    value={currentType}
    onChange={setCurrentType}
    placeholder="불량 유형을 선택하거나 입력하세요"
    allowCustomInput={true}
    className="defect-type-combo"
  />

  {/* 수량 입력 */}
  <Input
    type="number"
    min="1"
    value={currentQuantity}
    onChange={setCurrentQuantity}
    placeholder="수량"
    className="defect-quantity-input"
  />

  {/* 추가 버튼 */}
  <Button
    type="button"
    onClick={handleAddEntry}
    disabled={!canAdd}
    className="add-defect-btn"
  >
    <Plus className="w-4 h-4" />
    추가
  </Button>
</div>
```

### 2. 불량 목록 섹션 (하단)
```tsx
<div className="defect-list-section">
  {value.map((entry) => (
    <DefectEntryItem
      key={entry.id}
      entry={entry}
      onUpdate={handleUpdateEntry}
      onDelete={handleDeleteEntry}
      allowEdit={true}
    />
  ))}

  {/* 총합 표시 */}
  <div className="defect-summary">
    <span className="total-label">총 불량수:</span>
    <span className="total-count">{totalQuantity}개</span>
  </div>
</div>
```

## ComboBox 컴포넌트 설계

### Props 인터페이스
```typescript
interface ComboBoxProps {
  options: string[];
  value: string;
  onChange: (value: string) => void;
  onSelect?: (value: string) => void;  // 드롭다운에서 선택 시
  placeholder?: string;
  disabled?: boolean;
  allowCustomInput?: boolean;
  maxOptions?: number;  // 표시할 최대 옵션 수
  filterMode?: 'contains' | 'startsWith' | 'exact';
  className?: string;
}
```

### 상태 관리
```typescript
interface ComboBoxState {
  isOpen: boolean;        // 드롭다운 열림/닫힘
  inputValue: string;     // 현재 입력값
  filteredOptions: string[];  // 필터링된 옵션 목록
  activeIndex: number;    // 키보드 네비게이션용 활성 인덱스
  highlightedValue: string | null;  // 현재 하이라이트된 값
}
```

### 키보드 네비게이션 지원
- **Arrow Down/Up**: 옵션 목록 네비게이션
- **Enter**: 선택된 옵션 확정
- **Escape**: 드롭다운 닫기
- **Tab**: 다음 필드로 이동

## DefectEntryItem 컴포넌트

### 표시 모드
```tsx
<div className="defect-entry-item">
  <span className="defect-type">{entry.type}</span>
  <span className="defect-quantity">{entry.quantity}개</span>
  <div className="defect-actions">
    <Button size="sm" onClick={() => setEditMode(true)}>
      <Edit className="w-3 h-3" />
    </Button>
    <Button size="sm" variant="destructive" onClick={() => onDelete(entry.id)}>
      <Trash className="w-3 h-3" />
    </Button>
  </div>
</div>
```

### 편집 모드
```tsx
<div className="defect-entry-item editing">
  <Input
    value={editType}
    onChange={setEditType}
    className="defect-type-edit"
  />
  <Input
    type="number"
    min="1"
    value={editQuantity}
    onChange={setEditQuantity}
    className="defect-quantity-edit"
  />
  <div className="defect-actions">
    <Button size="sm" onClick={handleSaveEdit}>
      <Check className="w-3 h-3" />
    </Button>
    <Button size="sm" variant="ghost" onClick={handleCancelEdit}>
      <X className="w-3 h-3" />
    </Button>
  </div>
</div>
```

## 상태 관리 로직

### 로컬 상태
```typescript
const [currentType, setCurrentType] = useState('');
const [currentQuantity, setCurrentQuantity] = useState<number | ''>('');
const [editingId, setEditingId] = useState<string | null>(null);

// 유효성 검사
const canAdd = useMemo(() => {
  if (!currentType.trim() || !currentQuantity || currentQuantity <= 0) {
    return false;
  }

  if (!allowDuplicateTypes && value.some(entry => entry.type === currentType.trim())) {
    return false;
  }

  if (maxEntries && value.length >= maxEntries) {
    return false;
  }

  return true;
}, [currentType, currentQuantity, value, allowDuplicateTypes, maxEntries]);

// 총 불량수 계산
const totalQuantity = useMemo(() =>
  value.reduce((sum, entry) => sum + entry.quantity, 0)
, [value]);
```

### 이벤트 핸들러
```typescript
const handleAddEntry = () => {
  if (!canAdd) return;

  const newEntry: DefectEntry = {
    id: generateId(),
    type: currentType.trim(),
    quantity: Number(currentQuantity),
    timestamp: new Date()
  };

  onChange([...value, newEntry]);

  // 입력 필드 초기화
  setCurrentType('');
  setCurrentQuantity('');
};

const handleUpdateEntry = (id: string, updates: Partial<DefectEntry>) => {
  const newEntries = value.map(entry =>
    entry.id === id ? { ...entry, ...updates } : entry
  );
  onChange(newEntries);
  setEditingId(null);
};

const handleDeleteEntry = (id: string) => {
  const newEntries = value.filter(entry => entry.id !== id);
  onChange(newEntries);
};
```

## 접근성 (Accessibility) 지원

### ARIA 속성
```tsx
<div
  className="defect-type-input"
  role="group"
  aria-labelledby={`defect-${defectType}-label`}
>
  <label id={`defect-${defectType}-label`}>
    {defectType === 'processing' ? '가공불량' : '외주불량'}
  </label>

  <ComboBox
    aria-label={`${defectType} 불량 유형 선택`}
    aria-describedby={`${defectType}-help`}
    role="combobox"
    aria-expanded={isOpen}
    aria-haspopup="listbox"
  />

  <ul role="listbox" aria-label="불량 유형 옵션">
    {filteredOptions.map((option, index) => (
      <li
        key={option}
        role="option"
        aria-selected={index === activeIndex}
      >
        {option}
      </li>
    ))}
  </ul>
</div>
```

### 키보드 탐색
- **Tab 순서**: ComboBox → 수량 Input → 추가 Button → 불량 목록
- **Enter 키**: 각 필드에서 다음 단계로 진행
- **화살표 키**: ComboBox 드롭다운에서만 동작

## 스타일링 (CSS/Tailwind)

### 기본 레이아웃
```css
.defect-type-input {
  @apply flex flex-col space-y-4 p-4 border border-gray-200 rounded-lg;
}

.defect-input-section {
  @apply flex flex-wrap gap-2 items-end;
}

.defect-type-combo {
  @apply flex-1 min-w-[200px];
}

.defect-quantity-input {
  @apply w-24;
}

.add-defect-btn {
  @apply px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded;
  @apply disabled:bg-gray-300 disabled:cursor-not-allowed;
}
```

### 불량 목록 스타일
```css
.defect-list-section {
  @apply mt-4 space-y-2;
}

.defect-entry-item {
  @apply flex items-center justify-between p-2 bg-gray-50 rounded border;
}

.defect-entry-item.editing {
  @apply bg-blue-50 border-blue-200;
}

.defect-summary {
  @apply flex justify-between items-center pt-2 border-t border-gray-200;
  @apply font-semibold text-lg;
}

.total-count {
  @apply text-blue-600;
}
```

## 성능 최적화

### 메모이제이션
```typescript
// 필터링된 옵션 캐싱
const filteredOptions = useMemo(() => {
  if (!historyOptions) return [];

  const query = currentType.toLowerCase();
  return historyOptions
    .filter(option => option.toLowerCase().includes(query))
    .slice(0, maxOptions || 10);
}, [historyOptions, currentType, maxOptions]);

// 컴포넌트 메모이제이션
const DefectEntryItem = memo(({ entry, onUpdate, onDelete, allowEdit }) => {
  // 컴포넌트 구현
});
```

### 디바운싱
```typescript
// 히스토리 옵션 로딩 디바운싱
const debouncedLoadHistory = useMemo(
  () => debounce((defectType: string) => {
    loadDefectHistory(defectType);
  }, 300),
  []
);
```

## 에러 핸들링

### 유효성 검사 메시지
```typescript
const validationErrors = useMemo(() => {
  const errors: string[] = [];

  if (currentType.trim() && currentType.trim().length < 2) {
    errors.push('불량 유형은 2글자 이상 입력해주세요');
  }

  if (currentQuantity && (currentQuantity <= 0 || !Number.isInteger(currentQuantity))) {
    errors.push('수량은 1 이상의 정수를 입력해주세요');
  }

  if (!allowDuplicateTypes && value.some(entry => entry.type === currentType.trim())) {
    errors.push('이미 등록된 불량 유형입니다');
  }

  return errors;
}, [currentType, currentQuantity, value, allowDuplicateTypes]);
```

### 사용자 피드백
```tsx
{validationErrors.length > 0 && (
  <div className="validation-errors">
    {validationErrors.map((error, index) => (
      <p key={index} className="text-sm text-red-600">
        {error}
      </p>
    ))}
  </div>
)}
```

## 테스트 시나리오

### 단위 테스트
1. **불량 추가**: 올바른 입력으로 불량 항목 추가
2. **중복 방지**: 같은 유형 중복 추가 시 에러
3. **수량 유효성**: 0 이하 수량 입력 시 추가 버튼 비활성화
4. **총 수량 계산**: 불량 항목 추가/삭제 시 총합 올바른 계산

### 통합 테스트
1. **히스토리 로딩**: 불량 유형 히스토리 API 연동
2. **자동완성**: 타이핑 시 필터링된 옵션 표시
3. **키보드 네비게이션**: 전체 컴포넌트 키보드 조작 가능

### E2E 테스트
1. **사용자 플로우**: 불량 등록부터 저장까지 전체 과정
2. **데이터 지속성**: 페이지 새로고침 후 데이터 복원
3. **다중 사용자**: 동시 편집 시나리오

이 설계는 사용자 경험과 개발자 경험을 모두 고려하여 재사용 가능하고 유지보수하기 쉬운 컴포넌트를 제공합니다.