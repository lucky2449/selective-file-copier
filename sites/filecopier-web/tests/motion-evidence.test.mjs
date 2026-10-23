import test from "node:test";
import assert from "node:assert/strict";
import { analyzeBlurPixels, classifyMotionEvidence } from "../dist/blur-analysis.mjs";
import { MOTION_EVIDENCE_VERSION, MOTION_SENSITIVITY, measureMotionEvidence } from "../dist/motion-evidence.mjs";
function scene(sample, size = 384) {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const value = sample(x,y); data.set([value,value,value,255],(y*size+x)*4);
  }
  return {width:size,height:size,data};
}
const pattern=(x,y)=>(Math.floor(x/32)+Math.floor(y/32))%2?225:30;
function horizontal(radius, base=pattern) {
  return scene((x,y)=>{let sum=0;for(let d=-radius;d<=radius;d++)sum+=base(Math.max(0,Math.min(383,x+d)),y);return sum/(2*radius+1);});
}
test("strong synthetic horizontal smear needs directional spread, not low sharpness rank",()=>{
  const metrics=analyzeBlurPixels(horizontal(5));
  const result=classifyMotionEvidence(metrics);
  assert.equal(result.verdict,"motion_suspected",JSON.stringify(metrics.scales.map(s=>s.motion.directions)));
  assert.deepEqual(result.reasons,["motion"]);
  assert.ok(result.supportingRegions.length>=3);
});
test("sharp grid and low-contrast sharp grid never become motion candidates",()=>{
  for(const base of [pattern,(x,y)=>128+(pattern(x,y)-128)*.2]){
    const result=classifyMotionEvidence(analyzeBlurPixels(scene(base)));
    assert.notEqual(result.verdict,"motion_suspected");assert.deepEqual(result.reasons,[]);
  }
});
test("vertical synthetic smear agrees after image rotation",()=>{
  const horizontalImage=horizontal(5);
  const vertical=scene((x,y)=>horizontalImage.data[((383-x)*384+y)*4]);
  const result=classifyMotionEvidence(analyzeBlurPixels(vertical));
  assert.equal(result.verdict,"motion_suspected");
  assert.equal(result.directionDegrees,90);
});
test("mild smear is withheld by the strict evidence gate",()=>{
  assert.notEqual(classifyMotionEvidence(analyzeBlurPixels(horizontal(1))).verdict,"motion_suspected");
});
test("seeded noise alone does not become directional motion evidence",()=>{
  let seed=12345;
  const noisy=scene(()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed>>>24;});
  assert.notEqual(classifyMotionEvidence(analyzeBlurPixels(noisy)).verdict,"motion_suspected");
});
test("low contrast or flat exposure cannot create motion candidates",()=>{
  for(const value of [0,128,255]) assert.notEqual(classifyMotionEvidence(analyzeBlurPixels(scene(()=>value))).verdict,"motion_suspected");
});
test("directional texture without perpendicular evidence is withheld",()=>{
  const result=classifyMotionEvidence(analyzeBlurPixels(horizontal(5,(x)=>Math.floor(x/32)%2?225:30)));
  assert.notEqual(result.verdict,"motion_suspected");
});
test("isotropic smooth scene is not promoted from low sharpness",()=>{
  const input=scene((x,y)=>128+40*Math.sin(x/40)+40*Math.cos(y/40));
  assert.notEqual(classifyMotionEvidence(analyzeBlurPixels(input)).verdict,"motion_suspected");
});
test("evidence must agree across scales and in the same regions",()=>{
  const bin=(edges,medianWidth)=>({edges,medianWidth});
  const dirs=[bin(80,7),bin(0,null),bin(80,2.8),bin(0,null)];
  const regions=Array.from({length:9},(_,i)=>i<3?[bin(10,7),bin(0,null),bin(10,2.8),bin(0,null)]:[bin(0,null),bin(0,null),bin(0,null),bin(0,null)]);
  const motion={version:MOTION_EVIDENCE_VERSION,directions:dirs,regions};
  const metrics={status:"measured",issues:[],scales:[{motion}, {motion:structuredClone(motion)}]};
  assert.equal(classifyMotionEvidence(metrics).verdict,"motion_suspected");
  metrics.scales[1].motion.regions.reverse();
  assert.notEqual(classifyMotionEvidence(metrics).verdict,"motion_suspected");
});
test("too few edges, malformed statistics and unsupported evidence fail closed",()=>{
  for(const metrics of [null,{}, {status:"measured",scales:[{},{}]}, {status:"inconclusive",issues:["low_texture_or_contrast"]}])
    assert.equal(classifyMotionEvidence(metrics).verdict,"inconclusive");
});
test("directional helper rejects malformed or oversized inputs before looping",()=>{
  for(const args of [[new Float32Array(1),Infinity,128],[new Float32Array(1),1025,1025],[new Uint8Array(128*128),128,128],[new Float32Array(1),128,128]])
    assert.throws(()=>measureMotionEvidence(...args),TypeError);
});
test("user sensitivity admits moderately weaker evidence while strict settings remain available",()=>{
  const bin=(edges,medianWidth)=>({edges,medianWidth});
  const build=(broad)=>({version:MOTION_EVIDENCE_VERSION,directions:[bin(22,broad),bin(0,null),bin(22,3),bin(0,null)],
    regions:Array.from({length:9},(_,i)=>i<3?[bin(5,broad),bin(0,null),bin(5,3),bin(0,null)]:[bin(0,null),bin(0,null),bin(0,null),bin(0,null)])});
  const metrics={status:"measured",issues:[],scales:[{motion:build(5.4)},{motion:build(3.5)}]};
  assert.equal(classifyMotionEvidence(metrics).verdict,"motion_suspected");
  assert.equal(classifyMotionEvidence(metrics).sensitivity,"balanced");
  assert.notEqual(classifyMotionEvidence(metrics,{sensitivity:"strict"}).verdict,"motion_suspected");
  metrics.scales[1].motion.regions[1]=[bin(0,null),bin(0,null),bin(0,null),bin(0,null)];
  assert.notEqual(classifyMotionEvidence(metrics).verdict,"motion_suspected");
});
test("default sensitivity retains requested 5.0px, 1.8 ratio, 22 edges and 3 common regions",()=>{
  assert.equal(MOTION_SENSITIVITY.balanced.minWidths[0],5);
  assert.equal(MOTION_SENSITIVITY.balanced.ratios[0],1.8);
  assert.equal(MOTION_SENSITIVITY.balanced.minEdges,22);
  assert.equal(MOTION_SENSITIVITY.balanced.minRegions,3);
  assert.equal(MOTION_SENSITIVITY.balanced.minWidths[1],3.2);
  assert.equal(MOTION_SENSITIVITY.balanced.ratios[1],1.15);
});
test("unknown sensitivity is rejected instead of silently applying permissive thresholds",()=>{
  assert.throws(()=>classifyMotionEvidence(null,{sensitivity:"anything"}),TypeError);
  assert.throws(()=>classifyMotionEvidence(null,{sensitivity:"__proto__"}),TypeError);
});
test("analysis never changes input pixels or adds storage/network dependencies",()=>{
  const input=horizontal(5), before=new Uint8ClampedArray(input.data);
  classifyMotionEvidence(analyzeBlurPixels(input)); assert.deepEqual(input.data,before);
});
