import { assessDetailEvidence } from "./detail-evidence.mjs?v=spatial-2";
import {
  planFaceRetry,
  mapRetryDetection,
  planImageFallback,
  decideImageFallback,
  resolveReviewDecision,
} from "./face-retry.mjs?v=retry-1";
import {
  measureFaceMotion,
  classifyFaceMotion,
} from "./face-motion.mjs?v=spatial-detail-3";
import {
  refineEyeContours,
  medianDenoise,
  planFaceMotionCrops,
} from "./portrait-refinement.mjs?v=eye-noise-2";
import {
  FilesetResolver,
  FaceDetector,
  FaceLandmarker,
} from "./vendor/mediapipe-face-1.1.1/vision_bundle.mjs";
import {
  readReviewJpegSize,
  planPortraitRegions,
  measurePortraitRegions,
  classifyPortraitFocus,
  MAX_REVIEW_JPEG_BYTES,
} from "./portrait-analysis.mjs?v=spatial-detail-12";
import {
  analyzeBlurPixels,
  classifyMotionEvidence,
} from "./blur-analysis.mjs?v=portrait-1";

// Requests run sequentially. Keep only the detector between files; release image buffers.
// Cancellation, failure or disposal terminates this worker from the main thread.
let detector, landmarker;
self.onmessage = async ({ data: { file, profile, motionProfile } }) => {
  let bitmap, canvas;
  let stage = "jpeg";
  try {
    if (
      !(file instanceof Blob) ||
      file.size <= 0 ||
      file.size > MAX_REVIEW_JPEG_BYTES
    )
      throw Error();
    const dimensions = readReviewJpegSize(
      new Uint8Array(await file.slice(0, 512 * 1024).arrayBuffer()),
    );
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    if (bitmap.width * bitmap.height !== dimensions.width * dimensions.height)
      throw Error();
    if (typeof OffscreenCanvas !== "function") throw Error();
    stage = "model";
    const base = new URL("./vendor/mediapipe-face-1.1.1/", import.meta.url);
    detector ??= await FaceDetector.createFromOptions(
      await FilesetResolver.forVisionTasks(new URL("wasm", base).href, true),
      {
        baseOptions: {
          modelAssetPath: new URL("face_detector.tflite", base).href,
          delegate: "CPU",
        },
        runningMode: "IMAGE",
        minDetectionConfidence: 0.5,
        minSuppressionThreshold: 0.3,
      },
    );
    const width = bitmap.width,
      height = bitmap.height,
      detections = [];
    canvas = new OffscreenCanvas(512, 512);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw Error();
    stage = "detection";
    const views = [{ x: 0, y: 0, width, height }];
    // Overlapping half-size tiles enlarge small faces for this short-range detector.
    for (const y of [0, 0.25, 0.5])
      for (const x of [0, 0.25, 0.5])
        views.push({
          x: Math.floor(width * x),
          y: Math.floor(height * y),
          width: Math.floor(width / 2),
          height: Math.floor(height / 2),
        });
    for (const view of views) {
      const ratio = Math.min(512 / view.width, 512 / view.height);
      canvas.width = Math.max(1, Math.floor(view.width * ratio));
      canvas.height = Math.max(1, Math.floor(view.height * ratio));
      ctx.drawImage(
        bitmap,
        view.x,
        view.y,
        view.width,
        view.height,
        0,
        0,
        canvas.width,
        canvas.height,
      );
      const found = detector.detect(canvas).detections;
      for (const face of found) {
        const box = face.boundingBox;
        if (!box) continue;
        detections.push({
          score: face.categories?.[0]?.score ?? 0,
          box: {
            x: (view.x + (box.originX / canvas.width) * view.width) / width,
            y: (view.y + (box.originY / canvas.height) * view.height) / height,
            width: ((box.width / canvas.width) * view.width) / width,
            height: ((box.height / canvas.height) * view.height) / height,
          },
          eyes: (face.keypoints ?? []).slice(0, 2).map((p) => ({
            x: (view.x + p.x * view.width) / width,
            y: (view.y + p.y * view.height) / height,
          })),
        });
      }
    }
    let retryAttempts = 0;
    if (!planFaceMotionCrops({ width, height }, detections).length) {
      stage = "face-retry";
      for (const frame of planFaceRetry({ width, height }, detections)) {
        retryAttempts++;
        canvas.width = 512;
        canvas.height = 512;
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, 512, 512);
        ctx.translate(256, 256);
        ctx.rotate(-frame.angle);
        ctx.drawImage(
          bitmap,
          frame.cx - frame.side / 2,
          frame.cy - frame.side / 2,
          frame.side,
          frame.side,
          -256,
          -256,
          512,
          512,
        );
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        for (const face of detector.detect(canvas).detections) {
          const b = face.boundingBox;
          if (!b) continue;
          const mapped = mapRetryDetection(
            {
              score: face.categories?.[0]?.score ?? 0,
              box: {
                x: b.originX / 512,
                y: b.originY / 512,
                width: b.width / 512,
                height: b.height / 512,
              },
              eyes: (face.keypoints ?? []).slice(0, 2),
            },
            frame,
            { width, height },
          );
          if (mapped && detections.length < 256) detections.push(mapped);
        }
        if (planFaceMotionCrops({ width, height }, detections).length) break;
      }
    }
    // Refine each non-overlapping confident face before trusting eye positions.
    stage = "eye-refinement";
    const seeds = [],
      invalidSeeds = [];
    for (const detection of [...detections].sort((a, b) => b.score - a.score)) {
      const b = detection.box;
      if (
        ![b.x, b.y, b.width, b.height].every(Number.isFinite) ||
        b.x < 0 ||
        b.y < 0 ||
        b.width <= 0 ||
        b.height <= 0 ||
        b.x + b.width > 1.001 ||
        b.y + b.height > 1.001
      ) {
        invalidSeeds.push(detection);
        continue;
      }
      const duplicate = seeds.some((other) => {
        const a = other.box,
          intersection =
            Math.max(
              0,
              Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
            ) *
            Math.max(
              0,
              Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
            );
        return (
          intersection /
            (a.width * a.height + b.width * b.height - intersection) >
          0.35
        );
      });
      if (!duplicate) seeds.push(detection);
    }
    let refinedCount = 0;
    for (let i = 0; i < seeds.length; i++) {
      const seed = seeds[i];
      if (seed.score < 0.7 || refinedCount >= 12) continue;
      refinedCount++;
      stage = "landmark-model";
      // Tasks Vision clears its global factory after each task. ESM imports are
      // cached, so restore the official exported factory for this second task.
      if (!landmarker)
        self.ModuleFactory = (
          await import(
            "./vendor/mediapipe-face-1.1.1/wasm/vision_wasm_module_internal.js"
          )
        ).default;
      landmarker ??= await FaceLandmarker.createFromOptions(
        await FilesetResolver.forVisionTasks(new URL("wasm", base).href, true),
        {
          baseOptions: {
            modelAssetPath: new URL("face_landmarker.task", base).href,
            delegate: "CPU",
          },
          runningMode: "IMAGE",
          numFaces: 1,
          minFaceDetectionConfidence: 0.6,
          minFacePresenceConfidence: 0.7,
          outputFaceBlendshapes: false,
          outputFacialTransformationMatrixes: false,
        },
      );
      const box = seed.box,
        cx = (box.x + box.width / 2) * width,
        cy = (box.y + box.height / 2) * height,
        side = Math.max(box.width * width, box.height * height) * 1.6;
      let angle = 0;
      if (seed.eyes.length === 2)
        angle = Math.atan2(
          (seed.eyes[1].y - seed.eyes[0].y) * height,
          (seed.eyes[1].x - seed.eyes[0].x) * width,
        );
      if (angle > Math.PI / 2) angle -= Math.PI;
      if (angle < -Math.PI / 2) angle += Math.PI;
      canvas.width = 512;
      canvas.height = 512;
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, 512, 512);
      ctx.translate(256, 256);
      ctx.rotate(-angle);
      ctx.drawImage(
        bitmap,
        cx - side / 2,
        cy - side / 2,
        side,
        side,
        -256,
        -256,
        512,
        512,
      );
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      stage = "landmark-detection";
      const meshes = landmarker.detect(canvas).faceLandmarks;
      let refined = null;
      stage = "landmark-mapping";
      if (meshes.length === 1) {
        const toOriginal = (p) => {
          const x = (p.x - 0.5) * side,
            y = (p.y - 0.5) * side;
          return {
            x: (cx + Math.cos(angle) * x - Math.sin(angle) * y) / width,
            y: (cy + Math.sin(angle) * x + Math.cos(angle) * y) / height,
          };
        };
        const contours = [
          FaceLandmarker.FACE_LANDMARKS_LEFT_EYE,
          FaceLandmarker.FACE_LANDMARKS_RIGHT_EYE,
        ].map((connections) =>
          [...new Set(connections.flatMap((c) => [c.start, c.end]))].map(
            (index) => toOriginal(meshes[0][index]),
          ),
        );
        refined = refineEyeContours(seed, contours, { width, height });
      }
      seeds[i] = refined ?? { ...seed, eyesRefined: false };
    }
    const plan = planPortraitRegions({ width, height }, [
      ...seeds,
      ...invalidSeeds,
    ]);
    stage = "measurement";
    let result;
    if (plan.route === "global") {
      const ratio = Math.min(1, 768 / Math.max(width, height));
      canvas.width = Math.floor(width * ratio);
      canvas.height = Math.floor(height * ratio);
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const metrics = analyzeBlurPixels(
        ctx.getImageData(0, 0, canvas.width, canvas.height),
      );
      result = {
        algorithmVersion: "native-face-eyes-v1",
        route: "global",
        issues: plan.issues,
        faces: [],
        global: metrics,
        decision: classifyMotionEvidence(metrics),
      };
    } else {
      result = await measurePortraitRegions(
        plan,
        (rect) => {
          canvas.width = rect.width;
          canvas.height = rect.height;
          ctx.drawImage(
            bitmap,
            rect.x,
            rect.y,
            rect.width,
            rect.height,
            0,
            0,
            rect.width,
            rect.height,
          );
          return ctx.getImageData(0, 0, rect.width, rect.height);
        },
        { profile, cascade: true, includeMotion: true },
      );
      result.decision = classifyPortraitFocus(result, profile);
    }
    stage = "face-motion";
    result.faceMotion = [];
    for (const candidate of planFaceMotionCrops({ width, height }, seeds)) {
      const rect = candidate.rect,
        key = JSON.stringify(rect);
      const existing = result.faces
        .flatMap((f) => f.regions)
        .find((r) => r.kind === "face" && JSON.stringify(r.rect) === key)
        ?.metrics.faceMotion;
      let evidence = existing;
      if (!evidence) {
        canvas.width = rect.width;
        canvas.height = rect.height;
        ctx.drawImage(
          bitmap,
          rect.x,
          rect.y,
          rect.width,
          rect.height,
          0,
          0,
          rect.width,
          rect.height,
        );
        const pixels = ctx.getImageData(0, 0, rect.width, rect.height);
        evidence = measureFaceMotion(medianDenoise(pixels).image);
      }
      result.faceMotion.push({
        ...candidate,
        evidence,
        decision: classifyFaceMotion(evidence, motionProfile),
        assessment: assessDetailEvidence(evidence),
      });
    }
    const motionSuspect = result.faceMotion.find(
      (f) => f.decision.verdict === "motion_suspected",
    );
    if (motionSuspect) result.decision = motionSuspect.decision;
    result.retry = {
      attempts: retryAttempts,
      recovered: retryAttempts > 0 && result.faceMotion.length > 0,
    };
    if (!result.faceMotion.length) {
      stage = "image-regions";
      result.imageFallback = {
        scope: "image_regions_not_confirmed_person",
        regions: [],
      };
      for (const rect of planImageFallback({ width, height })) {
        const scale = Math.min(1, 768 / Math.max(rect.width, rect.height));
        canvas.width = Math.max(1, Math.floor(rect.width * scale));
        canvas.height = Math.max(1, Math.floor(rect.height * scale));
        ctx.drawImage(
          bitmap,
          rect.x,
          rect.y,
          rect.width,
          rect.height,
          0,
          0,
          canvas.width,
          canvas.height,
        );
        const decision = classifyMotionEvidence(
          analyzeBlurPixels(
            ctx.getImageData(0, 0, canvas.width, canvas.height),
          ),
        );
        // Native center sample avoids declaring fine detail from a resized overview.
        const native = {
          x: rect.x + Math.max(0, Math.floor((rect.width - 768) / 2)),
          y: rect.y + Math.max(0, Math.floor((rect.height - 768) / 2)),
          width: Math.min(768, rect.width),
          height: Math.min(768, rect.height),
        };
        canvas.width = native.width;
        canvas.height = native.height;
        ctx.drawImage(
          bitmap,
          native.x,
          native.y,
          native.width,
          native.height,
          0,
          0,
          native.width,
          native.height,
        );
        const assessment = assessDetailEvidence(
          measureFaceMotion(
            medianDenoise(ctx.getImageData(0, 0, native.width, native.height))
              .image,
          ),
        );
        result.imageFallback.regions.push({
          rect,
          decision,
          assessment,
          nativeRect: native,
        });
      }
      result.decision = decideImageFallback(result.imageFallback.regions);
    }
    result.decision = resolveReviewDecision(result.decision, result.faceMotion);
    result.assessment = {
      completed: true,
      sufficient: result.decision.verdict !== "inconclusive",
      scope: result.imageFallback ? "sampled_image_regions" : "detected_faces",
      issue:
        result.decision.verdict === "inconclusive"
          ? "insufficient_or_unconfirmed_detail"
          : null,
    };
    result.sourceDimensions = { width, height };
    self.postMessage({ result });
  } catch {
    self.postMessage({ error: `Photo review failed (${stage})` });
  } finally {
    bitmap?.close();
    if (canvas) {
      canvas.width = 1;
      canvas.height = 1;
    }
  }
};

