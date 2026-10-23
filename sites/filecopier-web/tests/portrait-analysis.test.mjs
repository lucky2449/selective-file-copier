import test from "node:test";
import assert from "node:assert/strict";
import {
  canSkipFaceMeasurement,
  planPortraitRegions,
  measurePortraitRegions,
  classifyPortraitFocus,
  readReviewJpegSize,
  PORTRAIT_ALGORITHM_VERSION,
} from "../dist/portrait-analysis.mjs";
const dimensions = { width: 1000, height: 1000 };
const detection = () => ({
  score: 0.9,
  box: { x: 0.2, y: 0.1, width: 0.5, height: 0.5 },
  eyes: [
    { x: 0.35, y: 0.3 },
    { x: 0.55, y: 0.3 },
  ],
});
function pixels(width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    const n = i / 4,
      x = n % width,
      y = Math.floor(n / width),
      v = (Math.floor(x / 8) + Math.floor(y / 8)) % 2 ? 220 : 30;
    data.set([v, v, v, 255], i);
  }
  return { width, height, data };
}
test("native face and eye regions are bounded original pixel rectangles with no upscaling", () => {
  const plan = planPortraitRegions(dimensions, [detection()]);
  assert.equal(plan.route, "portrait");
  assert.equal(plan.faces.length, 1);
  const face = plan.faces[0];
  assert.equal(face.face.width, 500);
  assert.equal(face.eyes[0].width, 140);
  for (const rect of [face.face, ...face.eyes]) {
    assert.ok(rect.x >= 0 && rect.y >= 0);
    assert.ok(rect.x + rect.width <= 1000);
    assert.ok(rect.y + rect.height <= 1000);
    assert.ok(rect.width <= 768);
  }
});
test("overlapping detection tiles deduplicate the same face; different people remain separate", () => {
  const one = detection(),
    duplicate = { ...detection(), score: 0.8 },
    other = {
      score: 0.85,
      box: { x: 0.75, y: 0.2, width: 0.2, height: 0.3 },
      eyes: [
        { x: 0.79, y: 0.3 },
        { x: 0.89, y: 0.3 },
      ],
    };
  assert.equal(
    planPortraitRegions(dimensions, [one, duplicate, other]).faces.length,
    2,
  );
});
test("no detected face uses global fallback but never asserts no person", () => {
  const plan = planPortraitRegions(dimensions, []);
  assert.equal(plan.route, "global");
  assert.match(plan.issues[0], /not_proof_of_absence/);
});
test("uncertain, tiny, malformed, tilted or hidden eyes are withheld, not called clean", () => {
  for (const face of [
    { ...detection(), score: 0.6 },
    { ...detection(), eyes: [] },
    { ...detection(), box: { x: 0.2, y: 0.2, width: 0.1, height: 0.1 } },
    {
      ...detection(),
      eyes: [
        { x: 0.35, y: 0.3 },
        { x: 0.36, y: 0.3 },
      ],
    },
    {
      ...detection(),
      eyes: [
        { x: 0.3, y: 0.2 },
        { x: 0.5, y: 0.5 },
      ],
    },
    { ...detection(), score: NaN },
  ]) {
    const plan = planPortraitRegions(dimensions, [face]);
    assert.equal(plan.route, "inconclusive");
    assert.ok(plan.issues.length);
  }
});
test("unsafe geometry and oversized inputs reject before allocating crops", () => {
  for (const size of [
    { width: Infinity, height: 100 },
    { width: 100000, height: 100000 },
    { width: -1, height: 10 },
  ])
    assert.throws(() => planPortraitRegions(size, []), TypeError);
  assert.throws(
    () => planPortraitRegions(dimensions, Array(257).fill(detection())),
    TypeError,
  );
});
test("three original-sized crops are measured independently; source descriptors unchanged", async () => {
  const face = detection(),
    before = structuredClone(face),
    calls = [];
  const plan = planPortraitRegions(dimensions, [face]);
  const result = await measurePortraitRegions(plan, (rect) => {
    calls.push(rect);
    return pixels(rect.width, rect.height);
  });
  assert.equal(calls.length, 3);
  assert.deepEqual(face, before);
  for (const region of result.faces[0].regions) {
    assert.equal(region.metrics.scales[0].width, region.rect.width);
    assert.equal(region.metrics.scales[0].height, region.rect.height);
  }
  assert.equal(
    classifyPortraitFocus(result).issue,
    "portrait_thresholds_not_calibrated",
  );
});
test("reader cannot silently replace an original-sized crop with an upscaled thumbnail", async () => {
  const plan = planPortraitRegions(dimensions, [detection()]);
  await assert.rejects(
    measurePortraitRegions(plan, () => pixels(64, 64)),
    /Native crop dimensions/,
  );
});
test("cancel aborts before any crop read; failures propagate instead of marking normal", async () => {
  const plan = planPortraitRegions(dimensions, [detection()]);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    measurePortraitRegions(plan, () => assert.fail(), {
      signal: controller.signal,
    }),
    { name: "AbortError" },
  );
  await assert.rejects(
    measurePortraitRegions(plan, () => {
      throw Error("read failure");
    }),
    /read failure/,
  );
});
function score(lap, ten) {
  return {
    status: "measured",
    scales: [{ laplacianVariance: lap, tenengrad: ten }],
  };
}
const profile = {
  algorithmVersion: PORTRAIT_ALGORITHM_VERSION,
  faceLaplacian: 10,
  faceTenengrad: 10,
  eyeLaplacian: 10,
  eyeTenengrad: 10,
};
const result = () => ({
  algorithmVersion: PORTRAIT_ALGORITHM_VERSION,
  route: "portrait",
  issues: [],
  faces: [
    {
      regions: ["face", "eye_0", "eye_1"].map((kind) => ({
        kind,
        metrics: score(1, 1),
      })),
    },
  ],
});
test("a sharp eye vetoes portrait softness even if skin/other eye are smooth", () => {
  const input = result();
  assert.deepEqual(classifyPortraitFocus(input, profile).reasons, [
    "portrait_focus",
  ]);
  input.faces[0].regions[2].metrics = score(30, 30);
  assert.equal(classifyPortraitFocus(input, profile).verdict, "no_signal");
});
test("incomplete face evidence, low texture or duplicate eye measurements are inconclusive", () => {
  const input = result();
  input.faces[0].regions[1].metrics = { status: "inconclusive" };
  assert.equal(classifyPortraitFocus(input, profile).verdict, "inconclusive");
  const duplicate = result();
  duplicate.faces[0].regions[2].kind = "eye_0";
  assert.equal(
    classifyPortraitFocus(duplicate, profile).verdict,
    "inconclusive",
  );
  const uncertain = result();
  uncertain.issues = ["face_limit"];
  assert.equal(
    classifyPortraitFocus(uncertain, profile).verdict,
    "inconclusive",
  );
  assert.throws(
    () => classifyPortraitFocus(result(), { ...profile, eyeLaplacian: NaN }),
    TypeError,
  );
});
function jpeg(width, height) {
  return Uint8Array.from([
    255,
    216,
    255,
    224,
    0,
    4,
    0,
    0,
    255,
    192,
    0,
    11,
    8,
    height >> 8,
    height & 255,
    width >> 8,
    width & 255,
    1,
    1,
    17,
    0,
    255,
    217,
  ]);
}
test("JPEG dimensions are read before decode with compressed file/header safety checks", () => {
  assert.deepEqual(readReviewJpegSize(jpeg(6000, 4000)), {
    width: 6000,
    height: 4000,
  });
  for (const bytes of [
    new Uint8Array(),
    Uint8Array.from([137, 80, 78, 71]),
    jpeg(0, 1),
    jpeg(65535, 65535),
    jpeg(6000, 4000).slice(0, 12),
  ])
    assert.throws(() => readReviewJpegSize(bytes));
});

test("cascade skips only the large face crop after two strong native eye measurements", async () => {
  const plan = planPortraitRegions(dimensions, [detection()]);
  const calls = [];
  const staged = await measurePortraitRegions(
    plan,
    (rect) => {
      calls.push(rect);
      return pixels(rect.width, rect.height);
    },
    { profile, cascade: true },
  );
  const full = await measurePortraitRegions(plan, (rect) =>
    pixels(rect.width, rect.height),
  );
  assert.equal(calls.length, 2);
  assert.equal(staged.faces[0].faceSkipped, "sharp_native_eyes");
  assert.deepEqual(
    classifyPortraitFocus(staged, profile),
    classifyPortraitFocus(full, profile),
  );
  assert.ok(calls.every((rect) => rect.width === 140));
});
test("uncalibrated, uncertain, low-texture and weak-eye photos retain full measurement", async () => {
  const plan = planPortraitRegions(dimensions, [detection()]);
  for (const options of [
    { cascade: true },
    { cascade: true, profile: { ...profile, eyeLaplacian: 1e9 } },
    { cascade: true, profile },
  ]) {
    let calls = 0;
    await measurePortraitRegions(
      plan,
      (rect) => {
        calls++;
        const input = pixels(rect.width, rect.height);
        if (options.profile === profile) {
          input.data.fill(128);
          for (let i = 3; i < input.data.length; i += 4) input.data[i] = 255;
        }
        return input;
      },
      options,
    );
    assert.equal(calls, 3);
  }
  const uncertain = { ...plan, issues: ["uncertain_face_detection"] };
  let calls = 0;
  await measurePortraitRegions(
    uncertain,
    (rect) => {
      calls++;
      return pixels(rect.width, rect.height);
    },
    { cascade: true, profile },
  );
  assert.equal(calls, 3);
});
test("cascade requires both distinct eyes, valid metrics and calibrated thresholds", () => {
  const eyes = ["eye_0", "eye_1"].map((kind) => ({
    kind,
    metrics: score(30, 30),
  }));
  assert.equal(canSkipFaceMeasurement(eyes, profile), true);
  for (const input of [
    eyes.slice(0, 1),
    [eyes[0], eyes[0]],
    [eyes[0], { kind: "eye_1", metrics: score(1, 1) }],
    [eyes[0], { kind: "eye_1", metrics: score(Infinity, 30) }],
  ])
    assert.equal(canSkipFaceMeasurement(input, profile), false);
  assert.equal(canSkipFaceMeasurement(eyes), false);
  const forged = result();
  forged.faces[0] = {
    faceSkipped: "sharp_native_eyes",
    regions: eyes.slice(0, 1),
  };
  assert.equal(classifyPortraitFocus(forged, profile).verdict, "inconclusive");
});

test("optional ratio profile separates low contrast from high frequency loss without changing defaults", () => {
  const calibrated = {
    algorithmVersion: PORTRAIT_ALGORITHM_VERSION,
    scoreMode: "frequency-ratio-v1",
    faceRatio: 0.3,
    eyeRatio: 0.3,
  };
  const sharp = result();
  sharp.faces[0].regions.forEach((r) => (r.metrics = score(2, 4)));
  const soft = result();
  soft.faces[0].regions.forEach((r) => (r.metrics = score(3, 20)));
  assert.equal(classifyPortraitFocus(sharp, calibrated).verdict, "no_signal");
  assert.equal(
    classifyPortraitFocus(soft, calibrated).verdict,
    "portrait_focus_suspected",
  );
  assert.equal(classifyPortraitFocus(soft).verdict, "inconclusive");
  sharp.faces[0].regions.forEach((r) => (r.metrics = score(0, 0)));
  assert.equal(
    classifyPortraitFocus(sharp, calibrated).verdict,
    "inconclusive",
  );
  assert.throws(
    () => classifyPortraitFocus(soft, { ...calibrated, eyeRatio: NaN }),
    TypeError,
  );
  assert.throws(
    () => classifyPortraitFocus(soft, { ...profile, scoreMode: "unknown" }),
    TypeError,
  );
});
test("ratio cascade only skips when both eyes exceed calibrated margin", () => {
  const calibrated = {
    algorithmVersion: PORTRAIT_ALGORITHM_VERSION,
    scoreMode: "frequency-ratio-v1",
    faceRatio: 0.3,
    eyeRatio: 0.3,
  };
  const eyes = ["eye_0", "eye_1"].map((kind) => ({
    kind,
    metrics: score(3, 4),
  }));
  assert.equal(canSkipFaceMeasurement(eyes, calibrated), true);
  eyes[1].metrics = score(1, 4);
  assert.equal(canSkipFaceMeasurement(eyes, calibrated), false);
});

test("held-out measurement regression: strong blur vs reference; uncertain detection never becomes normal", () => {
  const calibrated = {
    algorithmVersion: PORTRAIT_ALGORITHM_VERSION,
    scoreMode: "frequency-ratio-v1",
    faceRatio: 0.2622575908062492,
    eyeRatio: 0.30948448527460154,
  };
  const measured = (values, issues = []) => ({
    ...result(),
    issues,
    faces: [
      {
        regions: ["eye_0", "eye_1", "face"].map((kind, i) => ({
          kind,
          metrics: score(...values[i]),
        })),
      },
    ],
  });
  for (const values of [
    [
      [4, 20.1],
      [2.9, 16.2],
      [2.8, 13.1],
    ],
    [
      [1.7, 12],
      [2.7, 18.5],
      [1.2, 7.3],
    ],
    [
      [2.2, 17.6],
      [1.6, 12.5],
      [1.3, 9],
    ],
  ])
    assert.equal(
      classifyPortraitFocus(measured(values), calibrated).verdict,
      "portrait_focus_suspected",
    );
  assert.equal(
    classifyPortraitFocus(
      measured([
        [2, 4.5],
        [2.4, 5.6],
        [1.1, 2.9],
      ]),
      calibrated,
    ).verdict,
    "no_signal",
  );
  assert.equal(
    classifyPortraitFocus(
      measured(
        [
          [0.9, 6.4],
          [1.4, 8.8],
          [0.8, 6.1],
        ],
        ["uncertain_face_detection"],
      ),
      calibrated,
    ).verdict,
    "inconclusive",
  );
});

test("noise-corrected classification requires verified eyes and matching preprocessing",()=>{
 const p={algorithmVersion:PORTRAIT_ALGORITHM_VERSION,scoreMode:"denoised-ratio-v1",faceRatio:.3,eyeRatio:.3};
 const input=result();
 assert.equal(classifyPortraitFocus(input,p).verdict,"inconclusive");
 input.faces[0].eyesRefined=true;
 assert.equal(classifyPortraitFocus(input,p).verdict,"inconclusive");
 for(const region of input.faces[0].regions)region.metrics.noiseCorrection={version:"eyelid-median-v2",corrected:score(2,20)};
 assert.equal(classifyPortraitFocus(input,p).verdict,"portrait_focus_suspected");
 input.faces[0].regions[1].metrics.noiseCorrection.version="other";
 assert.equal(classifyPortraitFocus(input,p).verdict,"inconclusive");
});
