import test from 'node:test';
import assert from 'node:assert/strict';
import {planLocalMotionTiles, decideLocalMotion} from '../dist/local-motion.mjs';
const hit = (index, directionDegrees=0) => ({index, decision:{verdict:'motion_suspected', evidence:'repeated_edge_peaks',directionDegrees}});
test('local crops stay in the image and are spatially separate', () => {
  for (const [width,height] of [[6000,4000],[4000,6000],[384,384],[100,100]]) {
    const regions=planLocalMotionTiles(width,height);
    assert.equal(regions.length,width<384?0:9);
    for(const r of regions) assert.ok(r.x>=0&&r.y>=0&&r.x+r.width<=width&&r.y+r.height<=height&&r.width<=768);
  }
  assert.throws(()=>planLocalMotionTiles(100000,100000));
});
test('local warning requires three distinct tiles with matching repeated edges',()=>{
  assert.equal(decideLocalMotion([hit(0),hit(1)]),null);
  assert.equal(decideLocalMotion([hit(0),hit(0),hit(1)]),null);
  assert.equal(decideLocalMotion([hit(0),hit(1,45),hit(2)]),null);
  assert.equal(decideLocalMotion([hit(0),hit(1),{index:2,decision:{...hit(2).decision,evidence:'directional_edge_spread'}}]),null);
  assert.equal(decideLocalMotion([hit(0),hit(1),hit(2)]).scope,'local_strong_motion');
});
