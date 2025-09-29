# 불량 카테고리 재구성 명세서

## 개요

Assembly 가공 생산 기록의 불량 카테고리 구조를 기존 시스템에서 요구사항에 맞게 재설계합니다. 명칭 변경, 레이아웃 개선, 그리고 동적 불량 유형 관리 시스템을 포함합니다.

## 현재 시스템 vs 목표 시스템 비교

### 기존 구조 (AS-IS)
```
불량기록 카드
├── 입고불량 (assembly_incoming_defect)        [아코디언]
│   └── 11개 고정 세부 항목 (划伤, 黑点, 吃肉, etc.)
├── 가공불량 (processing_defect)               [아코디언]
│   └── 4개 고정 세부 항목 (划伤, 印刷, 加工修理, 기타)
└── 외주불량 (outsourcing_defect)              [단일 숫자 입력]
```

### 목표 구조 (TO-BE)
```
불량기록 카드
├── 사출불량 (injection_defect)               [아코디언 - 기존 유지]
│   └── 11개 고정 세부 항목 (기존과 동일)
└── 가공 & 외주불량 (2열 그리드)              [확장된 카드]
    ├── [좌] 가공불량 (processing_defect)     [동적 관리]
    │   ├── 불량유형 ComboBox + 수량 Input + 추가 버튼
    │   └── 추가된 불량 목록 (실시간 관리)
    └── [우] 외주불량 (outsourcing_defect)    [동적 관리]
        ├── 불량유형 ComboBox + 수량 Input + 추가 버튼
        └── 추가된 불량 목록 (실시간 관리)
```

## 상세 변경사항

### 1. 명칭 변경
| 기존 | 변경 후 | 비고 |
|------|---------|------|
| 입고불량 (assembly_incoming_defect) | 사출불량 (injection_defect) | 명칭만 변경, 기능은 동일 |
| 가공불량 (processing_defect) | 가공불량 (processing_defect) | 명칭 유지, 관리 방식 변경 |
| 외주불량 (outsourcing_defect) | 외주불량 (outsourcing_defect) | 명칭 유지, 관리 방식 변경 |

### 2. 레이아웃 재구성

#### 기존 레이아웃 (수직 배열)
```css
.defect-record-card {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.defect-section {
  width: 100%;
}
```

#### 신규 레이아웃 (혼합 배열)
```css
.defect-record-card {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.injection-defect-section {
  width: 100%;  /* 사출불량: 전체 너비 */
}

.machining-defect-section {
  display: grid;
  grid-template-columns: 1fr 1fr;  /* 가공+외주: 2열 그리드 */
  gap: 1rem;
}

@media (max-width: 768px) {
  .machining-defect-section {
    grid-template-columns: 1fr;  /* 모바일: 단일 열 */
  }
}
```

### 3. 데이터 모델 변경

#### 기존 데이터 구조
```typescript
interface AssemblyReportDefects {
  // 고정 불량 수치 (집계값)
  injection_defect: number;      // 사출불량 (구 입고불량)
  processing_defect: number;     // 가공불량
  outsourcing_defect: number;    // 외주불량

  // 사출불량 세부사항 (고정 구조)
  incoming_defects_detail: {
    scratch: number;        // 划伤
    black_dot: number;      // 黑点
    eaten_meat: number;     // 吃肉
    air_mark: number;       // 气印
    deform: number;         // 变形
    short_shot: number;     // 浇不足
    broken_pillar: number;  // 断柱子
    flow_mark: number;      // 料花
    sink_mark: number;      // 缩瘪
    whitening: number;      // 发白
    other: number;          // 其他
  };

  // 가공불량 세부사항 (고정 구조)
  processing_defects_detail: {
    scratch: number;        // 划伤
    printing: number;       // 印刷
    rework: number;         // 加工修理
    other: number;          // 其他
  };
}
```

#### 신규 데이터 구조
```typescript
interface DefectEntry {
  id: string;
  type: string;           // 불량 유형명 (자유 입력)
  quantity: number;       // 불량 수량
  created_at?: Date;      // 생성 시간
}

interface AssemblyReportDefects {
  // 집계값 (자동 계산 - 호환성 유지)
  injection_defect: number;      // 사출불량 총합
  processing_defect: number;     // 가공불량 총합 (자동 계산)
  outsourcing_defect: number;    // 외주불량 총합 (자동 계산)

  // 사출불량 세부사항 (기존 구조 유지)
  injection_defects_detail: {
    scratch: number;
    black_dot: number;
    eaten_meat: number;
    air_mark: number;
    deform: number;
    short_shot: number;
    broken_pillar: number;
    flow_mark: number;
    sink_mark: number;
    whitening: number;
    other: number;
  };

  // 동적 불량 항목 관리 (신규 구조)
  processing_defects_entries: DefectEntry[];  // 가공불량 동적 목록
  outsourcing_defects_entries: DefectEntry[]; // 외주불량 동적 목록
}
```

### 4. API 변경사항

#### 신규 엔드포인트
```http
# 불량 유형 히스토리 조회
GET /api/assembly/defect-types/history/
Query Parameters:
  - type: 'processing' | 'outsourcing'
  - limit: number (default: 50)
  - search: string (optional, 검색어 필터링)

Response:
{
  "processing_types": ["치수불량", "표면결함", "조립불량", ...],
  "outsourcing_types": ["도장불량", "가공정밀도", "재료결함", ...]
}

# 불량 유형별 통계 조회 (선택사항)
GET /api/assembly/defect-types/stats/
Query Parameters:
  - type: 'processing' | 'outsourcing'
  - period: '7d' | '30d' | '90d'

Response:
{
  "stats": [
    {
      "type": "치수불량",
      "frequency": 45,      // 사용 빈도
      "total_quantity": 234, // 총 불량수
      "avg_quantity": 5.2   // 평균 불량수
    }
  ]
}
```

#### 기존 API 수정
```http
# 어셈블리 리포트 저장/수정
POST /api/assembly/reports/
PUT /api/assembly/reports/{id}/

기존 payload에 추가:
{
  "processing_defects_entries": [
    {
      "id": "uuid-1",
      "type": "치수불량",
      "quantity": 5
    },
    {
      "id": "uuid-2",
      "type": "표면결함",
      "quantity": 3
    }
  ],
  "outsourcing_defects_entries": [
    {
      "id": "uuid-3",
      "type": "도장불량",
      "quantity": 2
    }
  ],

  # 호환성을 위해 집계값도 함께 전송
  "processing_defect": 8,  # 5 + 3
  "outsourcing_defect": 2
}
```

### 5. 히스토리 관리 로직

#### 히스토리 수집 규칙
```typescript
interface DefectHistoryRule {
  // 수집 대상
  collectFrom: {
    timeRange: '1year';          // 최근 1년간 데이터
    minFrequency: 3;            // 최소 3회 이상 사용된 유형만
    excludeGeneric: true;       // '기타', 'other' 등 제외
  };

  // 정렬 기준
  sortBy: {
    primary: 'frequency';       // 사용 빈도 우선
    secondary: 'recency';       // 최근 사용 순
    tertiary: 'alphabetical';   // 가나다/ABC 순
  };

  // 개인화
  personalization: {
    userSpecific: true;         // 사용자별 히스토리
    teamSpecific: false;        // 팀별 히스토리 (추후 고려)
    globalFallback: true;       // 개인 히스토리 없을 때 전체 히스토리 사용
  };
}
```

#### 히스토리 캐싱 전략
```typescript
interface HistoryCache {
  key: string;                  // 'defect_history_{type}_{userId}'
  ttl: 3600;                   // 1시간 캐시
  invalidateOn: [
    'defect_entry_added',       // 새 불량 항목 추가 시
    'daily_refresh'            // 매일 자정 갱신
  ];

  fallback: {
    useStale: true;            // 캐시 만료 시 기존 데이터 사용
    backgroundRefresh: true;    // 백그라운드에서 갱신
  };
}
```

### 6. 마이그레이션 계획

#### Phase 1: 데이터 모델 확장
```sql
-- 새로운 테이블 생성
CREATE TABLE assembly_defect_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    report_id INTEGER REFERENCES assembly_reports(id),
    defect_category VARCHAR(20) CHECK (defect_category IN ('processing', 'outsourcing')),
    defect_type VARCHAR(100) NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_defect_entries_report ON assembly_defect_entries(report_id);
CREATE INDEX idx_defect_entries_category ON assembly_defect_entries(defect_category);
CREATE INDEX idx_defect_entries_type ON assembly_defect_entries(defect_type);
```

#### Phase 2: 기존 데이터 마이그레이션
```python
def migrate_existing_defects():
    """기존 processing_defect, outsourcing_defect 값을 새 구조로 변환"""

    reports = AssemblyReport.objects.exclude(
        processing_defect=0, outsourcing_defect=0
    )

    for report in reports:
        # 가공불량 마이그레이션
        if report.processing_defect > 0:
            # 기존 processing_defects_detail이 있다면 활용
            if hasattr(report, 'processing_defects_detail'):
                for defect_type, quantity in report.processing_defects_detail.items():
                    if quantity > 0:
                        DefectEntry.objects.create(
                            report=report,
                            defect_category='processing',
                            defect_type=get_korean_defect_name(defect_type),
                            quantity=quantity
                        )
            else:
                # 상세 내역이 없다면 일반적인 항목으로 생성
                DefectEntry.objects.create(
                    report=report,
                    defect_category='processing',
                    defect_type='가공불량(기존)',
                    quantity=report.processing_defect
                )

        # 외주불량 마이그레이션 (동일 로직)
        if report.outsourcing_defect > 0:
            DefectEntry.objects.create(
                report=report,
                defect_category='outsourcing',
                defect_type='외주불량(기존)',
                quantity=report.outsourcing_defect
            )
```

#### Phase 3: 역방향 호환성 보장
```python
class AssemblyReport(models.Model):
    # 기존 필드 유지
    processing_defect = models.IntegerField(default=0)
    outsourcing_defect = models.IntegerField(default=0)

    @property
    def processing_defects_entries(self):
        """동적 불량 항목 조회"""
        return self.defect_entries.filter(defect_category='processing')

    @property
    def outsourcing_defects_entries(self):
        """동적 불량 항목 조회"""
        return self.defect_entries.filter(defect_category='outsourcing')

    def save(self, *args, **kwargs):
        """저장 시 집계값 자동 계산"""
        super().save(*args, **kwargs)

        # 동적 항목들의 합계로 집계값 업데이트
        self.processing_defect = sum(
            entry.quantity for entry in self.processing_defects_entries
        )
        self.outsourcing_defect = sum(
            entry.quantity for entry in self.outsourcing_defects_entries
        )

        # 무한 재귀 방지를 위해 update() 사용
        AssemblyReport.objects.filter(id=self.id).update(
            processing_defect=self.processing_defect,
            outsourcing_defect=self.outsourcing_defect
        )
```

### 7. UI 반영 변경사항

#### i18n 키 추가/변경
```typescript
// 기존 키 유지
'assembly_incoming_defect' → 'injection_defect'  // 명칭 변경

// 새로운 키 추가
'defect_type_input_placeholder': '불량 유형을 선택하거나 입력하세요',
'defect_quantity_placeholder': '수량',
'add_defect_entry': '추가',
'defect_entry_edit': '편집',
'defect_entry_delete': '삭제',
'defect_total_count': '총 불량수',
'processing_defects_title': '가공불량',
'outsourcing_defects_title': '외주불량',
'defect_type_duplicate_error': '이미 등록된 불량 유형입니다',
'defect_quantity_invalid_error': '수량은 1 이상의 정수를 입력해주세요',
'defect_type_required_error': '불량 유형을 입력해주세요'
```

#### 중국어 번역 추가
```typescript
const zh_translations = {
  'injection_defect': '注塑不良',
  'processing_defects_title': '加工不良',
  'outsourcing_defects_title': '外包不良',
  'defect_type_input_placeholder': '选择或输入不良类型',
  'defect_quantity_placeholder': '数量',
  'add_defect_entry': '添加',
  'defect_entry_edit': '编辑',
  'defect_entry_delete': '删除',
  'defect_total_count': '总不良数',
  'defect_type_duplicate_error': '已存在相同的不良类型',
  'defect_quantity_invalid_error': '数量必须是大于0的整数',
  'defect_type_required_error': '请输入不良类型'
};
```

### 8. 테스트 계획

#### 단위 테스트
```typescript
describe('DefectTypeInput', () => {
  it('should add defect entry when valid input provided', () => {});
  it('should prevent duplicate defect types when not allowed', () => {});
  it('should calculate total quantity correctly', () => {});
  it('should validate quantity input', () => {});
  it('should handle edit and delete operations', () => {});
});

describe('ComboBox', () => {
  it('should filter options based on input', () => {});
  it('should support keyboard navigation', () => {});
  it('should allow custom input when enabled', () => {});
  it('should handle empty options list', () => {});
});
```

#### 통합 테스트
```typescript
describe('Assembly Report Form Integration', () => {
  it('should load defect history on component mount', () => {});
  it('should save new defect entries correctly', () => {});
  it('should migrate existing data format', () => {});
  it('should maintain data consistency across saves', () => {});
});
```

#### E2E 테스트
```typescript
describe('Defect Management E2E', () => {
  it('should complete full defect entry workflow', () => {});
  it('should persist data across page refreshes', () => {});
  it('should handle concurrent user scenarios', () => {});
  it('should work on mobile devices', () => {});
});
```

### 9. 성능 고려사항

#### 최적화 전략
1. **히스토리 로딩**: 디바운싱된 비동기 로딩
2. **메모리 관리**: 불필요한 히스토리 데이터 정리
3. **캐싱**: 브라우저 로컬 스토리지 활용
4. **배치 업데이트**: 다중 불량 항목 일괄 저장

#### 확장성 계획
1. **다국어 지원**: 불량 유형 다국어 매핑
2. **커스텀 필드**: 불량 항목별 추가 메타데이터
3. **워크플로**: 불량 처리 프로세스 통합
4. **분석**: 불량 트렌드 및 패턴 분석

이 명세서는 기존 시스템의 안정성을 유지하면서 사용자 요구사항을 충족하는 단계적 개선 방안을 제시합니다.