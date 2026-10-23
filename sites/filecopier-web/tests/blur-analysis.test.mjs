import test from "node:test";
import assert from "node:assert/strict";
import { analyzeBlurPixels, classifyBlur, BLUR_ALGORITHM_VERSION, MAX_BLUR_INPUT_PIXELS } from "../dist/blur-analysis.mjs";

function image(width = 192, height = 192, sample = (x, y) => (Math.floor(x / 8) + Math.floor(y / 8)) % 2 ? 220 : 35) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4, value = sample(x, y);
    data.set([value, value, value, 255], i);
  }
  return { width, height, data };
}
function blur(input, radius, horizontalOnly = false) {
  const { width, height, data } = input;
  return image(width, height, (x, y) => {
    let sum = 0, count = 0;
    for (let dy = horizontalOnly ? 0 : -radius; dy <= (horizontalOnly ? 0 : radius); dy++) for (let dx = -radius; dx <= radius; dx++) {
      const sx = Math.max(0, Math.min(width - 1, x + dx)), sy = Math.max(0, Math.min(height - 1, y + dy));
      sum += data[(sy * width + sx) * 4]; count++;
    }
    return sum / count;
  });
}
function testProfile(limits) { return { algorithmVersion: BLUR_ALGORITHM_VERSION, maxEdge: 768, limits }; }

test("controlled defocus progressively reduces both metrics at both scales", () => {
  const source = image();
  const levels = [source, blur(source, 1), blur(source, 3)].map(i => analyzeBlurPixels(i));
  for (let scale = 0; scale < 2; scale++) for (const key of ["laplacianVariance", "tenengrad"]) {
    assert.ok(levels[0].scales[scale][key] > levels[1].scales[scale][key], key);
    assert.ok(levels[1].scales[scale][key] > levels[2].scales[scale][key], key);
  }
});
test("controlled directional smear lowers sharpness without claiming motion cause", () => {
  const original = image(), a = analyzeBlurPixels(original), b = analyzeBlurPixels(blur(original, 5, true));
  assert.ok(b.scales[0].laplacianVariance < a.scales[0].laplacianVariance);
  assert.ok(b.scales[0].tenengrad < a.scales[0].tenengrad);
  assert.equal(Object.hasOwn(b, "motionDirection"), false);
});
test("pure analysis preserves source bytes, dimensions and returns no private photo metadata", () => {
  const input = image(); input.name = "private.jpg"; input.path = "private/folder";
  const before = new Uint8Array(input.data);
  const result = analyzeBlurPixels(input);
  assert.deepEqual(input.data, new Uint8ClampedArray(before));
  assert.equal(input.width, 192);
  assert.ok(!JSON.stringify(result).includes("private"));
  assert.equal(result.scales[0].regions.length, 9);
});
test("constant, very dark and very bright frames are inconclusive, never called clean", () => {
  for (const level of [0, 4, 128, 252, 255]) {
    const metrics = analyzeBlurPixels(image(128, 128, () => level));
    assert.equal(metrics.status, "inconclusive");
    assert.ok(metrics.issues.includes("low_texture_or_contrast"));
    assert.equal(classifyBlur(metrics, testProfile([{laplacianVariance:1,tenengrad:1},{laplacianVariance:1,tenengrad:1}])).verdict, "inconclusive");
    assert.equal(metrics.scales[0].laplacianVariance, 0);
  }
});
test("small images and thin panoramas do not upscale or produce false successful analysis", () => {
  for (const input of [image(32, 32), image(1000, 64)]) {
    const result = analyzeBlurPixels(input, { maxEdge: 128 });
    assert.deepEqual(result.issues, ["insufficient_resolution"]);
    assert.equal(result.scales.length, 0);
  }
});
test("bounded reduction preserves aspect ratio and does not upscale", () => {
  const reduced = analyzeBlurPixels(image(1000, 500), { maxEdge: 256 });
  assert.equal(reduced.scales[0].width, 256); assert.equal(reduced.scales[0].height, 128);
  const small = analyzeBlurPixels(image(128, 80));
  assert.equal(small.scales[0].width, 128); assert.equal(small.scales[0].height, 80);
});
test("invalid dimensions, byte lengths, types, alpha and pixel budget fail before large allocations", () => {
  for (const input of [null, {width:NaN,height:2}, {width:-2,height:2}, {width:1.5,height:2}, {width:128,height:128,data:[]}, {width:128,height:128,data:new Uint8Array(3)}])
    assert.throws(() => analyzeBlurPixels(input), TypeError);
  assert.throws(() => analyzeBlurPixels({width:MAX_BLUR_INPUT_PIXELS+1,height:1,data:new Uint8Array(0)}), RangeError);
  const transparent = image(); transparent.data[3] = 0;
  assert.throws(() => analyzeBlurPixels(transparent), /Opaque/);
  for (const maxEdge of [0, 64, 1025, Infinity, 128.5]) assert.throws(() => analyzeBlurPixels(image(), {maxEdge}), TypeError);
});
test("already aborted request stops before processing pixels", () => {
  const controller = new AbortController(); controller.abort();
  assert.throws(() => analyzeBlurPixels(image(), {signal:controller.signal}), {name:"AbortError"});
});
test("Uint8Array and Uint8ClampedArray yield deterministic identical metrics", () => {
  const original = image();
  const a = analyzeBlurPixels(original);
  assert.deepEqual(analyzeBlurPixels({...original,data:new Uint8Array(original.data)}), a);
  assert.deepEqual(analyzeBlurPixels(original), a);
});
test("rotation of square fixture preserves global sharpness within floating point tolerance", () => {
  const original = image(), rotated = image(192,192,(x,y)=>original.data[((191-x)*192+y)*4]);
  const a=analyzeBlurPixels(original), b=analyzeBlurPixels(rotated);
  for(let i=0;i<2;i++) for(const key of ["laplacianVariance","tenengrad"])
    assert.ok(Math.abs(a.scales[i][key]-b.scales[i][key])<0.001);
});
test("without calibrated thresholds algorithm only measures and never emits blur reason", () => {
  const result=classifyBlur(analyzeBlurPixels(image()));
  assert.deepEqual(result,{verdict:"inconclusive",reasons:[],issue:"uncalibrated"});
});
test("low sharpness alone never extracts isotropic defocus as motion", () => {
  const source=image(), sharp=analyzeBlurPixels(source), blurred=analyzeBlurPixels(blur(source,5));
  const limits=sharp.scales.map((scale,i)=>({
    laplacianVariance:(Math.min(...scale.regions.map(r=>r.laplacianVariance))+Math.max(...blurred.scales[i].regions.map(r=>r.laplacianVariance)))/2,
    tenengrad:(Math.min(...scale.regions.map(r=>r.tenengrad))+Math.max(...blurred.scales[i].regions.map(r=>r.tenengrad)))/2,
  }));
  const profile=testProfile(limits);
  assert.equal(classifyBlur(sharp,profile).verdict,"no_signal");
  assert.deepEqual(classifyBlur(blurred,profile).reasons,[]);
  assert.notEqual(classifyBlur(blurred,profile).verdict,"motion_suspected");
});
test("a sharp local region vetoes background-only blur, even with low global scores", () => {
  const scale={laplacianVariance:1,tenengrad:1,regions:[{laplacianVariance:1,tenengrad:1},{laplacianVariance:100,tenengrad:100}]};
  const metrics={algorithmVersion:BLUR_ALGORITHM_VERSION,maxEdge:768,status:"measured",scales:[scale,scale]};
  assert.equal(classifyBlur(metrics,testProfile([{laplacianVariance:10,tenengrad:10},{laplacianVariance:10,tenengrad:10}])).verdict,"no_signal");
});
test("incompatible profiles reject, malformed metric values cannot look clean", () => {
  const metrics=analyzeBlurPixels(image());
  for(const profile of [{}, {...testProfile([])}, {algorithmVersion:"old",maxEdge:768,limits:[{},{}]}, testProfile([{laplacianVariance:-1,tenengrad:10},{laplacianVariance:10,tenengrad:10}])])
    assert.throws(()=>classifyBlur(metrics,profile),TypeError);
  const profile=testProfile([{laplacianVariance:10,tenengrad:10},{laplacianVariance:10,tenengrad:10}]);
  metrics.scales[0].tenengrad=NaN;
  assert.equal(classifyBlur(metrics,profile).issue,"invalid_metrics");
});
