import { FilesetResolver, FaceDetector, PoseLandmarker, FaceLandmarker } from "/vendor/mediapipe/vision_bundle.mjs";

const el = id => document.getElementById(id);
const video = el("labVideo");
const lab = { models: null, samples: [], intervals: [], stream: null, url: null, running: false, source: null, report: null, run: 0 };
const truth = value => value === null ? "不可判定" : value ? "是" : "否";
const percent = value => value === null ? "—" : (value * 100).toFixed(1) + "%";
async function models() {
  if (lab.models) return lab.models;
  el("labStatus").textContent = "正在加载本地模型，首次加载可能需要片刻…";
  const files = await FilesetResolver.forVisionTasks("/vendor/mediapipe/wasm");
  // 顺序初始化，降低首次加载时的内存峰值；三个检测器使用 IMAGE 模式。
  const face = await FaceDetector.createFromOptions(files, {baseOptions:{modelAssetPath:"/vendor/mediapipe/models/blaze_face_short_range.tflite"},runningMode:"IMAGE"});
  const pose = await PoseLandmarker.createFromOptions(files, {baseOptions:{modelAssetPath:"/vendor/mediapipe/models/pose_landmarker_lite.task"},runningMode:"IMAGE",numPoses:1});
  const eyes = await FaceLandmarker.createFromOptions(files, {baseOptions:{modelAssetPath:"/vendor/mediapipe/models/face_landmarker.task"},runningMode:"IMAGE",numFaces:1,outputFaceBlendshapes:true});
  lab.models = {face,pose,eyes}; return lab.models;
}
function once(target, event, operation) {
  return new Promise((resolve,reject) => {
    const timer = setTimeout(() => finish(new Error("视频解码超时，请换用浏览器支持的 MP4/WebM。")),10000);
    const done = () => finish(); const bad = () => finish(new Error("视频无法解码。"));
    function finish(error) { clearTimeout(timer); target.removeEventListener(event,done); target.removeEventListener("error",bad); error ? reject(error) : resolve(); }
    target.addEventListener(event,done,{once:true}); target.addEventListener("error",bad,{once:true}); operation();
  });
}
async function labels() {
  const file = el("labelFile").files[0]; if (!file) return [];
  const data = JSON.parse(await file.text());
  if (!Array.isArray(data.intervals)) throw new Error("标签必须包含 intervals 数组。");
  const intervals = data.intervals.slice().sort((a,b) => a.start - b.start);
  intervals.forEach((i,index) => {
    if (!Number.isFinite(i.start) || !Number.isFinite(i.end) || i.start < 0 || i.end <= i.start || (index && intervals[index-1].end > i.start)) throw new Error("标签时间无效或区间重叠。");
    for (const key of ["facePresent","handRaised","eyesClosed"]) if (i[key] !== undefined && typeof i[key] !== "boolean") throw new Error("标签状态须为 true 或 false。");
  }); return intervals;
}
function detect(time) {
  const started = performance.now(); const errors = [];
  const safely = (key,operation) => { try { return operation(); } catch(error) { errors.push(key + ": " + error.message); return null; } };
  const sample = { time: Math.round(time * 1000)/1000,
    facePresent: safely("face", () => lab.models.face.detect(video).detections.length > 0),
    handRaised: safely("pose", () => VisionMetrics.handRaised(lab.models.pose.detect(video).landmarks?.[0])),
    eyesClosed: safely("eyes", () => VisionMetrics.eyesClosed(lab.models.eyes.detect(video).faceBlendshapes?.[0]?.categories)),
    errors };
  sample.latencyMs = Math.round((performance.now()-started)*10)/10;
  lab.samples.push(sample); render();
}
function render() {
  const latency = lab.samples.map(s=>s.latencyMs).sort((a,b)=>a-b);
  lab.report = { version:1, rules:VisionMetrics.version, source:lab.source, createdAt:new Date().toISOString(), intervalSeconds:lab.source?.type === "video" ? 0.25 : null, userAgent:navigator.userAgent, dimensions:{width:video.videoWidth,height:video.videoHeight}, labels:lab.intervals, metrics:VisionMetrics.evaluate(lab.samples,lab.intervals), latency:{meanMs:latency.length ? latency.reduce((a,b)=>a+b,0)/latency.length : null,p95Ms:latency[Math.max(0,Math.ceil(latency.length*.95)-1)] ?? null}, samples:lab.samples };
  el("labSummary").textContent = `${lab.samples.length} 帧 · 平均 ${lab.report.latency.meanMs?.toFixed(1) ?? "—"} ms · P95 ${lab.report.latency.p95Ms ?? "—"} ms`;
  el("labMetrics").innerHTML = lab.intervals.length ? Object.entries(lab.report.metrics).map(([key,m]) => `<article class="lab-metric"><strong>${({facePresent:"人脸存在",handRaised:"举手",eyesClosed:"闭眼"})[key]}</strong><p>覆盖率 ${percent(m.coverage)} · 精确率 ${percent(m.precision)} · 召回率 ${percent(m.recall)}</p><small>已标注 ${m.labeled} · 不可判定 ${m.unknown} · TP ${m.tp} / TN ${m.tn} / FP ${m.fp} / FN ${m.fn}</small></article>`).join("") : '<p class="tool-hint">未提供标签，不计算准确率、精确率或召回率。</p>';
  el("labSamples").innerHTML = lab.samples.slice(-8).reverse().map(s=>`<tr><td>${s.time}</td><td>${truth(s.facePresent)}</td><td>${truth(s.handRaised)}</td><td>${truth(s.eyesClosed)}</td><td>${s.latencyMs} ms</td></tr>`).join("");
  el("exportLab").disabled = !lab.samples.length;
}
function stop() { lab.running = false; lab.run++; video.pause(); lab.stream?.getTracks().forEach(t=>t.stop()); lab.stream = null; el("stopLab").disabled = true; }
async function run(camera) {
  if (lab.running) return;
  lab.running = true; const runId = ++lab.run;
  for (const id of ["runCamera","runVideo","videoFile","labelFile"]) el(id).disabled = true;
  el("stopLab").disabled = false;
  try {
    lab.samples = []; lab.intervals = camera ? [] : await labels();
    await models(); if (runId !== lab.run) return;
    if (lab.url) { URL.revokeObjectURL(lab.url); lab.url = null; }
    video.srcObject = null; video.removeAttribute("src");
    if (camera) {
      lab.source = {type:"camera"};
      const stream = await navigator.mediaDevices.getUserMedia({video:true,audio:false});
      if (runId !== lab.run) { stream.getTracks().forEach(t=>t.stop()); return; }
      lab.stream = stream; video.srcObject = stream; await video.play();
      const start = performance.now();
      while (lab.running && runId === lab.run) { if (video.readyState >= 2) detect((performance.now()-start)/1000); el("labStatus").textContent = "真实摄像头检测中 · 点击停止结束"; await new Promise(r=>setTimeout(r,250)); }
    } else {
      const file = el("videoFile").files[0]; if (!file) throw new Error("请先选择本地真实视频。");
      lab.source = {type:"video",name:file.name,size:file.size,lastModified:file.lastModified}; lab.url = URL.createObjectURL(file);
      await once(video,"loadeddata",()=>{video.src=lab.url;video.load();});
      if (!Number.isFinite(video.duration) || video.duration <= 0) throw new Error("视频时长不可用，请转换为 MP4/WebM 后重试。");
      video.controls = false;
      for (let time=0; time<video.duration && lab.running && runId === lab.run; time+=0.25) {
        if (Math.abs(video.currentTime-time)>0.001) await once(video,"seeked",()=>{video.currentTime=time;});
        if (!lab.running || runId !== lab.run) break;
        detect(time); el("labStatus").textContent = `真实视频检测中 · ${time.toFixed(2)} / ${video.duration.toFixed(2)} 秒`;
        await new Promise(r=>setTimeout(r,0));
      }
    }
    el("labStatus").textContent = `检测${runId === lab.run ? "完成" : "已停止"} · ${lab.samples.length} 帧；可导出报告`;
  } catch(error) { el("labStatus").textContent = "未完成：" + error.message; }
  finally { stop(); video.controls = true; for (const id of ["runCamera","runVideo","videoFile","labelFile"]) el(id).disabled = false; }
}
el("runVideo").onclick = () => run(false);
el("runCamera").onclick = () => run(true);
el("stopLab").onclick = stop;
el("exportLab").onclick = () => { const url=URL.createObjectURL(new Blob([JSON.stringify(lab.report,null,2)],{type:"application/json"})); const a=document.createElement("a");a.href=url;a.download="vision-validation-"+Date.now()+".json";a.click();setTimeout(()=>URL.revokeObjectURL(url),1000); };
window.addEventListener("pagehide",stop);
