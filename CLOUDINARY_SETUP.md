# Cloudinary 이미지 업로드 설정 완료

## ✅ 완료된 작업

### 1. 백엔드 (Django)

#### 파일 변경사항
- `backend/.env`: Cloud name을 `deoic09y3`로 수정
- `backend/quality/cloudinary_utils.py`: 서명 생성 로직 (timestamp만 서명)
- `backend/quality/views.py`: `/api/quality/cloudinary-signature/` 엔드포인트 추가 (CSRF 면제)
- `backend/quality/urls.py`: 서명 엔드포인트 라우팅 추가
- `backend/quality/models.py`: ImageField → URLField로 변경
- `backend/quality/serializers.py`: URL 필드 처리 단순화
- 마이그레이션 적용 완료

#### 서명 엔드포인트
```
POST /api/quality/cloudinary-signature/
Authorization: Bearer <token>

Response:
{
  "signature": "...",
  "timestamp": 1234567890,
  "api_key": "877653359158871",
  "cloud_name": "deoic09y3",
  "upload_preset": "wj-reporting"
}
```

### 2. 프론트엔드 (React)

#### 파일 변경사항
- `frontend/src/utils/cloudinaryUpload.ts`: Cloudinary 업로드 유틸리티
- `frontend/src/pages/quality/QualityReportForm.tsx`: 
  - Cloudinary 업로드 통합
  - 업로드 중 로딩 상태 표시
  - 이미지 URL을 JSON으로 전송

#### 업로드 플로우
1. 사용자가 이미지 선택
2. 폼 제출 시 각 이미지를 Cloudinary에 업로드
3. 업로드된 URL을 받아서 백엔드로 전송
4. 백엔드는 URL만 저장

## 🔧 Cloudinary 설정 (대시보드)

### Upload Preset: `wj-reporting`
- **Signing mode**: Signed
- **Asset folder**: quality (자동 설정됨)
- **Public ID**: auto-generate
- **Overwrite**: true (선택사항)

### 환경 변수
```env
CLOUDINARY_CLOUD_NAME=deoic09y3
CLOUDINARY_API_KEY=877653359158871
CLOUDINARY_API_SECRET=yrbdGKk59s0Q3M8dWsBoUPdVUFE
# Render 같은 PaaS에서는 아래처럼 단일 URL을 제공하기도 합니다.
# CLOUDINARY_URL=cloudinary://877653359158871:yrbdGKk59s0Q3M8dWsBoUPdVUFE@deoic09y3
# 백엔드는 위 URL을 자동으로 파싱하여 Cloud name과 키를 채워줍니다.
```

## 🧪 테스트 방법

### 1. 백엔드 서버 재시작
```bash
cd backend
python manage.py runserver
```

### 2. 프론트엔드 재시작
```bash
cd frontend
npm run dev
```

### 3. 테스트 시나리오
1. `/quality` 페이지 접속
2. "불량 보고" 탭 선택
3. 폼 작성 (모델, Part No. 등)
4. 이미지 업로드 (최대 3장)
5. 저장 버튼 클릭
6. 콘솔에서 Cloudinary URL 확인
7. "보고 이력" 탭에서 이미지 썸네일 확인

### 4. 디버깅 체크포인트

#### 브라우저 콘솔
```javascript
// 서명 데이터 확인
📝 Signature data: {
  cloud_name: "deoic09y3",
  upload_preset: "wj-reporting",
  timestamp: 1234567890
}

// 업로드 URL 확인
📤 Uploading to: https://api.cloudinary.com/v1_1/deoic09y3/image/upload

// 성공 시
✅ Cloudinary upload success: https://res.cloudinary.com/deoic09y3/image/upload/...
```

#### 예상 에러 및 해결

**401 Unauthorized**
- Cloud name이 틀림 → `.env`에서 `deoic09y3` 확인
- API Key가 틀림 → 환경 변수 확인
- 서명이 틀림 → timestamp만 서명하는지 확인

**404 Not Found**
- Upload preset이 없음 → Cloudinary 대시보드에서 `wj-reporting` preset 생성 확인

**CORS Error**
- Cloudinary는 CORS를 허용하므로 발생하지 않아야 함
- 백엔드 서명 엔드포인트 CORS 확인

## 🔒 보안 체크리스트

✅ API Secret은 백엔드에만 존재
✅ 프론트엔드는 서명만 받아서 사용
✅ 서명 엔드포인트는 인증 필요 (IsAuthenticated)
✅ CSRF 면제 처리 완료
✅ Signed preset 사용으로 무단 업로드 방지

## 📝 cURL 테스트

### 1. 서명 받기
```bash
curl -X POST http://localhost:8000/api/quality/cloudinary-signature/ \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"folder": "quality"}'
```

### 2. Cloudinary에 업로드
```bash
curl -X POST "https://api.cloudinary.com/v1_1/deoic09y3/image/upload" \
  -F "file=@/path/to/image.jpg" \
  -F "api_key=877653359158871" \
  -F "timestamp=TIMESTAMP_FROM_STEP1" \
  -F "signature=SIGNATURE_FROM_STEP1" \
  -F "upload_preset=wj-reporting"
```

## 🚀 배포 시 주의사항

### Render 환경 변수
```
CLOUDINARY_CLOUD_NAME=deoic09y3
CLOUDINARY_API_KEY=877653359158871
CLOUDINARY_API_SECRET=yrbdGKk59s0Q3M8dWsBoUPdVUFE
```

### 프론트엔드 환경 변수 (필요 시)
```
VITE_API_BASE_URL=https://your-backend.onrender.com/api
```

## 📚 참고 자료

- [Cloudinary Upload API](https://cloudinary.com/documentation/image_upload_api_reference)
- [Signed Upload](https://cloudinary.com/documentation/upload_images#signed_uploads)
- [Upload Presets](https://cloudinary.com/documentation/upload_presets)
