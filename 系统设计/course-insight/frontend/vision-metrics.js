// 正式课堂与回放实验室共用逐帧判据；没有足够关键点时返回 null（不可判定）。
(function (scope) {
  function handRaised(landmarks) {
    if (!landmarks || landmarks.length < 17) return null;
    const visible = p => p && (p.visibility === undefined || p.visibility > 0.3);
    const pairs = [[landmarks[15], landmarks[11]], [landmarks[16], landmarks[12]]];
    const valid = pairs.filter(([wrist, shoulder]) => visible(wrist) && visible(shoulder));
    return valid.length ? valid.some(([wrist, shoulder]) => wrist.y < shoulder.y) : null;
  }
  function eyesClosed(shapes) {
    const left = shapes?.find(c => c.categoryName === "eyeBlinkLeft")?.score;
    const right = shapes?.find(c => c.categoryName === "eyeBlinkRight")?.score;
    return left == null || right == null ? null : left > 0.5 && right > 0.5;
  }
  function evaluate(samples, intervals) {
    return Object.fromEntries(["facePresent", "handRaised", "eyesClosed"].map(key => {
      const counts = { labeled: 0, evaluated: 0, tp: 0, tn: 0, fp: 0, fn: 0, unknown: 0 };
      for (const sample of samples) {
        const label = intervals.find(i => sample.time >= i.start && sample.time < i.end)?.[key];
        if (typeof label !== "boolean") continue;
        counts.labeled++;
        const prediction = sample[key];
        if (typeof prediction !== "boolean") { counts.unknown++; continue; }
        counts.evaluated++;
        counts[prediction ? (label ? "tp" : "fp") : (label ? "fn" : "tn")]++;
      }
      const ratio = (n, d) => d ? n / d : null;
      return [key, { ...counts, coverage: ratio(counts.evaluated, counts.labeled), precision: ratio(counts.tp, counts.tp + counts.fp), recall: ratio(counts.tp, counts.tp + counts.fn), accuracy: ratio(counts.tp + counts.tn, counts.evaluated) }];
    }));
  }
  const api = { handRaised, eyesClosed, evaluate, version: "visual-rules-v1" };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else scope.VisionMetrics = api;
})(globalThis);
