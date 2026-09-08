const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
const http=require("node:http");
const {spawn}=require("node:child_process");
const {createGateway}=require("./campus-gateway");

// 所有摄像头输入均来自回环地址的明确标注测试图；从不连接学校设备或使用真实凭据。
test("线下课堂：授权、媒体、观测、教学跟进与不可变归档",async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"aether-campus-"));
  const frame=fs.readFileSync(path.join(__dirname,"fixtures/campus-frame.jpg"));
  let imageRequests=0;
  const camera=http.createServer((req,res)=>{imageRequests++;if(req.url!=="/snapshot.jpg"){res.writeHead(404);res.end();return;}res.writeHead(200,{"Content-Type":"image/jpeg"});res.end(frame);});
  await new Promise(r=>camera.listen(0,"127.0.0.1",r));
  const configPath=path.join(dir,"campus-cameras.json");
  const config={version:1,devices:[{id:"test-camera",roomId:"201",name:"媒体链路测试设备",host:"127.0.0.1",protocol:"http",port:camera.address().port,streamPath:"/snapshot.jpg",username:"fixture-user",password:"fixture-secret",allowedUsernames:["campus-teacher"]}]};
  fs.writeFileSync(configPath,JSON.stringify(config));
  let logs="";const server=spawn(process.execPath,[path.join(__dirname,"server.js")],{windowsHide:true,env:{...process.env,PORT:"0",HOST:"127.0.0.1",DATA_DIR:dir,CAMPUS_CONFIG_PATH:configPath,TEACHER_ACCESS_CODE:"",FFMPEG_PATH:path.join(dir,"missing-ffmpeg")},stdio:["ignore","pipe","pipe"]});
  server.stdout.on("data",d=>logs+=d);server.stderr.on("data",d=>logs+=d);
  t.after(async()=>{if(server.exitCode===null){const ended=new Promise(r=>server.once("exit",r));server.kill();await ended;}await new Promise(r=>camera.close(r));assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith("aether-campus-"));fs.rmSync(dir,{recursive:true,force:true});});
  let base;
  for(let i=0;i<80;i++){const match=logs.match(/local URL: (http:\/\/127\.0\.0\.1:\d+)/);if(match && !match[1].endsWith(":0")){base=match[1];break;}await new Promise(r=>setTimeout(r,50));}
  assert.ok(base,logs);
  let meetingId;
  async function api(route,user,body,status=200){const res=await fetch(base+route,{method:body===undefined?"GET":"POST",headers:{"Content-Type":"application/json",...(user?{Authorization:"Bearer "+user.token}:{}),...(meetingId?{"X-Classroom-Id":meetingId}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});const data=await res.json();assert.equal(res.status,status,route+": "+JSON.stringify(data).slice(0,200));return data;}
  const teacher=await api("/api/register",null,{username:"campus-teacher",password:"campus-test-123",name:"线下教师",role:"teacher"},201);
  const other=await api("/api/register",null,{username:"campus-other",password:"campus-test-123",name:"线下教师",role:"teacher"},201);
  const student=await api("/api/register",null,{username:"campus-student",password:"campus-test-123",name:"学生",role:"student"},201);
  await t.test("设备目录按教师授权，不泄露凭据，不允许任意 IP",async()=>{
    const devices=await api("/api/campus/devices",teacher);
    assert.equal(devices.devices.length,1);assert.ok(!JSON.stringify(devices).includes("fixture-secret"));assert.ok(!JSON.stringify(devices).includes("fixture-user"));
    assert.equal((await api("/api/campus/devices",other)).devices.length,0);
    await api("/api/campus/devices",student,undefined,403);
    await api("/api/campus/probe",other,{deviceId:"test-camera"},404);
    await api("/api/campus/configure",teacher,{deviceId:"unknown",host:"192.0.2.99"},404);
    await api("/api/campus/configure",teacher,{deviceId:"test-camera",protocol:"http",port:80,streamPath:"//other-host/x"},400);
    assert.equal((await api("/api/campus/probe",teacher,{deviceId:"test-camera"})).reachable,true);
  });
  await t.test("线下教室归属校验、真实 JPEG 中继与重复帧去重",async()=>{
    await api("/api/classroom/start",other,{mode:"offline",campusRoomId:"201",title:"越权课堂",topic:"不应开课",roomId:"A101"},403);
    const started=await api("/api/classroom/start",teacher,{mode:"offline",campusRoomId:"201",title:"线下集成验收",topic:"真实媒体链路",roomId:"A101"},201);meetingId=started.meeting.id;
    await api("/api/classroom/join",student,{code:started.meeting.code,roomId:"A101"},201);
    await api("/api/campus/start",teacher,{deviceId:"test-camera"});
    await api("/api/campus/configure",teacher,{deviceId:"test-camera",protocol:"http",port:80,streamPath:"/changed"},409);
    let preview;
    for(let i=0;i<30;i++){preview=await api("/api/campus/frame?deviceId=test-camera",teacher);if(preview.frame)break;await new Promise(r=>setTimeout(r,50));}
    assert.deepEqual(Buffer.from(preview.frame,"base64"),frame);assert.ok(imageRequests>0);
    await api("/api/campus/frame?deviceId=test-camera",student,undefined,403);
    const sample={deviceId:"test-camera",version:preview.version,detectedPeople:3,visibleFaces:2,raisedHands:1,brightness:100,motion:null,latencyMs:35};
    await api("/api/campus/observations",teacher,{...sample,version:999999},409);
    await api("/api/campus/observations",teacher,{...sample,raisedHands:4},400);
    await api("/api/campus/observations",teacher,sample);
    assert.equal((await api("/api/campus/observations",teacher,sample)).duplicate,true);
    const state=await api("/api/state",teacher);assert.equal(state.campus.sampleCount,1);assert.equal(state.campus.peakDetectedPeople,3);assert.equal(state.metrics.totalStudents,1);
    assert.equal((await api("/api/state",student)).campus,undefined);
  });
  await t.test("观察→调整→效果结论，结课归档隔离并停止摄像头",async()=>{
    await api("/api/campus/notes",teacher,{kind:"observation",message:"前排正在进行小组讨论。"});
    const created=await api("/api/campus/notes",teacher,{kind:"action",message:"增加一次全班提问。"});
    const action=created.state.campus.notes.at(-1);
    await api("/api/campus/notes",teacher,{kind:"outcome",relatedId:action.id,message:"讨论后学生主动回答，保留这次教学调整。"});
    await api("/api/campus/notes",teacher,{kind:"outcome",relatedId:action.id,message:"重复结论"},409);
    const ended=await api("/api/classroom/end",teacher,{},201);
    assert.equal(ended.review.campus.sampleCount,1);assert.equal(ended.review.campus.notes.length,3);assert.ok(ended.review.campus.notes.find(n=>n.id===action.id).closedAt);
    await api("/api/campus/frame?deviceId=test-camera",teacher,undefined,409);
    const exported=await api("/api/report/export?meetingId="+meetingId,teacher);assert.match(exported.content,/线下教室观测/);assert.match(exported.content,/增加一次全班提问/);
    await api("/api/classroom/review?meetingId="+meetingId,other,undefined,404);
    const next=await api("/api/classroom/start",teacher,{mode:"online",title:"后续线上课",topic:"兼容验证",roomId:"A101"},201);meetingId=next.meeting.id;
    assert.equal(next.state.campus.sampleCount,0);assert.equal(next.state.campus.notes.length,0);
    await api("/api/campus/start",teacher,{deviceId:"test-camera"},409);
  });
});

test("媒体网关：设备互斥、过期帧、主动释放与缺少 FFmpeg",async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"aether-gateway-"));let now=1000;
  const frame=fs.readFileSync(path.join(__dirname,"fixtures/campus-frame.jpg"));
  const camera=http.createServer((req,res)=>res.end(frame));await new Promise(r=>camera.listen(0,"127.0.0.1",r));
  const filename=path.join(dir,"cameras.json");
  fs.writeFileSync(filename,JSON.stringify({devices:[{id:"test",roomId:"201",host:"127.0.0.1",protocol:"http",port:camera.address().port,streamPath:"/",allowedUsernames:["teacher-a","teacher-b"]},{id:"rtsp",roomId:"201",host:"127.0.0.1",protocol:"rtsp",port:554,streamPath:"/confirmed-stream",allowedUsernames:["teacher-a"]}]}));
  const gateway=createGateway({configPath:filename,ffmpegPath:path.join(dir,"missing-ffmpeg"),now:()=>now});
  t.after(async()=>{gateway.close();await new Promise(r=>camera.close(r));assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith("aether-gateway-"));fs.rmSync(dir,{recursive:true,force:true});});
  const user={id:"a",username:"teacher-a",role:"teacher"},meeting={id:"class-a",mode:"offline",campusRoomId:"201"};
  gateway.start(user,"test",meeting);
  assert.throws(()=>gateway.start({id:"b",username:"teacher-b",role:"teacher"},"test",{...meeting,id:"class-b"}),{status:409});
  let latest;for(let i=0;i<30;i++){latest=gateway.latest(user,"test",meeting.id);if(latest.frame)break;await new Promise(r=>setTimeout(r,20));}assert.ok(latest.frame);
  now+=7000;assert.equal(gateway.latest(user,"test",meeting.id).frame,null);assert.throws(()=>gateway.acceptObservation(user,"test",meeting.id,latest.version),{status:409});
  gateway.stopOwner(user.id);assert.throws(()=>gateway.latest(user,"test",meeting.id),{status:409});
  gateway.start(user,"rtsp",meeting);await new Promise(r=>setTimeout(r,100));assert.match(gateway.latest(user,"rtsp",meeting.id).error,/FFmpeg/);
});


test("RTSP 适配器按完整 JPEG 边界组帧，不返回设备凭据",async t=>{
  const {EventEmitter}=require("node:events"),{PassThrough}=require("node:stream");
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"aether-rtsp-"));
  const filename=path.join(dir,"cameras.json");
  fs.writeFileSync(filename,JSON.stringify({devices:[{id:"rtsp-test",roomId:"201",host:"127.0.0.1",protocol:"rtsp",port:554,streamPath:"/stream",username:"fixture",password:"fixture-secret",allowedUsernames:["teacher"]}]}));
  let child,launch;
  const gateway=createGateway({configPath:filename,spawnProcess:(program,args,options)=>{launch={program,args,options};child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>child.emit("exit",0);return child;}});
  t.after(()=>{gateway.close();assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith("aether-rtsp-"));fs.rmSync(dir,{recursive:true,force:true});});
  const teacher={id:"teacher-id",username:"teacher",role:"teacher"},meeting={id:"room-class",mode:"offline",campusRoomId:"201"};
  gateway.start(teacher,"rtsp-test",meeting);
  assert.equal(launch.options.windowsHide,true);assert.ok(!launch.options.shell);
  const frame=fs.readFileSync(path.join(__dirname,"fixtures/campus-frame.jpg"));
  child.stdout.write(frame.subarray(0,80));assert.equal(gateway.latest(teacher,"rtsp-test",meeting.id).frame,null);
  child.stdout.write(frame.subarray(80));const latest=gateway.latest(teacher,"rtsp-test",meeting.id);assert.deepEqual(Buffer.from(latest.frame,"base64"),frame);
  child.stdout.write(Buffer.concat([frame,frame]));assert.equal(gateway.latest(teacher,"rtsp-test",meeting.id).version,3);
  child.stderr.write("fixture-secret");assert.ok(!JSON.stringify(gateway.statuses(teacher.id)).includes("fixture-secret"));
});
