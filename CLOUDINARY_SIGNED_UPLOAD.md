# Cloudinary Signed Upload 구현

## ✅ 수정 완료

### 핵심 변경사항

1. **서명에 포함되는 파라미터**
   ```python
   params_to_sign = {
       'timestamp': timestamp,
       'folder': folder,  # folder를 보낼 경우 서명에 포함
   }
   # upload_preset은 서명에 포함하지 않음 (Signed preset이므로)
   ```

2. **프론트엔드에서 보내는 파라미터 순서**
   ```javascript
   formData.append('file', file);
   formData.append('api_key', signData.api_key);
   formData.append('timestamp', signData.timestamp.toString());
   formData.append('signature', signData.signature);
   formData.append('folder', signData.folder);
   formData.append('upload_preset', signData.upload_preset);
   ```

## 🔑 Cloudinary Signed Upload 규칙

### 서명에 포함해야 하는 것
- ✅ `timestamp` (필수)
- ✅ `folder` (보낼 경우)
- ❌ `file` (제외)
- ❌ `api_key` (제외)
- ❌ `upload_preset` (Signed preset 사용 시 제외)

### 서명 생성 방법
```python
# 1. 파라미터를 알파벳 순으로 정렬
sorted_params = sorted(params_to_sign.items())

# 2. key=value 형식으로 결합
params_string = '&'.join([f'{k}={v}' for k, v in sorted_params])
# 결과: "folder=quality&timestamp=1234567890"

# 3. API Secret 추가
params_string += API_SECRET

# 4. SHA-1 해시
signature = hashlib.sha1(params_string.encode('utf-8')).hexdigest()
```

## 🧪 테스트 방법

### 1. Django 서버 재시작
```bash
cd backend
python manage.py runserver
```

### 2. 브라우저 콘솔 확인
```javascript
// 성공 시 출력
📝 Signature data: {
  cloud_name: "deoic09y3",
  upload_preset: "quality",
  timestamp: 1234567890,
  folder: "quality",
  signature: "abc123def4..."
}
📤 Uploading to: https://api.cloudinary.com/v1_1/deoic09y3/image/upload
✅ Cloudinary upload success: https://res.cloudinary.com/deoic09y3/...
```

### 3. 실패 시 디버깅

#### Invalid Signature
- 서명에 포함된 파라미터와 실제 전송 파라미터가 일치하는지 확인
- `folder`를 보내면 서명에도 포함해야 함
- `upload_preset`은 서명에 포함하지 않음 (Signed preset)

#### 401 Unauthorized
- Cloud name 확인: `deoic09y3`
- API Key 확인
- Timestamp가 너무 오래되지 않았는지 확인 (10분 이내)

## 📋 Cloudinary 대시보드 설정

### Upload Preset: `quality`
1. Settings > Upload > Upload presets
2. Preset name: `quality`
3. **Signing mode: Signed** ✅
4. Folder: `quality` (또는 비워두고 업로드 시 지정)
5. Access mode: Public

## 🔒 보안 체크

- ✅ API Secret은 백엔드에만 존재
- ✅ 프론트엔드는 서명만 받아서 사용
- ✅ Signed preset 사용으로 무단 업로드 방지
- ✅ Timestamp로 서명 유효기간 제한

## 🚀 배포 시 환경 변수

```env
CLOUDINARY_CLOUD_NAME=deoic09y3
CLOUDINARY_API_KEY=877653359158871
CLOUDINARY_API_SECRET=yrbdGKk59s0Q3M8dWsBoUPdVUFE
```

## 📚 참고

- [Cloudinary Signed Upload](https://cloudinary.com/documentation/upload_images#signed_uploads)
- [Upload API Reference](https://cloudinary.com/documentation/image_upload_api_reference)
