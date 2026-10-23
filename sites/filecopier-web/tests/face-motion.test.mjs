import test from "node:test";
import assert from "node:assert/strict";
import {
  measureFaceMotion,
  classifyFaceMotion,
  FACE_MOTION_VERSION,
} from "../dist/face-motion.mjs";
const profile = {
  version: FACE_MOTION_VERSION,
  minEdges: 4,
  minRegions: 2,
  minGhosts: 2,
  widths: [4, 2],
  ratio: 1.4,
  ghostRate: 0.2,
  maxLaplacian: 10,
  maxTenengrad: 100,
};
function fixture(ghost = false) {
  const width = 256,
    height = 256,
    data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const value = (dx) =>
        (Math.floor((x + dx) / 32) + Math.floor(y / 32)) % 2 ? 220 : 30;
      const v = ghost ? (value(0) + value(6)) / 2 : value(0);
      data.set([v, v, v, 255], (y * width + x) * 4);
    }
  return { width, height, data };
}
test("native repeated edge profiles increase ghost evidence without changing pixels", () => {
  const a = fixture(),
    b = fixture(true),
    before = b.data.slice(),
    sharp = measureFaceMotion(a),
    ghost = measureFaceMotion(b);
  assert.deepEqual(b.data, before);
  assert.equal(ghost.scales.length, 2);
  assert.ok(
    ghost.scales[0].bins.reduce((sum, b) => sum + b.ghosts, 0) >
      sharp.scales[0].bins.reduce((sum, b) => sum + b.ghosts, 0),
  );
});
function evidence() {
  return {
    version: FACE_MOTION_VERSION,
    scales: [0, 1].map(() => ({
      detail: { laplacianVariance: 1, tenengrad: 1 },
      bins: Array.from({ length: 8 }, () => ({
        edges: 10,
        medianWidth: 2,
        wideEdges: 0,
        ghosts: 0,
        regions: [0, 1, 2],
        ghostRegions: [],
      })),
    })),
  };
}
test("directional spread requires agreement at both scales; lack of evidence stays inconclusive", () => {
  const e = evidence();
  e.scales.forEach((s, i) => (s.bins[0].medianWidth = i ? 3 : 6));
  assert.equal(classifyFaceMotion(e, profile).verdict, "motion_suspected");
  e.scales[1].bins[0].medianWidth = 1;
  assert.equal(classifyFaceMotion(e, profile).verdict, "no_signal");
  assert.equal(
    classifyFaceMotion({ version: FACE_MOTION_VERSION, scales: [] }, profile)
      .verdict,
    "inconclusive",
  );
  assert.equal(classifyFaceMotion(e).verdict, "inconclusive");
});
test("repeated peaks need independent regions and two scales", () => {
  const e = evidence();
  for (const s of e.scales) {
    s.bins[2].ghosts = 5;
    s.bins[2].ghostRegions = [0, 1];
  }
  assert.equal(classifyFaceMotion(e, profile).evidence, "repeated_edge_peaks");
  e.scales[1].bins[2].ghostRegions = [0];
  assert.equal(classifyFaceMotion(e, profile).verdict, "no_signal");
});
test("face analysis validates size/opacity and cancellation", () => {
  const controller = new AbortController();
  controller.abort();
  assert.throws(
    () => measureFaceMotion(fixture(), { signal: controller.signal }),
    { name: "AbortError" },
  );
  assert.throws(
    () =>
      measureFaceMotion({
        width: 10000,
        height: 10000,
        data: new Uint8Array(4),
      }),
    TypeError,
  );
  const image = fixture();
  image.data[3] = 0;
  assert.throws(() => measureFaceMotion(image), TypeError);
  assert.throws(
    () => classifyFaceMotion(evidence(), { ...profile, ratio: NaN }),
    TypeError,
  );
});

test("invalid evidence never becomes a clean result; different patches do not corroborate", () => {
  const e = evidence();
  e.scales[0].bins[0].medianWidth = NaN;
  assert.equal(classifyFaceMotion(e, profile).verdict, "inconclusive");
  const different = evidence();
  different.scales.forEach((s, i) => {
    s.bins[0].medianWidth = i ? 3 : 6;
    s.bins[0].regions = i ? [4, 5] : [0, 1];
  });
  assert.equal(classifyFaceMotion(different, profile).verdict, "no_signal");
});

test("low detail alone cannot flag motion without directional or repeated edge evidence", () => {
  const e = evidence();
  assert.equal(classifyFaceMotion(e, profile).verdict, "no_signal");
  e.scales.forEach((s, i) => (s.bins[0].medianWidth = i ? 3 : 6));
  e.scales[0].detail.laplacianVariance = 20;
  assert.equal(classifyFaceMotion(e, profile).verdict, "no_signal");
});

test("native repeated-edge evidence follows horizontal, diagonal and vertical motion",()=>{
 for(const angle of [0,Math.PI/4,Math.PI/2]){
  const width=192,height=192,sharp=new Uint8ClampedArray(width*height*4),ghost=new Uint8ClampedArray(sharp.length),c=Math.cos(angle),s=Math.sin(angle);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
   const u=x*c+y*s+300,v=-x*s+y*c+300;
   const sample=shift=>(Math.floor((u+shift)/32)+Math.floor(v/32))%2?220:30;
   const i=(y*width+x)*4,a=sample(0),b=(a+sample(6))/2;
   sharp.set([a,a,a,255],i);ghost.set([b,b,b,255],i);
  }
  const d=Math.round(angle/Math.PI*8)%8;
  const a=measureFaceMotion({width,height,data:sharp}).scales[0].bins[d];
  const b=measureFaceMotion({width,height,data:ghost}).scales[0].bins[d];
  assert.ok(b.ghosts>a.ghosts,`angle ${angle}`);
 }
});

test('pixel measurement exposes independent spatial detail without changing motion bins',()=>{
 const image=fixture();const measured=measureFaceMotion(image);
 for(const scale of measured.scales){assert.equal(scale.detailRegions.length,9);assert.ok(scale.detailRegions.every(r=>r.pixels>=64&&Number.isFinite(r.laplacianVariance)&&Number.isFinite(r.tenengrad)));}
});
