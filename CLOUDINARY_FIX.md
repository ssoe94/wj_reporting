# Cloudinary 업로드 문제 수정

## 🔧 수정 사항

### 1. Invalid Signature 에러 수정

**문제**: Cloudinary가 "Invalid Signature" 에러 반환

**원인**: 서명에 `upload_preset`이 포함되지 않음

**해결**: 
```python
# backend/quality/cloudinary_utils.py
params_to_sign = {
    'timestamp': timestamp,
    'upload_preset': 'wj-reporting',  # 추가!
}
```

### 2. 보고일시 자동 입력

**변경 전**: 사용자가 직접 입력해야 하며, 비어있으면 에러

**변경 후**: 
- 폼 로드 시 현재 시간으로 자동 설정
- 저장 후 폼 초기화 시에도 현재 시간으로 재설정
- 비어있어도 자동으로 현재 시간 사용

```typescript
const getCurrentDateTime = () => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day}T${hours}:${minutes}`;
};
```

## 🧪 테스트 방법

### 1. Django 서버 재시작 (중요!)
```bash
cd backend
python manage.py runserver
```

### 2. 브라우저 캐시 클리어 및 새로고침
- Ctrl + Shift + R (Windows/Linux)
- Cmd + Shift + R (Mac)

### 3. 테스트 시나리오

#### A. 이미지 업로드 테스트
1. `/quality` 페이지 접속
2. "불량 보고" 탭 선택
3. 보고일시가 자동으로 현재 시간으로 설정되어 있는지 확인
4. 모델과 Part No. 입력
5. 이미지 1-3장 선택
6. 저장 버튼 클릭
7. 콘솔 확인:
   ```
   📝 Signature data: { cloud_name: "deoic09y3", ... }
   📤 Uploading to: https://api.cloudinary.com/v1_1/deoic09y3/image/upload
   ✅ Cloudinary upload success: https://res.cloudinary.com/...
   ```

#### B. 보고일시 자동 입력 테스트
1. 페이지 로드 시 보고일시 필드에 현재 시간이 자동으로 입력되어 있는지 확인
2. 보고서 저장 후 폼이 초기화되면서 보고일시가 다시 현재 시간으로 설정되는지 확인

## 🐛 디버깅

### 콘솔에서 확인할 내용

#### 성공 케이스
```javascript
📝 Signature data: {
  cloud_name: "deoic09y3",
  upload_preset: "wj-reporting",
  timestamp: 1234567890,
  api_key: "877653359158871"
}
📤 Uploading to: https://api.cloudinary.com/v1_1/deoic09y3/image/upload
✅ Cloudinary upload success: https://res.cloudinary.com/deoic09y3/image/upload/v1234567890/quality/abc123.jpg
```

#### 실패 케이스 및 해결

**여전히 Invalid Signature**
1. Django 서버 재시작 확인
2. 브라우저 캐시 클리어
3. 서명 데이터 확인:
   ```bash
   curl -X POST http://localhost:8000/api/quality/cloudinary-signature/ \
     -H "Authorization: Bearer YOUR_TOKEN" \
     -H "Content-Type: application/json"
   ```

**401 Unauthorized (Cloudinary)**
- Cloud name 확인: `deoic09y3`
- API Key 확인: `877653359158871`

**Upload Preset Not Found**
- Cloudinary 대시보드에서 `wj-reporting` preset 존재 확인
- Signing mode가 "Signed"인지 확인

## 📋 체크리스트

- [x] 서명에 `upload_preset` 포함
- [x] 보고일시 자동 입력 구현
- [x] 폼 초기화 시 보고일시 재설정
- [x] Django 서버 재시작 필요
- [ ] 실제 이미지 업로드 테스트
- [ ] 업로드된 이미지 URL 확인
- [ ] 보고 이력에서 이미지 표시 확인

## 🔍 추가 확인사항

### Cloudinary 대시보드 확인
1. Settings > Upload > Upload presets
2. `wj-reporting` preset 클릭
3. 확인 사항:
   - Signing mode: **Signed**
   - Folder: **quality** (또는 비어있음)
   - Access mode: **Public** (기본값)

### 환경 변수 재확인
```bash
# backend/.env
CLOUDINARY_CLOUD_NAME=deoic09y3  # ← 이게 맞는지 확인!
CLOUDINARY_API_KEY=877653359158871
CLOUDINARY_API_SECRET=yrbdGKk59s0Q3M8dWsBoUPdVUFE
```

## 🚀 다음 단계

1. Django 서버 재시작
2. 프론트엔드 새로고침 (캐시 클리어)
3. 이미지 업로드 테스트
4. 성공 시 → 완료! 🎉
5. 실패 시 → 콘솔 에러 메시지 확인 후 추가 디버깅
