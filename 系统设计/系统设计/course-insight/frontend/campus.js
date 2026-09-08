// 线下教室工作台。原始画面只用于当前预览和本地模型，数据库保存教室级数值及教学记录。
const campusUi={devices:[],deviceId:null,timer:null,generation:0,version:0,models:null,modelPromise:null,previousPixels:null,loading:false};
function setupCampus(){
  const mode=document.createElement("div");mode.className="campus-mode-fields";
  mode.innerHTML=`<label>教学模式<select id="classModeSelect"><option value="online">线上课堂</option><option value="offline">线下教室</option><option value="hybrid">混合教学</option></select></label><label id="campusRoomField" class="hidden">线下教室<select id="campusRoomSelect"><option value="">等待授权教室</option></select></label><p id="campusModeHint" class="tool-hint">学生通过课堂码加入，保留完整线上互动。</p>`;
  byId("startClassButton").before(mode);
  byId("classModeSelect").onchange=()=>{byId("classRoomSelect").closest("label").classList.toggle("hidden",byId("classModeSelect").value==="offline");const offline=byId("classModeSelect").value!=="online";byId("campusRoomField").classList.toggle("hidden",!offline);byId("campusModeHint").textContent=offline?"按授权教室接入摄像头；画面人数与线上签到分别记录。":"学生通过课堂码加入，保留完整线上互动。";};
  const directory=document.createElement("section");directory.id="campusDirectory";directory.className="management-panel campus-directory";
  directory.innerHTML=`<div class="management-heading"><div><p class="eyebrow">CAMPUS / CONNECTED CLASSROOMS</p><h2>教室与设备</h2><p>从线上互动，走进真实课堂。</p></div><button id="refreshCampus" class="ghost-button">刷新设备</button></div><div id="campusDeviceCards" class="campus-device-grid"></div><p id="campusDirectoryStatus" class="tool-hint" role="status"></p><details class="campus-config"><summary>设备接入设置</summary><p class="tool-hint">IP 由服务器登记。请选择设备并填写厂商提供的流路径，测试连接只检查所选端口。</p><div class="campus-config-grid"><label>设备<select id="campusConfigDevice"></select></label><label>协议<select id="campusProtocol"><option value="rtsp">RTSP 视频流 · 需要 FFmpeg</option><option value="http">HTTP JPEG 抓图</option><option value="https">HTTPS JPEG 抓图</option></select></label><label>端口<input id="campusPort" type="number" min="1" max="65535" value="554"/></label><label>视频或抓图路径<input id="campusPath" placeholder="填写厂商确认的路径，以 / 开头" maxlength="1000"/></label><label>更新设备账号（可选）<input id="campusUsername" autocomplete="off" placeholder="留空保留原账号"/></label><label>更新设备密码（可选）<input id="campusPassword" type="password" autocomplete="new-password" placeholder="留空保留原密码"/></label></div><div class="campus-actions"><button id="saveCampusDevice">保存接入设置</button><button id="probeCampusDevice" class="ghost-button">测试端口连接</button></div><p id="campusProbeStatus" role="status" class="tool-hint"></p></details>`;
  byId("teacherSetup").after(directory);
  const panel=document.createElement("section");panel.id="campusLive";panel.className="management-panel campus-live hidden";
  panel.innerHTML=`<div class="management-heading"><div><p class="eyebrow">IN-ROOM / LIVE OBSERVATION</p><h2 id="campusLiveTitle">线下教室</h2><p>观察课堂现场，记录教学调整。<span id="campusClassCode"></span></p></div><span id="campusLiveBadge" class="campus-badge">尚未连接</span></div><div class="campus-live-grid"><div><div class="campus-video"><img id="campusFrame" class="hidden" alt="当前授权教室摄像头画面"/><div id="campusVideoEmpty"><span class="campus-camera-symbol">▣</span><h3>让课堂现场连接起来</h3><p>选择设备，开始接入真实教室画面。</p></div><span class="campus-video-label">教室画面 · 不录制</span></div><div class="campus-actions"><label class="sr-only" for="campusLiveDevice">教室摄像头</label><select id="campusLiveDevice"></select><button id="startCampus">接入摄像头</button><button id="stopCampus" class="ghost-button" disabled>停止接入</button></div><p id="campusStreamStatus" class="tool-hint" role="status">教师保持此页面开启时进行本地分析；离开页面将停止接入。</p></div><div class="campus-insights"><p class="eyebrow">OBSERVABLE SIGNALS</p><h3>课堂现场信号</h3><div class="campus-kpis"><div><span>可见人体</span><strong id="campusPeople">—</strong></div><div><span>举手人体</span><strong id="campusHands">—</strong></div><div><span>可见人脸</span><strong id="campusFaces">—</strong></div><div><span>画面亮度</span><strong id="campusBrightness">—</strong></div></div><p id="campusAnalysisStatus" role="status" class="tool-hint">等待真实画面，不生成演示识别数据。</p><div class="campus-signal-note">当前姿态模型单帧最多检测 12 人，远景与遮挡会漏检。这里记录可观察的画面信号，不推断情绪、身份或个人专注度，也不代替签到。</div></div></div><div class="campus-followup"><div><p class="eyebrow">OBSERVE → ADJUST → REVIEW</p><h3>线下教学跟进</h3><p class="tool-hint">把课堂发现、教学调整与后续效果连起来。</p><label>记录类型<select id="campusNoteKind"><option value="observation">课堂观察</option><option value="action">教学调整</option><option value="outcome">效果结论</option></select></label><label id="campusRelatedField" class="hidden">对应教学调整<select id="campusRelatedAction"></select></label><label>记录内容<textarea id="campusNote" rows="3" maxlength="1000" placeholder="例如：增加一道随堂练习，并观察举手互动是否改善。"></textarea></label><button id="saveCampusNote">保存教学记录</button></div><div><div class="management-heading"><h3>本节课堂记录</h3><span id="campusSampleCount" class="tool-hint">0 份观测</span></div><div id="campusNotes" class="campus-notes"></div></div></div>`;
  byId("teacherOverview").after(panel);
  byId("refreshCampus").onclick=e=>runAction(e.currentTarget,loadCampusDevices);
  byId("campusConfigDevice").onchange=fillCampusConfig;
  byId("campusProtocol").onchange=()=>{byId("campusPort").value=({rtsp:554,http:80,https:443})[byId("campusProtocol").value];};
  byId("saveCampusDevice").onclick=e=>runAction(e.currentTarget,async()=>{
    const payload={deviceId:byId("campusConfigDevice").value,protocol:byId("campusProtocol").value,port:Number(byId("campusPort").value),streamPath:byId("campusPath").value.trim()};
    if(byId("campusUsername").value)payload.username=byId("campusUsername").value;
    if(byId("campusPassword").value)payload.password=byId("campusPassword").value;
    await request("/api/campus/configure",{method:"POST",body:JSON.stringify(payload)});byId("campusPassword").value="";byId("campusUsername").value="";await loadCampusDevices();notifyUser("设备设置已保存。");
  });
  byId("probeCampusDevice").onclick=e=>runAction(e.currentTarget,async()=>{byId("campusProbeStatus").textContent="正在检查所选设备端口…";const result=await request("/api/campus/probe",{method:"POST",body:JSON.stringify({deviceId:byId("campusConfigDevice").value})});byId("campusProbeStatus").textContent=result.message;});
  byId("startCampus").onclick=e=>runAction(e.currentTarget,startCampus);
  byId("stopCampus").onclick=e=>runAction(e.currentTarget,()=>stopCampus(true));
  byId("campusNoteKind").onchange=()=>byId("campusRelatedField").classList.toggle("hidden",byId("campusNoteKind").value!=="outcome");
  byId("saveCampusNote").onclick=e=>runAction(e.currentTarget,async()=>{const result=await request("/api/campus/notes",{method:"POST",body:JSON.stringify({kind:byId("campusNoteKind").value,relatedId:byId("campusRelatedAction").value,message:byId("campusNote").value})});byId("campusNote").value="";renderDashboard(result.state);});
  for(const view of ["teacherHomeView","teacherView"]){const link=document.createElement("a");link.className="nav-item";link.href=view==="teacherHomeView"?"#campusDirectory":"#campusLive";link.textContent=view==="teacherHomeView"?"教室与设备":"线下课堂现场";byId(view).querySelector("nav").append(link);}
  document.addEventListener("visibilitychange",()=>{if(document.hidden && campusUi.deviceId)stopCampus(true).catch(showError);});
  window.addEventListener("pagehide",()=>{if(campusUi.deviceId)stopCampus(true).catch(()=>{});});
}

async function loadCampusDevices(){
  if(app.user?.role!=="teacher" || campusUi.loading)return;
  campusUi.loading=true;const token=app.token;
  try{
    const result=await request("/api/campus/devices");if(app.token!==token)return;
    campusUi.devices=result.devices;
    byId("campusDeviceCards").innerHTML=result.devices.length?result.devices.map(d=>`<article class="campus-device"><div class="campus-device-top"><span>教室</span><span class="campus-badge ${d.configured?"ready":""}">${d.occupied?"使用中":d.configured?"待连接":"待配置"}</span></div><strong>${escapeHtml(d.roomId)}</strong><p>${escapeHtml(d.name)}</p><small>${escapeHtml(d.protocol.toUpperCase())} · ${escapeHtml(d.host)}</small></article>`).join(""):emptyState("尚未分配线下教室",result.accessHelp);
    byId("campusDirectoryStatus").textContent=result.devices.length?`${result.devices.length} 台授权设备 · “待连接”仅表示参数已填写，不代表网络或识别已验证。`:result.accessHelp;
    const roomSelect=byId("campusRoomSelect"),selected=roomSelect.value;
    roomSelect.innerHTML='<option value="">选择授权教室</option>'+[...new Set(result.devices.map(d=>d.roomId))].map(room=>`<option value="${escapeHtml(room)}">${escapeHtml(room)} 教室</option>`).join("");roomSelect.value=selected;
    const configSelect=byId("campusConfigDevice"),configId=configSelect.value;
    configSelect.innerHTML=result.devices.map(d=>`<option value="${escapeHtml(d.id)}">${escapeHtml(d.name)}</option>`).join("");
    if(result.devices.some(d=>d.id===configId))configSelect.value=configId;
    for(const id of ["saveCampusDevice","probeCampusDevice"])byId(id).disabled=!result.devices.length;
    fillCampusConfig();renderCampus(app.dashboard);
  }catch(error){byId("campusDirectoryStatus").textContent=error.message;throw error;}finally{campusUi.loading=false;}
}
function fillCampusConfig(){const d=campusUi.devices.find(d=>d.id===byId("campusConfigDevice").value);if(!d)return;byId("campusProtocol").value=d.protocol;byId("campusPort").value=d.port;byId("campusPath").value=d.streamPath;byId("campusUsername").value="";byId("campusPassword").value="";byId("campusProbeStatus").textContent=d.hasCredentials?"服务端已保存设备凭据，密码不会返回页面。":"尚未保存设备凭据。";}
function campusPageChanged(page){
  if(page!=="teacherClass" && campusUi.deviceId)stopCampus(true).catch(showError);
  if(app.user?.role==="teacher" && ["teacherHome","teacherClass"].includes(page))loadCampusDevices().catch(showError);
  if(page==="login"){campusUi.devices=[];byId("campusPassword").value="";}
}
function renderCampus(state){
  if(!state)return;
  const inRoom=["offline","hybrid"].includes(state.meeting.mode);
  const offline=state.meeting.mode==="offline";
  for(const node of [byId("teacherOverview"),byId("teacherVideoGrid").closest(".teacher-grid"),byId("teacherFollowup"),byId("teacherRooms")])node.classList.toggle("hidden",offline);
  for(const anchor of byId("teacherView").querySelectorAll('a[href="#teacherFollowup"],a[href="#teacherRooms"]'))anchor.classList.toggle("hidden",offline);
  byId("campusLive").classList.toggle("hidden",!inRoom || app.user?.role!=="teacher");
  byId("campusClassCode").textContent=state.meeting.code?" 学生互动码："+state.meeting.code:"";
  byId("campusLiveTitle").textContent=`${state.meeting.campusRoomId || "线下"} 教室 · ${state.meeting.mode==="hybrid"?"混合教学":"线下课堂"}`;
  const select=byId("campusLiveDevice"),selected=select.value;
  const devices=campusUi.devices.filter(d=>d.roomId===state.meeting.campusRoomId);
  const options=devices.map(d=>`<option value="${escapeHtml(d.id)}">${escapeHtml(d.name)}</option>`).join("");
  if(select.innerHTML!==options){select.innerHTML=options;if(devices.some(d=>d.id===selected))select.value=selected;}
  select.disabled=!!campusUi.deviceId;
  byId("startCampus").disabled=!!campusUi.deviceId || !devices.length || state.meeting.status!=="live";
  byId("stopCampus").disabled=!campusUi.deviceId;
  const latest=state.campus?.latest;
  const fresh=latest && Date.now()-latest.createdAt<10000 && !!campusUi.deviceId;
  for(const [id,key] of [["campusPeople","detectedPeople"],["campusHands","raisedHands"],["campusFaces","visibleFaces"],["campusBrightness","brightness"]])byId(id).textContent=fresh?(latest[key]??"—"):"—";
  byId("campusSampleCount").textContent=`${state.campus?.sampleCount || 0} 份观测`;
  const notes=state.campus?.notes || [];
  byId("campusNotes").innerHTML=notes.length?notes.slice().reverse().map(n=>`<article class="campus-note"><header><span>${({observation:"课堂观察",action:n.closedAt?"教学调整 · 已确认效果":"教学调整 · 待确认效果",outcome:"效果结论"})[n.kind] || "课堂观察"}</span><small>${formatTime(n.createdAt)}</small></header><p>${escapeHtml(n.message)}</p></article>`).join(""):emptyState("从一次观察开始","记录课堂变化，实施调整，再补充效果结论。");
  const related=byId("campusRelatedAction"),relatedId=related.value;
  related.innerHTML=notes.filter(n=>n.kind==="action"&&!n.closedAt).map(n=>`<option value="${escapeHtml(n.id)}">${escapeHtml(n.message.slice(0,50))}</option>`).join("");if([...related.options].some(o=>o.value===relatedId))related.value=relatedId;
  byId("saveCampusNote").disabled=!inRoom || state.meeting.status!=="live";
  if(state.meeting.status!=="live" && campusUi.deviceId)stopCampus(false).catch(showError);
}

async function loadCampusModels(){
  if(campusUi.models)return campusUi.models;
  if(campusUi.modelPromise)return campusUi.modelPromise;
  byId("campusAnalysisStatus").textContent="正在加载本地人体与人脸模型…";
  campusUi.modelPromise=(async()=>{
    const vision=await import("/vendor/mediapipe/vision_bundle.mjs");
    const files=await vision.FilesetResolver.forVisionTasks("/vendor/mediapipe/wasm");
    const pose=await vision.PoseLandmarker.createFromOptions(files,{baseOptions:{modelAssetPath:"/vendor/mediapipe/models/pose_landmarker_lite.task"},runningMode:"IMAGE",numPoses:12});
    try{const face=await vision.FaceDetector.createFromOptions(files,{baseOptions:{modelAssetPath:"/vendor/mediapipe/models/blaze_face_short_range.tflite"},runningMode:"IMAGE"});campusUi.models={pose,face};return campusUi.models;}catch(error){pose.close();throw error;}
  })();
  try{return await campusUi.modelPromise;}finally{campusUi.modelPromise=null;}
}
function frameSignals(image){
  const canvas=document.createElement("canvas");canvas.width=64;canvas.height=36;const context=canvas.getContext("2d",{willReadFrequently:true});context.drawImage(image,0,0,64,36);
  const pixels=context.getImageData(0,0,64,36).data;let total=0,difference=0;
  for(let i=0;i<pixels.length;i+=4){const gray=(pixels[i]+pixels[i+1]+pixels[i+2])/3;total+=gray;if(campusUi.previousPixels)difference+=Math.abs(gray-campusUi.previousPixels[i/4]);}
  const motion=campusUi.previousPixels?Math.round(difference/(pixels.length/4)):null;
  campusUi.previousPixels=Float32Array.from({length:pixels.length/4},(_,i)=>(pixels[i*4]+pixels[i*4+1]+pixels[i*4+2])/3);
  return {brightness:Math.round(total/(pixels.length/4)),motion};
}
async function startCampus(){
  const deviceId=byId("campusLiveDevice").value;if(!deviceId)throw new Error("请选择当前教室的摄像头。");
  const result=await request("/api/campus/start",{method:"POST",body:JSON.stringify({deviceId})});
  campusUi.deviceId=deviceId;campusUi.version=0;campusUi.previousPixels=null;const generation=++campusUi.generation;
  renderDashboard(result.state);const meetingId=app.dashboard.meeting.id;
  async function tick(){
    if(generation!==campusUi.generation || app.page!=="teacherClass")return;
    let receivedFrame=false;
    try{
      const frame=await request("/api/campus/frame?deviceId="+encodeURIComponent(deviceId));
      if(generation!==campusUi.generation)return;
      receivedFrame=true;
      byId("campusLiveBadge").textContent=({connecting:"连接中",live:"实时画面",stale:"画面过期",error:"接入异常"})[frame.status] || "未连接";
      byId("campusStreamStatus").textContent=frame.error || (frame.status==="live"?"真实设备画面 · 最近更新 "+formatTime(frame.updatedAt):"正在等待设备返回画面…");
      if(!frame.frame){for(const id of ["campusPeople","campusHands","campusFaces","campusBrightness"])byId(id).textContent="—";byId("campusFrame").classList.add("hidden");byId("campusFrame").removeAttribute("src");byId("campusVideoEmpty").classList.remove("hidden");return;}
      if(frame.version===campusUi.version)return;
      const image=new Image();image.src="data:image/jpeg;base64,"+frame.frame;await image.decode();
      if(generation!==campusUi.generation)return;
      byId("campusFrame").src=image.src;byId("campusFrame").classList.remove("hidden");byId("campusVideoEmpty").classList.add("hidden");campusUi.version=frame.version;
      const models=await loadCampusModels();if(generation!==campusUi.generation)return;
      const started=performance.now();let poses=null,faces=null;const errors=[];
      try{poses=models.pose.detect(image).landmarks;}catch{errors.push("人体模型暂不可用");}
      try{faces=models.face.detect(image).detections;}catch{errors.push("人脸模型暂不可用");}
      const raised=poses?.map(points=>VisionMetrics.handRaised(points));
      const signals={...frameSignals(image),detectedPeople:poses?.length ?? null,visibleFaces:faces?.length ?? null,raisedHands:raised?.some(v=>v===null)?null:raised?.filter(Boolean).length ?? null,latencyMs:Math.round(performance.now()-started)};
      const saved=await request("/api/campus/observations",{method:"POST",headers:{"X-Classroom-Id":meetingId},body:JSON.stringify({deviceId,version:frame.version,...signals})});
      if(generation!==campusUi.generation)return;
      if(saved.state)renderDashboard(saved.state);
      byId("campusAnalysisStatus").textContent=errors.length?errors.join("；"):"本地模型分析完成 · "+signals.latencyMs+" ms；观测已保存";
    }catch(error){if(!receivedFrame){byId("campusFrame").classList.add("hidden");byId("campusFrame").removeAttribute("src");byId("campusVideoEmpty").classList.remove("hidden");byId("campusLiveBadge").textContent="连接中断";for(const id of ["campusPeople","campusHands","campusFaces","campusBrightness"])byId(id).textContent="—";}byId("campusAnalysisStatus").textContent=error.message;if((error.status===409&&!receivedFrame)||error.status===401 || error.status===403 || error.status===404 || (error.status===409 && app.dashboard?.meeting.id!==meetingId))await stopCampus(false);}
    finally{if(generation===campusUi.generation)campusUi.timer=setTimeout(tick,1500);}
  }
  tick();
}
async function stopCampus(notify=true){
  const deviceId=campusUi.deviceId;campusUi.deviceId=null;campusUi.generation++;clearTimeout(campusUi.timer);campusUi.timer=null;campusUi.previousPixels=null;
  byId("campusFrame").classList.add("hidden");byId("campusFrame").removeAttribute("src");byId("campusVideoEmpty").classList.remove("hidden");byId("campusLiveBadge").textContent="已停止";
  byId("campusAnalysisStatus").textContent="观测已停止，已保存的数据仍可在复盘查看。";
  if(app.dashboard)renderCampus(app.dashboard);
  if(notify && deviceId && app.token && app.dashboard?.meeting.status==="live")await request("/api/campus/stop",{method:"POST",keepalive:true,body:JSON.stringify({deviceId})});
}
function renderCampusReview(review){
  byId("reviewView").classList.toggle("campus-review-only",review.meeting.mode==="offline");
  let node=byId("campusReview");if(!node){node=document.createElement("section");node.id="campusReview";node.className="management-panel";byId("reviewView").querySelector(".review-intro").after(node);}
  node.classList.toggle("hidden",!["offline","hybrid"].includes(review.meeting.mode));
  const data=review.campus;const notes=data?.notes || [];
  node.innerHTML=`<p class="eyebrow">IN-ROOM / CLASS REVIEW</p><h2>${escapeHtml(review.meeting.campusRoomId || "")} 教室 · 线下复盘</h2><div class="campus-review-kpis"><p>有效观测<strong>${data?.sampleCount || 0} 份</strong></p><p>可见人体峰值<strong>${data?.peakDetectedPeople ?? "—"}</strong></p><p>教学调整<strong>${notes.filter(n=>n.kind==="action").length} 次</strong></p><p>效果已确认<strong>${notes.filter(n=>n.kind==="action"&&n.closedAt).length} 次</strong></p></div><p class="tool-hint">画面检测值存在远景、遮挡和模型容量限制，不等于真实到课人数；多个设备样本不会相加为班级人数。</p>${campusTrend(data?.samples || [])}<div class="campus-notes">${notes.map(n=>`<article class="campus-note"><header>${({observation:"观察",action:"调整",outcome:"效果结论"})[n.kind] || "观察"} · ${formatTime(n.createdAt)}</header><p>${escapeHtml(n.message)}</p></article>`).join("") || emptyState("没有教学记录","本节课尚未保存线下教学跟进。")}</div>`;
}

// 多设备分别绘线，避免把重叠视角相加成人数；无有效样本时不绘制虚构趋势。
function campusTrend(samples){
  const valid=samples.filter(s=>typeof s.detectedPeople==="number");
  if(!valid.length)return emptyState("没有有效人数观测","未接入画面或模型不可判定时，不生成趋势曲线。");
  const start=Math.min(...valid.map(s=>s.createdAt)),end=Math.max(...valid.map(s=>s.createdAt));
  const max=Math.max(5,Math.ceil(Math.max(...valid.map(s=>s.detectedPeople))/5)*5);
  const colors=["#526adc","#148c86","#c27736","#9866bc"];
  const ids=[...new Set(valid.map(s=>s.deviceId))];
  const lines=ids.map((id,index)=>{const values=valid.filter(s=>s.deviceId===id);const step=Math.max(1,Math.ceil(values.length/180));const points=values.filter((_,i)=>i%step===0 || i===values.length-1).map(s=>(40+(s.createdAt-start)/Math.max(1,end-start)*600)+","+(170-s.detectedPeople/max*140)).join(" ");return '<polyline fill="none" stroke="'+colors[index%colors.length]+'" stroke-width="2.5" points="'+points+'"/>';}).join("");
  return '<div class="campus-trend"><h3>可见人体 · 过程趋势</h3><svg viewBox="0 0 680 210" role="img" aria-label="各摄像头可见人体数量过程趋势"><path d="M40 30V170H645" fill="none" stroke="#dbe3f0"/><text x="12" y="35" fill="#72839c" font-size="12">'+max+'</text><text x="18" y="174" fill="#72839c" font-size="12">0</text>'+lines+'<text x="40" y="200" fill="#72839c" font-size="12">'+formatTime(start)+'</text><text x="645" y="200" text-anchor="end" fill="#72839c" font-size="12">'+formatTime(end)+'</text></svg><p class="tool-hint">'+ids.map((_,i)=>'<span style="color:'+colors[i%colors.length]+'">● 画面 '+(i+1)+'</span>').join('　')+' · 每条线独立统计；缺帧时段没有观测证据。</p></div>';
}
