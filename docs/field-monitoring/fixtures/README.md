# 공통 요청·응답 예제

[manifest.json](manifest.json)의 각 case는 endpoint, 전송할 JSON 파일, 기대 상태코드와 응답 필드를 지정한다. `expected.ack`는 시각처럼 서버가 채우는 값을 제외한 값의 일치 조건이다. 실패 케이스는 `expected.code`를 확인한다. 모든 예제는 합성 장비 `SYNTH-STATION-01`을 정상 등록하고 장비 토큰을 발급한 상태에서 실행한다. 이 폴더에는 자격값이 들어 있지 않다.

동일 묶음 재전송을 시험할 때는 처음 보낸 JSON 본문을 저장해 바이트 그대로 다시 보낸다. 서버 테스트와 현장 에이전트 테스트는 같은 manifest를 사용한다.
