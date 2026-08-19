import axios, { type AxiosProgressEvent } from 'axios';

import type {
  QualityCloudinaryUploadReceipt,
  QualityExcelDirectUploadIntent,
  QualityExcelImportProgress,
} from './importTypes';

const MAX_CONCURRENT_UPLOADS = 3;
const CLOUDINARY_UPLOAD_TIMEOUT_MS = 120_000;

interface DeliverQualityDirectAssetsOptions {
  intents: readonly QualityExcelDirectUploadIntent[];
  media: ReadonlyMap<string, Blob>;
  receipts?: ReadonlyMap<string, QualityCloudinaryUploadReceipt>;
  onReceipt?: (
    intent: QualityExcelDirectUploadIntent,
    receipt: QualityCloudinaryUploadReceipt,
  ) => void | Promise<void>;
  confirm: (
    intent: QualityExcelDirectUploadIntent,
    receipt: QualityCloudinaryUploadReceipt,
  ) => Promise<void>;
  onProgress?: (progress: QualityExcelImportProgress) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseCloudinaryReceipt(
  value: unknown,
  intent: QualityExcelDirectUploadIntent,
): QualityCloudinaryUploadReceipt {
  if (
    !isRecord(value)
    || value.public_id !== intent.upload.public_id
    || !Number.isSafeInteger(value.version)
    || Number(value.version) <= 0
    || typeof value.signature !== 'string'
    || value.signature.length === 0
    || value.signature.length > 256
  ) {
    throw new Error('Cloudinary 사진 저장 응답을 확인할 수 없습니다. 같은 파일로 다시 시도해 주세요.');
  }
  return {
    public_id: value.public_id,
    version: Number(value.version),
    signature: value.signature,
  };
}

function assertSourceBlob(
  intent: QualityExcelDirectUploadIntent,
  media: ReadonlyMap<string, Blob>,
): Blob {
  const mediaKey = intent.media_keys[0];
  const blob = media.get(mediaKey);
  if (!blob) throw new Error(`Excel에서 직접 전송할 사진을 찾지 못했습니다: ${mediaKey}`);
  if (blob.size !== intent.source_byte_size || blob.type !== intent.source_content_type) {
    throw new Error(`Excel 사진 정보가 서버의 업로드 대상과 일치하지 않습니다: ${mediaKey}`);
  }
  return blob;
}

async function uploadOne(
  intent: QualityExcelDirectUploadIntent,
  blob: Blob,
  onProgress: (loadedBytes: number) => void,
): Promise<QualityCloudinaryUploadReceipt> {
  const formData = new FormData();
  formData.append('file', blob);
  formData.append('api_key', intent.upload.api_key);
  formData.append('timestamp', String(intent.upload.timestamp));
  formData.append('signature', intent.upload.signature);
  formData.append('public_id', intent.upload.public_id);
  formData.append('allowed_formats', intent.upload.allowed_formats);
  formData.append('upload_preset', intent.upload.upload_preset);
  formData.append('overwrite', 'false');
  formData.append('unique_filename', 'false');

  const response = await axios.post<unknown>(
    `https://api.cloudinary.com/v1_1/${intent.upload.cloud_name}/image/upload`,
    formData,
    {
      timeout: CLOUDINARY_UPLOAD_TIMEOUT_MS,
      onUploadProgress: (event: AxiosProgressEvent) => {
        onProgress(Math.min(event.loaded, blob.size));
      },
    },
  );
  if (response.status < 200 || response.status >= 300) {
    throw new Error('Cloudinary가 사진 저장을 확인하지 않았습니다. 같은 파일로 다시 시도해 주세요.');
  }
  onProgress(blob.size);
  return parseCloudinaryReceipt(response.data, intent);
}

export async function deliverQualityDirectAssets({
  intents,
  media,
  receipts,
  onReceipt,
  confirm,
  onProgress,
}: DeliverQualityDirectAssetsOptions): Promise<void> {
  if (intents.length === 0) {
    onProgress?.({ uploadedBytes: 0, totalBytes: 0, percent: 100 });
    return;
  }

  const totalBytes = intents.reduce((total, intent) => total + intent.source_byte_size, 0);
  const loadedByAsset = new Map(intents.map((intent) => [intent.asset_sha256, 0]));
  const emitProgress = () => {
    const uploadedBytes = [...loadedByAsset.values()].reduce((total, loaded) => total + loaded, 0);
    onProgress?.({
      uploadedBytes,
      totalBytes,
      percent: Math.max(0, Math.min(100, Math.round((uploadedBytes / totalBytes) * 100))),
    });
  };
  emitProgress();

  let nextIndex = 0;
  let firstError: unknown = null;
  const worker = async () => {
    while (firstError == null) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= intents.length) return;
      const intent = intents[index];
      try {
        const savedReceipt = receipts?.get(intent.asset_sha256);
        const receipt = savedReceipt
          ? parseCloudinaryReceipt(savedReceipt, intent)
          : await uploadOne(intent, assertSourceBlob(intent, media), (loadedBytes) => {
            loadedByAsset.set(intent.asset_sha256, loadedBytes);
            emitProgress();
          });
        if (savedReceipt) {
          loadedByAsset.set(intent.asset_sha256, intent.source_byte_size);
          emitProgress();
        } else {
          // Persist the signed Cloudinary receipt before calling Render. If the
          // acknowledgement is interrupted, the browser can safely retry only
          // the completion call after the same workbook is selected again.
          await onReceipt?.(intent, receipt);
        }
        await confirm(intent, receipt);
      } catch (error) {
        firstError ??= error;
      }
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(MAX_CONCURRENT_UPLOADS, intents.length) },
      () => worker(),
    ),
  );
  if (firstError != null) throw firstError;
  emitProgress();
}
