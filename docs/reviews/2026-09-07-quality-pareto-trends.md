# 품질 유형 Pareto와 기간 추세 개선

이 문서는 2026-09-07 변경의 데이터 계약을 설명한다. 근거는 저장소 코드와 합성 테스트이며 운영 원장·수량·개인정보를 포함하지 않는다.

## 백엔드 계약

`GET /api/quality/analysis/`의 권한, 날짜·공정·설비 필터, 조회 상한과 원천은 기존 계약을 유지한다. 날짜는 `report_dt`의 Asia/Shanghai 달력 날짜다. 이 변경은 수집기·원장·DB·마이그레이션을 바꾸지 않는다.

이전 프런트와 새 프런트가 배포 전환 중 공존할 수 있도록 `schema_version="quality-analysis.v1"`와 기존 `pareto`를 보존하고 다음 필드를 추가한다.

| 필드 | 의미 |
|---|---|
| `type_pareto` | 미분류·미기재를 제외한 유형별 신고 집계. 복합 신고는 해당 canonical 유형마다 한 번씩 포함 |
| `type_pareto_summary` | 전체 신고 중 분류·제외 범위와 유형 발생수 분모 |
| `type_pareto_exclusions` | 유형 Pareto에서 제외된 미분류·현상 미기재 건수와 확인할 원장 ID |

기존 `summary`, `trend`, `concentrations`는 미분류와 현상 미기재를 포함한 **선택 범위 전체 신고**를 유지한다. 품질 점검 지표와 기존의 상호 배타적 `pareto`도 유지한다. 기존 `multiple_types_kept_in_one_bucket` 경고는 legacy `pareto`에 관한 설명이며 새 유형별 집계의 정책으로 해석하지 않는다.

### 유형별 집계

각 `type_pareto` 행은 다음 필드만 포함한다.

```text
key
label: {ko, zh}
report_count
sample_report_ids
share_of_type_occurrences_percent
cumulative_type_share_percent
```

분류는 기존 버전 사전과 `quality.daily_attention._canonical_problem_types`를 재사용한다. 한 신고에서 같은 canonical key를 반환하는 동의어가 여러 번 나오더라도 한 번만 센다. 예를 들어 스크래치 동의어가 반복되면 스크래치 유형 신고 1건이고, 스크래치와 흑점이 함께 적혀 있으면 각 유형에 신고 1건씩 포함한다. 서로 다른 원장 ID의 중복 의심 신고는 기존 정책대로 자동 제거하지 않는다.

행은 `report_count` 내림차순, 동률이면 `key` 오름차순으로 정렬한다. 모든 분류 유형을 반환하며, 각 유형의 원장 ID는 기존 최신 신고일·ID 순 조회에서 최대 5개만 제공한다. 같은 복합 신고 ID가 여러 유형의 확인 목록에 나타나는 것은 정상이다.

**유형별 수량은 제공하지 않는다.** 기존 신고의 `defect_qty`를 여러 유형에 나눌 근거가 없으므로 새 유형 행에는 `reported_defect_qty`나 수량 기재 건수 필드가 없다. `report_count`는 불량 개체 수 또는 확인된 원인 수가 아니라 해당 유형을 언급한 신고 수다. 명시적 0불량 신고도 유형을 언급했다면 유형 신고 집계에 포함된다.

비중과 누적 비중의 분모는 `type_occurrence_count = sum(type_pareto[].report_count)`다. 복합 신고 때문에 이 값은 분류된 신고 건수보다 클 수 있다. 비중은 전체 신고 대비 비중이나 불량률이 아니다. 두 비중은 소수 둘째 자리까지 반올림하며, 개별 비중의 반올림 합은 100과 소폭 다를 수 있어도 마지막 누적 비중은 100이다.

### 분류 범위와 제외 근거

`type_pareto_summary`는 항상 다음 필드를 반환한다.

```text
classified_report_count
excluded_report_count
unclassified_report_count
missing_phenomenon_report_count
multi_type_report_count
type_occurrence_count
counting_policy: "unique_report_type"
quantity_policy: "not_attributed"
```

검증 관계는 다음과 같다.

- `classified_report_count + excluded_report_count = summary.report_count`
- `excluded_report_count = unclassified_report_count + missing_phenomenon_report_count`
- `multi_type_report_count <= classified_report_count`
- `type_occurrence_count >= classified_report_count + multi_type_report_count`
- 복합 신고가 없으면 `type_occurrence_count = classified_report_count`

`type_pareto_exclusions` 행은 `key`(`missing` 또는 `unclassified`), 한중 `label`, `report_count`, `sample_report_ids`만 포함한다. 건수가 있는 사유만 `key` 오름차순으로 반환한다. 각 사유의 원장 ID는 최대 5개이며 수량·비중을 붙이지 않는다. 제외된 ID는 유형별 목록에 포함되지 않는다.

모든 신고가 미분류 또는 현상 미기재이면 `type_pareto=[]`, `classified_report_count=0`, `type_occurrence_count=0`이다. 전체 신고 수와 제외 건수·원본 확인 목록은 그대로 남는다. 신고 자체가 없는 범위는 두 목록이 모두 빈 배열이고 모든 분류 건수는 0이다. 기존 전체 신고 수량은 계속 `null`로 남아 무신고를 불량 0으로 바꾸지 않는다.

## 검증과 호환성

`backend/quality/test_analysis.py`는 기존 13개 검증을 유지하고 새 계약 8개를 추가한다. 복합 신고의 개별 유형 전개와 분모, 미분류 전체·빈 범위, 명시적 0, 반복 동의어·중복 canonical key, 최대 5개 원본 ID, 설비 필터 범위, 기존 전체 신고·수량 합계 유지가 대상이다. 격리된 SQLite 메모리 설정에서 실행하고 운영 설정·DB·네트워크는 사용하지 않는다.

배포 순서가 달라도 구 프런트는 기존 `pareto`를 계속 읽을 수 있다. 새 프런트는 새 필드의 존재와 분모 관계를 검증해야 하며, 새 계약이 아직 없는 응답에서 복합 유형을 임의로 분해하거나 이전 `multiple` 버킷을 실제 개별 유형으로 추정하면 안 된다.

기간 추세 원천은 이번 백엔드 변경으로 바뀌지 않는다. 일별 신고 0건과 불량 수량 미기재 `null`의 구분을 그대로 소비해야 한다. 화면의 이동평균과 표시 방식은 이 일별 계약을 바탕으로 별도 검증한다.

기존 원천·권한·분모의 상세 근거: [품질 신고 분석 계약](2026-09-06-quality-analysis-contract.md).

## 형합 로그에 따른 날짜 표시

사용자 요청에 따라 생산계획이 없다는 이유로 휴무를 추정하지 않는다. 사출기의 저장된 누적 형합수(`InjectionMonitoringRecord.capacity`)를 품질 보고일과 같은 Shanghai 00:00~24:00으로 확인한다. 화면의 기본 옵션은 **형합 미증가·미신고일 건너뛰기**다. 옵션 해제로 전체 달력 날짜를 복원할 수 있다. 원장 집계·기간 합계·일별 상세·CSV 원본 행은 접기와 무관하게 그대로 남는다.

날짜를 접으려면 아래 조건을 모두 만족해야 한다.

1. 당일이 아닌 완료된 과거 달력일이다.
2. 선택 설비(또는 전체 17대)마다 시작 이전과 종료 이후에 10분 이내의 기준 관측이 있고, 모든 유효 형합 관측 간격이 최대 10분이다.
3. 동일 설비에 연결된 장치 식별이 명확하고, 유효한 비음수 형합수가 하루 전체에서 일정하다. 감소·리셋·장치 변경·비정상 값은 미증가로 처리하지 않는다.
4. 해당 날짜의 선택 범위 품질 신고가 0건이고 기록 불량 수량이 `null`이다. 신고가 있거나 명시적 0인 경우는 유지한다.

일부 구간에 증가가 명확하면 변화 관측으로 남긴다. 수집 공백, 경계 근거 부족, 설비 누락, 현재 날짜는 판정 보류로 남긴다. 온도만 있는 행은 형합 관측을 대신하지 않지만 장치 식별에는 사용한다. 다른 검사 부문 또는 설비 미지정 필터는 적용 대상이 아니다. 전체 검사 부문에서는 사출 로그만 날짜 표시의 참고 근거로 사용하며, 다른 공정의 가동 여부나 회사의 휴무일을 뜻하지 않는다는 안내를 표시한다.

`activity_calendar`는 기존 품질 응답에 붙이는 선택적 보조 자료다.

```text
schema_version: quality-activity.v1
status: ready | not_applicable | unavailable
source: InjectionMonitoringRecord
timezone: Asia/Shanghai
date_basis: calendar_day
policy: continuous_constant_capacity_v1
max_gap_minutes: 10
expected_machine_count: 17 | 1 | 0
days: [{date, status: no_change | activity | unknown,
        reason, can_collapse, observed_machine_count}]
```

추가 DB 조회는 기존 설비·시각 인덱스를 사용하는 단일 범위 조회다. 원시 행 300,000개 상한과 iterator를 사용하며, 상한 초과나 DB 오류는 보조 자료만 `unavailable`로 처리한다. 프런트도 보조 계약 검증 실패 시 품질 자료를 유지하고 전체 날짜와 안내를 표시한다. MES 실시간 API 호출이나 저장·수정은 없다.

### 현재 자료의 한계와 다음 수집 과제

현재 수집 코드는 오래된 상세 로그를 시간별 마지막 샘플로 압축한다(기본 상세 보관 168시간). 이런 과거 날짜는 하루 중간의 증가·리셋 여부를 확인할 수 없어 정상적으로 판정 보류될 수 있다. 기존 rollup의 `shot_count=0`만으로 미증가를 확정하지 않는다. 저장 timestamp도 MES 원시 발생 시각 자체가 아닌 수집 기준 시각이라는 제한이 있다. **이번 변경으로 과거 휴무일이 모두 자동 식별된다고 해석하지 않는다.**

Mac Studio에서 이어갈 우선 과제는 일별 계수 근거를 압축 전에 보존하는 것이다. 원시 MES 관측 시각, 수집 성공/실패, 처음·마지막 관측, 최대 수집 공백, 유효 샘플 수, 장치 식별·변경, 증가/감소/reset 횟수, 기대 설비 목록, 집계 정책 버전을 저장할 수 있도록 설계한다. 검증된 일별 요약이 있어야 과거 기간에도 같은 기준을 적용할 수 있다. 미관측 과거 날짜를 일괄 0으로 백필하지 않는다. 실제 휴무 원인과 계획된 정지를 구분하려면 근무 달력·정지 사유도 별도 연결한다.

## 기간 추세와 CSV

막대 대신 일별 선과 최근 7개 표시일 평균을 함께 표시한다. 접기 해제 시 7개 연속 달력일 평균이다. 앞선 6개 표시일까지 평균은 비어 있고, 7개 값 중 하나라도 수량 미기재면 수량 평균은 비어 있다. 원본 날짜가 누락된 경우에도 평균을 이어 계산하지 않는다. 신고 건수의 관측 0은 유효한 값이며, 수량 미기재를 0으로 채우지 않는다. 45일을 넘으면 하단 구간 선택으로 확대할 수 있다.

CSV는 유형별 신고 수와 유형 발생수 분모를 사용하고 유형별 불량 수량 칸은 비운다. 전체 신고를 분모로 하는 설비·품번 집중도 비중은 별도 열로 구분한다. 날짜 접기 옵션, 실제 제외 날짜 수, 원본 일별 행 보존 여부, 형합 판정·사유·관측 설비 수·화면 표시 여부를 함께 내보낸다.

## 릴리스 인수와 확인

- 작업 브랜치: `codex/quality-pareto-trends-20260907`; 기준 main: `7589a85f3c106686e7250de2c20d6fadc36c9caf`.
- 로컬 프런트 전체 회귀 122개 통과. 전체 ESLint 오류 0개·기존 경고 31개. 프로덕션 빌드 통과.
- 품질 유형·형합 캘린더 38개를 포함한 백엔드 통합 회귀 76개가 격리된 SQLite 설정에서 통과했다. 권한·상한·실패 보존과 기존 사출·overview 계약을 함께 확인했다. 실제 백엔드 합성 응답도 프런트 parser·CSV·추세 함수를 통과했다. 최종 배포 SHA와 전체 CI 결과는 해당 PR 본문과 main Actions에서 확인한다.
- 합성 백엔드 응답으로 화면의 7일→5일 접기, 옵션 해제 시 7일 복원, 미기재 수량 공백, 원본 일별 행 보존, Pareto 분리·분모를 확인했다. 390px에서 문서 가로 넘침이 없고, 브라우저 오류가 없었다. 합성 사례는 운영 수치의 검증 결과가 아니다.
- Mac Studio에서는 로컬 변경을 보존한 뒤 원격 main을 fetch하고 fast-forward로 동기화한다. 이 문서와 [기존 릴리스 인수](2026-09-06-release-handoff.md)를 함께 읽는다. 운영 설정·인증 정보·로컬 검증 fixture는 커밋하지 않는다.
- 최종 서비스: [불량 분석 보고서](https://wj-reporting.onrender.com/quality/analysis). 실제 버전은 [build-info.json](https://wj-reporting.onrender.com/build-info.json)과 GitHub main 배포 SHA를 비교한다.
