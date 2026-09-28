import assert from "node:assert/strict";
import test from "node:test";

import {
  getCloudinaryPdfPageImageUrls,
  getImageCandidateKey,
} from "../src/pages/field/documentPreviewUrls.ts";

const origin = "https://wj-reporting.onrender.com";
const previewUrl = "https://res.cloudinary.com/example/image/upload/v1/drawing.pdf";
const drawing = {
  id: "drawing-1",
  kind: "drawing" as const,
  preview_resource_type: "image" as const,
  preview_format: "pdf",
  preview_url: previewUrl,
};

test("drawing pages request more source pixels after zoom, with smaller fallbacks", () => {
  const normal = getCloudinaryPdfPageImageUrls(drawing, 7, false, origin);
  const zoomed = getCloudinaryPdfPageImageUrls(drawing, 7, true, origin);

  assert.equal(normal.length, 2);
  assert.match(normal[0], /\/pg_7,dn_300,w_3000,h_3000,dpr_1\.0,c_limit,f_png\/v1\/drawing\.png$/);
  assert.match(normal[1], /\/pg_7,dn_200,w_2000,h_2000,dpr_1\.0,c_limit,q_auto:best,f_jpg\/v1\/drawing\.jpg$/);
  assert.equal(zoomed.length, 3);
  assert.match(zoomed[0], /\/pg_7,dn_300,w_5000,h_5000,dpr_1\.0,c_limit,f_png\/v1\/drawing\.png$/);
  assert.deepEqual(zoomed.slice(1), normal);
});

test("image failure fallback is reset for a new page or detail level", () => {
  assert.notEqual(getImageCandidateKey(drawing, 1, false), getImageCandidateKey(drawing, 2, false));
  assert.notEqual(getImageCandidateKey(drawing, 1, false), getImageCandidateKey(drawing, 1, true));
});

test("non-Cloudinary or raw PDFs do not request Cloudinary page images", () => {
  assert.deepEqual(getCloudinaryPdfPageImageUrls({ ...drawing, preview_url: "/other/drawing.pdf" }, 1, true, origin), []);
  assert.deepEqual(getCloudinaryPdfPageImageUrls({ ...drawing, preview_resource_type: "raw" }, 1, true, origin), []);
});

test("work instructions retain their existing lightweight and detail profiles", () => {
  const instruction = { ...drawing, kind: "work_instruction" as const };
  const normal = getCloudinaryPdfPageImageUrls(instruction, 2, false, origin);
  const zoomed = getCloudinaryPdfPageImageUrls(instruction, 2, true, origin);
  assert.equal(normal.length, 1);
  assert.match(normal[0], /\/pg_2,dn_200,w_2000,h_2000/);
  assert.equal(zoomed.length, 2);
  assert.match(zoomed[0], /\/pg_2,dn_300,w_3200,h_3200/);
  assert.equal(zoomed[1], normal[0]);
});
