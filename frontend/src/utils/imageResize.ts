/**
 * 이미지 리사이징 유틸리티
 * 긴 변 기준으로 최대 크기를 제한하여 이미지를 리사이징합니다.
 */

export interface ResizeOptions {
  maxSize?: number; // 긴 변의 최대 크기 (기본값: 1024px)
  quality?: number; // 이미지 품질 (0-1, 기본값: 0.9)
  format?: 'image/jpeg' | 'image/png' | 'image/webp'; // 출력 포맷 (기본값: 원본 유지)
}

/**
 * 이미지 파일을 리사이징합니다.
 * 긴 변이 maxSize보다 크면 비율을 유지하면서 축소하고,
 * 작으면 원본 그대로 반환합니다.
 *
 * @param file - 리사이징할 이미지 파일
 * @param options - 리사이징 옵션
 * @returns 리사이징된 이미지 파일
 */
export async function resizeImage(
  file: File,
  options: ResizeOptions = {}
): Promise<File> {
  const {
    maxSize = 1024,
    quality = 0.9,
    format = file.type as 'image/jpeg' | 'image/png' | 'image/webp',
  } = options;

  return new Promise((resolve, reject) => {
    // 이미지가 아닌 파일은 그대로 반환
    if (!file.type.startsWith('image/')) {
      resolve(file);
      return;
    }

    const img = new Image();
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    if (!ctx) {
      reject(new Error('Canvas context를 생성할 수 없습니다'));
      return;
    }

    img.onload = () => {
      try {
        const { width, height } = img;

        // 긴 변 찾기
        const longerSide = Math.max(width, height);

        // 리사이징이 필요한지 확인
        if (longerSide <= maxSize) {
          console.log(`📏 Image size ${width}x${height} is within limit, using original`);
          resolve(file);
          return;
        }

        // 비율 계산
        const ratio = maxSize / longerSide;
        const newWidth = Math.round(width * ratio);
        const newHeight = Math.round(height * ratio);

        console.log(`📐 Resizing image from ${width}x${height} to ${newWidth}x${newHeight}`);

        // 캔버스 크기 설정
        canvas.width = newWidth;
        canvas.height = newHeight;

        // 이미지 그리기 (고품질 설정)
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, newWidth, newHeight);

        // Blob으로 변환
        canvas.toBlob(
          (blob) => {
            if (!blob) {
              reject(new Error('이미지 변환에 실패했습니다'));
              return;
            }

            // File 객체 생성
            const resizedFile = new File([blob], file.name, {
              type: format,
              lastModified: Date.now(),
            });

            console.log(`✅ Resized: ${(file.size / 1024).toFixed(1)}KB → ${(resizedFile.size / 1024).toFixed(1)}KB`);

            resolve(resizedFile);
          },
          format,
          quality
        );
      } catch (error) {
        reject(error);
      }
    };

    img.onerror = () => {
      reject(new Error('이미지를 로드할 수 없습니다'));
    };

    // 이미지 로드
    img.src = URL.createObjectURL(file);
  });
}

/**
 * 여러 이미지를 리사이징합니다.
 *
 * @param files - 리사이징할 이미지 파일 배열
 * @param options - 리사이징 옵션
 * @returns 리사이징된 이미지 파일 배열
 */
export async function resizeImages(
  files: File[],
  options: ResizeOptions = {}
): Promise<File[]> {
  const resizedFiles: File[] = [];

  for (const file of files) {
    try {
      const resized = await resizeImage(file, options);
      resizedFiles.push(resized);
    } catch (error) {
      console.error(`Failed to resize ${file.name}:`, error);
      // 리사이징 실패 시 원본 사용
      resizedFiles.push(file);
    }
  }

  return resizedFiles;
}
