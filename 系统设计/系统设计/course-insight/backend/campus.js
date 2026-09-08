const path=require("node:path");
const {randomUUID}=require("node:crypto");
const {createGateway}=require("./campus-gateway");
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};

/** 线下观测只保存教室级信号，不创建人脸身份、学生画像或个人专注排名。 */
function createCampus(ctx){
  const gateway=createGateway({configPath:process.env.CAMPUS_CONFIG_PATH || path.join(ctx.dataDir,"campus-cameras.json")});
  function summary(store){
    const data=store.campus || {samples:[],notes:[]};const samples=data.samples || [];
    const counts=samples.map(s=>s.detectedPeople).filter(n=>n!==null);
    return {sampleCount:samples.length,peakDetectedPeople:counts.length?Math.max(...counts):null,meanDetectedPeople:counts.length?Math.round(counts.reduce((a,b)=>a+b,0)/counts.length*10)/10:null,latest:samples.at(-1)||null,notes:data.notes||[],streams:gateway.statuses(ctx.ownerId()),observedSeconds:samples.length>1?Math.round((samples.at(-1).createdAt-samples[0].createdAt)/1000):0};
  }
  function decorate(store){return {campus:{...summary(store),samples:(store.campus?.samples || []).slice(-120)}};}
  function prepareStart(payload,user){
    const mode=payload.mode || "online";
    if(!["online","offline","hybrid"].includes(mode))fail(400,"课堂模式无效。");
    if(mode!=="online"){
      if(!gateway.list(user).some(d=>d.roomId===payload.campusRoomId))fail(403,"当前账号没有该线下教室权限，请由管理员授权。");
    }
  }
  function archive(store,review){review.campus=structuredClone({...summary(store),streams:[],samples:store.campus?.samples || []});}
  async function handle(req,res,route){
    if(!route.startsWith("/api/campus/"))return false;
    const user=req.session.user;if(user.role!=="teacher")fail(403,"线下教室管理仅限教师。");
    const p=req.method==="POST"?await ctx.readJson(req):{};
    if(!p || typeof p!=="object" || Array.isArray(p))fail(400,"请求应为 JSON 对象。");
    const query=new URL(req.url,"http://localhost").searchParams;
    const send=data=>ctx.send(res,200,data);
    if(route==="/api/campus/devices" && req.method==="GET"){send({devices:gateway.list(user),accessHelp:"如未显示教室，请在服务器运行 npm run campus:grant -- 你的教师账号。"});return true;}
    if(route==="/api/campus/configure" && req.method==="POST"){send({device:gateway.configure(user,p.deviceId,p)});return true;}
    if(route==="/api/campus/probe" && req.method==="POST"){send(await gateway.probe(user,p.deviceId));return true;}
    const store=ctx.read();
    if(store.meeting.status!=="live" || req.headers["x-classroom-id"]!==store.meeting.id)fail(409,"请在当前进行中的课堂中操作。");
    store.campus ||= {samples:[],notes:[]};
    const save=()=>{ctx.write(store);ctx.broadcast();send({state:ctx.dashboard(store)});};
    if(route==="/api/campus/start" && req.method==="POST"){
      const info=gateway.start(user,p.deviceId,store.meeting);
      ctx.event(store,{type:"campus-connect",title:"接入线下教室",detail:`教室 ${info.roomId} 开始接入摄像头。`,roomId:info.roomId});
      save();return true;
    }
    if(route==="/api/campus/stop" && req.method==="POST"){
      gateway.stopOwned(user,p.deviceId,store.meeting.id);ctx.event(store,{type:"campus-stop",title:"停止线下观测",detail:"教师主动停止摄像头连接与观测。",roomId:store.meeting.campusRoomId});save();return true;
    }
    if(route==="/api/campus/frame" && req.method==="GET"){send(gateway.latest(user,query.get("deviceId"),store.meeting.id));return true;}
    if(route==="/api/campus/observations" && req.method==="POST"){
      const signals=["detectedPeople","visibleFaces","raisedHands","brightness","motion","latencyMs"];
      for(const key of signals)if(p[key]!==null && (typeof p[key]!=="number" || !Number.isFinite(p[key]) || p[key]<0))fail(400,"观测信号无效："+key);
      for(const key of ["detectedPeople","visibleFaces","raisedHands"])if(p[key]!==null && (!Number.isInteger(p[key]) || p[key]>100))fail(400,"人数信号超出范围。");
      if(p.raisedHands!==null && (p.detectedPeople===null || p.raisedHands>p.detectedPeople))fail(400,"举手人数不能超过检测人数。");
      if(p.brightness>255 || p.motion>255 || p.latencyMs>60000)fail(400,"观测数值超出范围。");
      if(!gateway.acceptObservation(user,p.deviceId,store.meeting.id,p.version)){send({duplicate:true});return true;}
      const sample={id:randomUUID(),createdAt:Date.now(),deviceId:p.deviceId,roomId:store.meeting.campusRoomId,frameVersion:p.version,source:"teacher-browser-mediapipe",engine:"mediapipe-room-v1",...Object.fromEntries(signals.map(key=>[key,p[key]]))};
      store.campus.samples.push(sample);
      if(store.campus.samples.length>3600)store.campus.samples=store.campus.samples.filter((_,i)=>i%2===0 || i===store.campus.samples.length-1);
      save();return true;
    }
    if(route==="/api/campus/notes" && req.method==="POST"){
      if(typeof p.message!=="string" || !p.message.trim() || p.message.length>1000)fail(400,"请填写 1–1000 字教学观察。");
      const kind=p.kind || "observation";
      if(!["observation","action","outcome"].includes(kind))fail(400,"观察类型无效。");
      const related=kind==="outcome"?store.campus.notes.find(n=>n.id===p.relatedId && n.kind==="action" && !n.closedAt):null;
      if(kind==="outcome" && !related)fail(409,"请选择一个尚未完成的教学调整。");
      const note={id:randomUUID(),kind,message:p.message.trim(),createdAt:Date.now(),name:user.name,relatedId:related?.id || null,baseline:store.campus.samples.at(-1) || null};
      if(related)related.closedAt=note.createdAt;
      store.campus.notes.push(note);
      ctx.event(store,{type:"campus-note",title:"线下教学观察",detail:note.message,roomId:store.meeting.campusRoomId});save();return true;
    }
    fail(404,"线下课堂接口不存在。");
  }
  return {handle,decorate,prepareStart,archive,stopOwner:gateway.stopOwner};
}
module.exports={createCampus};
