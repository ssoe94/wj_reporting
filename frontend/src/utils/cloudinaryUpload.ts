/**
 * Cloudinary 이미지 업로드 유틸리티 (Unsigned Upload)
 */
import api from '../lib/api';
import axios from 'axios';

interface CloudinaryConfig {
  cloud_name: string;
  upload_preset: string;
  api_key: string;
  timestamp: number;
  signature: string;
  folder?: string;
}

interface CloudinaryUploadResponse {
  secure_url: string;
  public_id: string;
  format: string;
  width: number;
  height: number;
  bytes: number;
  created_at: string;
}

/**
 * 백엔드에서 Cloudinary 설정 가져오기
 */
async function getConfig(folder: string = 'quality'): Promise<CloudinaryConfig> {
  try {
    const { data } = await api.post('/quality/cloudinary-signature/', { folder });
    return data;
  } catch (error: any) {
    console.error('❌ Failed to get Cloudinary config:', error);
    if (error.response?.data) {
      const errorMsg = error.response.data.detail || error.response.data.error || 'Cloudinary 설정을 가져오는데 실패했습니다';
      throw new Error(errorMsg);
    }
    throw new Error('Cloudinary 설정을 가져오는데 실패했습니다');
  }
}

/**
 * Cloudinary로 이미지 업로드 (Unsigned Upload)
 * 
 * Unsigned preset 사용 - 서명 불필요, 가장 간단한 방식
 * 
 * @param file - 업로드할 이미지 파일
 * @param folder - Cloudinary 폴더명 (기본값: 'quality')
 * @param onProgress - 업로드 진행률 콜백 (0-100)
 * @returns Cloudinary 업로드 응답 (secure_url 포함)
 */
export async function uploadToCloudinary(
  file: File,
  folder: string = 'quality',
  onProgress?: (progress: number) => void
): Promise<CloudinaryUploadResponse> {
  try {
    // 1. 백엔드에서 설정 가져오기
    const config = await getConfig(folder);

    console.log('📝 Upload config:', {
      cloud_name: config.cloud_name,
      upload_preset: config.upload_preset,
    });

    // 2. FormData 생성 (Unsigned - 서명 불필요!)
    const formData = new FormData();
    formData.append('file', file);
    formData.append('upload_preset', config.upload_preset);
    formData.append('api_key', config.api_key);
    formData.append('timestamp', config.timestamp.toString());
    formData.append('signature', config.signature);
    if (config.folder) {
      formData.append('folder', config.folder);
    }

    // 3. Cloudinary로 직접 업로드
    const cloudinaryUrl = `https://api.cloudinary.com/v1_1/${config.cloud_name}/image/upload`;

    console.log('📤 Uploading to:', cloudinaryUrl);

    const response = await axios.post<CloudinaryUploadResponse>(cloudinaryUrl, formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
      onUploadProgress: (progressEvent) => {
        if (onProgress && progressEvent.total) {
          const percentCompleted = Math.round((progressEvent.loaded * 100) / progressEvent.total);
          onProgress(percentCompleted);
        }
      },
    });

    console.log('✅ Cloudinary upload success:', response.data.secure_url);

    return response.data;
  } catch (error: any) {
    console.error('❌ Cloudinary upload error:', error);

    if (error.response) {
      console.error('❌ Error response:', error.response.data);
      console.error('❌ Error status:', error.response.status);
      throw new Error(error.response.data.error?.message || 'Upload failed');
    }

    throw error;
  }
}

/**
 * 여러 이미지를 순차적으로 업로드
 * 
 * @param files - 업로드할 이미지 파일 배열
 * @param folder - Cloudinary 폴더명
 * @param onProgress - 전체 진행률 콜백
 * @returns 업로드된 이미지 URL 배열
 */
export async function uploadMultipleToCloudinary(
  files: File[],
  folder: string = 'quality',
  onProgress?: (current: number, total: number) => void
): Promise<string[]> {
  const urls: string[] = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (onProgress) {
      onProgress(i + 1, files.length);
    }

    const result = await uploadToCloudinary(file, folder);
    urls.push(result.secure_url);
  }

  return urls;
}
