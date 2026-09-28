type PdfPreviewDocument = {
  id: string;
  kind: "work_instruction" | "drawing";
  preview_resource_type: "image" | "raw" | null;
  preview_format: string | null;
  preview_url: string | null;
};

const DRAWING_PREVIEW_LONG_EDGE_PX = 3000;
const DRAWING_ZOOM_LONG_EDGE_PX = 5000;

export function getCloudinaryPdfPageImageUrls(
  document: PdfPreviewDocument | null,
  page: number,
  highDetail: boolean,
  origin: string,
) {
  if (
    document?.preview_resource_type !== "image"
    || document.preview_format !== "pdf"
    || !document.preview_url
  ) return [];

  try {
    const parsed = new URL(document.preview_url, origin);
    if (parsed.hostname !== "res.cloudinary.com") return [];
    const uploadMarker = "/image/upload/";
    const markerIndex = parsed.pathname.indexOf(uploadMarker);
    if (markerIndex < 0) return [];
    const prefix = parsed.pathname.slice(0, markerIndex + uploadMarker.length);
    const originalAssetPath = parsed.pathname.slice(markerIndex + uploadMarker.length);
    const buildUrl = (profile: string, outputFormat: "jpg" | "png") => {
      const next = new URL(parsed.toString());
      const assetPath = originalAssetPath.replace(/\.pdf$/i, `.${outputFormat}`);
      next.pathname = `${prefix}pg_${Math.max(1, page)},${profile}/${assetPath}`;
      next.hash = "";
      return next.toString();
    };

    if (document.kind === "drawing") {
      // A detailed derivative is only fetched when the operator zooms in.
      // Keep the smaller profiles as fallbacks for slower or older devices.
      return [
        ...(highDetail ? [buildUrl(
          `dn_300,w_${DRAWING_ZOOM_LONG_EDGE_PX},h_${DRAWING_ZOOM_LONG_EDGE_PX},dpr_1.0,c_limit,f_png`,
          "png",
        )] : []),
        buildUrl(
          `dn_300,w_${DRAWING_PREVIEW_LONG_EDGE_PX},h_${DRAWING_PREVIEW_LONG_EDGE_PX},dpr_1.0,c_limit,f_png`,
          "png",
        ),
        buildUrl("dn_200,w_2000,h_2000,dpr_1.0,c_limit,q_auto:best,f_jpg", "jpg"),
      ];
    }

    // Work instructions stay lightweight until the operator asks for detail.
    return highDetail
      ? [
        buildUrl("dn_300,w_3200,h_3200,dpr_1.0,c_limit,q_auto:best,f_jpg", "jpg"),
        buildUrl("dn_200,w_2000,h_2000,dpr_1.0,c_limit,q_auto:best,f_jpg", "jpg"),
      ]
      : [buildUrl("dn_200,w_2000,h_2000,dpr_1.0,c_limit,q_auto:best,f_jpg", "jpg")];
  } catch {
    return [];
  }
}

export function getImageCandidateKey(document: PdfPreviewDocument, page: number, highDetail: boolean) {
  return `${document.id}:${document.preview_url ?? ""}:${Math.max(1, page)}:${highDetail ? "detail" : "base"}`;
}
