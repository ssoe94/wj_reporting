## 변경 목적

- 변경 이유와 사용자 영향을 적어 주세요.

## 대상

- [ ] `main` 운영 반영

## 검증

변경에 해당하는 항목만 확인하고, 해당하지 않는 항목은 사유와 함께 `N/A`로 표시합니다. 단순 화면 수정은 [빠른 배포 기준](https://github.com/ssoe94/wj_reporting/blob/main/docs/ui-release-fast-path.md)에 따라 검증합니다.

- [ ] `frontend` 린트 통과
- [ ] `frontend` 빌드 통과
- [ ] CI 검증 범위 확인: UI fast path / Full regression
- [ ] 백엔드·계약·설정 변경 시: 백엔드 테스트 통과
- [ ] 한국어/중국어 전환 확인
- [ ] 수정한 화면 확인 (경로 기재)
- [ ] AI 변경 시: `local_worker` 테스트 통과, AI 문구 모델 중립 유지, Mac Studio 워커/브리지 재배포 필요 여부 기재

## 운영 데이터 영향

- [ ] 공용 DB 쓰기 영향 확인
- [ ] 비호환 API 또는 파괴적 마이그레이션 없음
- [ ] 삭제·초기화·일괄 변경 안전장치 확인

## 배포 확인

- [ ] 대상 Render 서비스와 브랜치 확인
- [ ] 배포 후 `build-info.json`의 커밋과 브랜치 확인
