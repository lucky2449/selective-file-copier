// Choose spatially distributed detail candidates; no subject identity is inferred.
export function selectSceneTiles(metrics, width, height) {
 if(metrics?.status!=="measured" || metrics.scales?.[0]?.grid!==3 || !Array.isArray(metrics.scales[0].regions) || metrics.scales[0].regions.length!==9 || !Number.isSafeInteger(width) || !Number.isSafeInteger(height))return [];
 return metrics.scales[0].regions.map((r,i)=>({i,score:r?.tenengrad})).filter(r=>Number.isFinite(r.score)&&r.score>=8).sort((a,b)=>b.score-a.score).slice(0,4).map(({i})=>{const x=Math.floor((i%3)*width/3),y=Math.floor(Math.floor(i/3)*height/3),w=Math.floor(width/3),h=Math.floor(height/3);return {x:x+Math.max(0,Math.floor((w-768)/2)),y:y+Math.max(0,Math.floor((h-768)/2)),width:Math.min(w,768),height:Math.min(h,768),index:i};}).filter(r=>Math.min(r.width,r.height)>=128);
}
export function decideSceneDetail(prior, overall, samples) {
 if(prior?.verdict!=="inconclusive"||overall?.verdict!=="no_signal"||!Array.isArray(samples))return prior;
 if(samples.some(s=>s?.decision?.verdict==="motion_suspected"))return prior;
 const good=samples.filter(s=>s?.decision?.verdict==="no_signal"&&s.assessment?.sufficient&&s.assessment?.sharpDetail);
 return new Set(good.map(s=>s.index)).size>=2?{verdict:"no_signal",reasons:[],scope:"scene_detail_samples",experimental:true}:prior;
}
