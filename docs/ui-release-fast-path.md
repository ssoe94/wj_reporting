# 화면 수정의 빠른 배포

`Test and Deploy`는 변경 내용을 자동으로 분류한다. PR에 별도 라벨을 붙이거나 검사를 수동으로 생략할 필요가 없다. 기존 필수 검사 이름 `Validate application`은 유지한다.

## 빠른 경로

다음 변경만 포함한 경우 프런트 lint, 전체 프런트 계약 테스트, TypeScript 검사, 일반·legacy 빌드를 실행한다. 백엔드 Python/PostgreSQL/worker 테스트와 백엔드 재배포는 생략하고 프런트만 배포한다. 배포 커밋 확인과 운영 smoke test는 그대로 실행한다.

- `frontend/src/`의 CSS 추가·수정
- `frontend/src/assets/`, `frontend/public/`의 이미지·폰트 추가·수정: PNG, JPEG, WebP, GIF, AVIF, ICO, WOFF/WOFF2
- 기존 화면·컴포넌트 TSX의 JSX 문구와 native HTML 요소의 `className`, `title`, `aria-label`, `aria-description`, 정적인 `style` 속성 수정

TSX는 경로만으로 판단하지 않는다. TypeScript 구문 트리에서 허용된 표시 요소를 제외한 실행 구조가 같아야 한다. 표시 속성에 함수 호출, 할당, 복잡한 표현식이 있거나 계산·조건·이벤트·API·import가 바뀌면 전체 검증을 실행한다. custom component의 속성 변경도 전체 검증 대상이다. 긴 설명의 툴팁에 사용하는 단순 변수·문자열 보간은 허용한다.

## 전체 검증

백엔드, 인증·권한, API/타입/계산 로직, 진입점·라우팅, 의존성·빌드 설정, 워크플로·분류기, 알 수 없는 파일 변경은 기존 전체 검증과 양쪽 서비스 배포를 실행한다. 파일 삭제·이름 변경·심볼릭 링크, 새 TSX 파일도 보수적으로 전체 검증한다. 수동 `workflow_dispatch`는 `deploy`와 `test-only` 모두 전체 검증을 실행하므로 강제 전체 검사에도 사용할 수 있다.

## 실패하거나 취소된 이전 배포

PR은 대상 브랜치와의 merge-base부터 head까지 비교한다. main push는 마지막 커밋 하나가 아니라 push 전체 `before..after`를 비교한다. 빠른 배포에는 추가로 다음 두 기준부터 현재 커밋까지도 화면 변경만 있어야 한다.

1. 최근 성공한 main 전체 배포의 커밋. GitHub Actions의 backend deploy 단계와 deployment verification 작업이 모두 성공한 실행을 확인한다. PR, 수동 test-only, 백엔드를 생략한 UI 실행은 이 기준으로 쓰지 않는다.
2. 운영 프런트 `/build-info.json`의 main 커밋.

따라서 백엔드 변경을 포함한 이전 push가 실패·취소됐어도 뒤의 CSS push가 그 변경을 빠뜨릴 수 없다. 커밋 이력·API·기준 정보가 없거나 현재 커밋의 조상이 아니면 전체 검증한다. 최근 성공 실행 20개 안에서 전체 배포 기준을 찾지 못해도 전체 검증한다. 강제 push와 수동 실행 역시 전체 검증한다.

전체 배포 기준은 CI가 기록한 배포 증거다. 기존 backend deploy hook과 health check는 백엔드의 실제 배포 SHA까지 증명하지 않는다. 이 변경은 Render 설정·비밀값·배포 hook을 변경하지 않는다.

## 로컬 검사

기존 프런트 의존성이 있는 환경에서 실행한다.

```sh
node --test scripts/ci-change-scope.test.mjs
```

테스트는 임시 Git 이력과 가짜 Actions/배포 응답으로 판정과 누락 배포 처리를 검증한다. 외부 API나 운영 데이터를 사용하지 않는다.
