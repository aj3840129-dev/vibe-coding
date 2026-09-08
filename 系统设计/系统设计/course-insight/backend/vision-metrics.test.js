const test = require("node:test");
const assert = require("node:assert/strict");
const metrics = require("../frontend/vision-metrics");

test("视觉评估：未知不伪装为负例，未标注不生成准确率", () => {
  const samples = [
    {time:0,facePresent:true}, {time:1,facePresent:false},
    {time:2,facePresent:null}, {time:3,facePresent:true},
  ];
  const result = metrics.evaluate(samples,[{start:0,end:3,facePresent:true},{start:3,end:4,facePresent:false}]);
  assert.deepEqual(result.facePresent,{labeled:4,evaluated:3,tp:1,tn:0,fp:1,fn:1,unknown:1,coverage:.75,precision:.5,recall:.5,accuracy:1/3});
  assert.equal(result.handRaised.accuracy,null);
  assert.equal(metrics.evaluate(samples,[]).facePresent.recall,null);
});

test("举手和闭眼共享判据：低可见度不可判断，单眼闭合不算双眼闭合", () => {
  assert.equal(metrics.handRaised(null),null);
  const landmarks = Array.from({length:17},()=>({y:.6,visibility:0}));
  assert.equal(metrics.handRaised(landmarks),null);
  landmarks[11]={y:.5,visibility:.9};landmarks[15]={y:.2,visibility:.9};
  assert.equal(metrics.handRaised(landmarks),true);
  landmarks[15].y=.8; assert.equal(metrics.handRaised(landmarks),false);
  assert.equal(metrics.eyesClosed([]),null);
  assert.equal(metrics.eyesClosed([{categoryName:"eyeBlinkLeft",score:.8},{categoryName:"eyeBlinkRight",score:.1}]),false);
  assert.equal(metrics.eyesClosed([{categoryName:"eyeBlinkLeft",score:.8},{categoryName:"eyeBlinkRight",score:.9}]),true);
});
