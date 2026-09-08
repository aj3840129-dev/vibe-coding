const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const http = require("node:http");
const https = require("node:https");
const { spawn } = require("node:child_process");

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const MAX_FRAME = 2 * 1024 * 1024;

/** 摄像头必须来自本地登记表。请求不能提供任意目标 URL，防止媒体代理变成内网扫描器。 */
function readCatalog(filename) {
  if (!fs.existsSync(filename)) return { version: 1, devices: [] };
  const config = JSON.parse(fs.readFileSync(filename, "utf8"));
  if (!Array.isArray(config.devices)) throw new Error("摄像头配置缺少 devices 数组。");
  const ids = new Set();
  for (const device of config.devices) {
    if (!/^[a-z0-9-]{1,60}$/.test(device.id) || ids.has(device.id) || !net.isIP(device.host)) throw new Error("摄像头配置的 ID 或 IP 无效。");
    if (!Array.isArray(device.allowedUsernames)) throw new Error("摄像头配置缺少授权账号列表。");
    ids.add(device.id);
  }
  return config;
}

function connectionOptions(device) {
  if (!["rtsp", "http", "https"].includes(device.protocol)) fail(400, "请选择 RTSP 或 HTTP(S) JPEG 协议。");
  const port = Number(device.port || (device.protocol === "rtsp" ? 554 : device.protocol === "https" ? 443 : 80));
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail(400, "端口须为 1–65535。");
  if (typeof device.streamPath !== "string" || !device.streamPath.startsWith("/") || device.streamPath.startsWith("//") || /[\r\n\0]/.test(device.streamPath) || device.streamPath.length > 1000) fail(400, "需要设备提供的真实视频流或 JPEG 抓图路径（以 / 开头）。");
  const host = net.isIP(device.host) === 6 ? `[${device.host}]` : device.host;
  const url = new URL(`${device.protocol}://${host}:${port}${device.streamPath}`);
  if (url.hostname.replace(/^\[|\]$/g, "") !== device.host || url.hash || url.username || url.password) fail(400, "视频路径无效。");
  return { url, port };
}

// JPEG 模式适配设备抓图端点。禁止重定向、限制体积和超时，不把 HTTP 错误页当作画面。
function fetchJpeg(device, {signal} = {}) {
  const { url } = connectionOptions(device);
  return new Promise((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    const request = client.get(url, {
      auth: device.username ? `${device.username}:${device.password || ""}` : undefined,
      timeout: 5000, signal,
    }, response => {
      if (response.statusCode !== 200) { response.resume(); reject(new Error(response.statusCode === 401 ? "auth" : "http")); return; }
      let size = 0; const chunks = [];
      response.on("data", chunk => { size += chunk.length; if (size > MAX_FRAME) request.destroy(new Error("size")); else chunks.push(chunk); });
      response.on("error", reject);
      response.on("end", () => {
        const frame = Buffer.concat(chunks);
        if (frame.length < 4 || frame[0] !== 0xff || frame[1] !== 0xd8 || frame.at(-2) !== 0xff || frame.at(-1) !== 0xd9) reject(new Error("jpeg"));
        else resolve(frame);
      });
    });
    const deadline=setTimeout(()=>request.destroy(new Error("timeout")),5000);
    request.on("close",()=>clearTimeout(deadline));
    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", reject);
  });
}

/** 一个设备仅允许一个课堂占用；画面驻留内存，只有当前所有者可以取帧和写入观测。 */
function createGateway({ configPath, ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg", now = Date.now, spawnProcess = spawn }) {
  const streams = new Map();
  const catalog = () => readCatalog(configPath);
  function allowed(user, id) {
    if (user.role !== "teacher") fail(403, "设备访问仅限已授权教师。");
    const device = catalog().devices.find(d => d.id === id && d.allowedUsernames.includes(user.username));
    if (!device) fail(404, "未找到设备或当前账号没有该教室权限。");
    return device;
  }
  function publicDevice(d) {
    const active = streams.get(d.id);
    return { id:d.id, name:d.name, roomId:d.roomId, host:d.host, protocol:d.protocol, port:d.port, streamPath:d.streamPath || "", hasCredentials:!!d.username, configured:!!d.streamPath, occupied:!!active, status:active?.status || "stopped" };
  }
  function list(user) { return catalog().devices.filter(d => d.allowedUsernames.includes(user.username)).map(publicDevice); }
  function configure(user, id, p) {
    allowed(user, id);
    if (streams.has(id)) fail(409, "请先停止设备接入，再修改视频参数。");
    const config = catalog(); const device = config.devices.find(d => d.id === id);
    const next = { ...device, protocol:p.protocol, port:Number(p.port), streamPath:p.streamPath };
    if (p.username !== undefined) { if (typeof p.username !== "string" || p.username.length > 128) fail(400, "设备账号无效。"); next.username=p.username; }
    if (p.password) { if (typeof p.password !== "string" || p.password.length > 256) fail(400,"设备密码过长。"); next.password=p.password; }
    connectionOptions(next);
    Object.assign(device,next);
    const temporary = configPath + ".tmp";
    fs.writeFileSync(temporary, JSON.stringify(config,null,2), { mode:0o600 }); fs.renameSync(temporary,configPath);
    return publicDevice(device);
  }
  async function probe(user,id) {
    const device=allowed(user,id);
    const port=Number(device.port || 554);
    const started=now();
    return new Promise(resolve => {
      const socket=net.createConnection({host:device.host,port}); let finished=false;
      const done=reachable=>{if(finished)return;finished=true;socket.destroy();resolve({reachable,latencyMs:now()-started,checkedAt:now(),message:reachable?"设备端口可达；尚未验证视频协议或账号。":"连接超时或拒绝，请检查校园网/VPN、端口和设备状态。"});};
      socket.setTimeout(1800,()=>done(false)); socket.once("connect",()=>done(true));socket.once("error",()=>done(false));
    });
  }
  function stop(id) {
    const stream=streams.get(id); if(!stream)return;
    streams.delete(id); clearTimeout(stream.timer);clearTimeout(stream.startTimer);stream.child?.kill();stream.abort?.abort();stream.frame=null;
  }
  function owned(user,id,meetingId) {
    allowed(user,id);const stream=streams.get(id);
    if(!stream || stream.ownerId!==user.id || stream.meetingId!==meetingId) fail(409,"当前课堂尚未接入该设备。");
    return stream;
  }
  function start(user,id,meeting) {
    const device=allowed(user,id); const {url}=connectionOptions(device);
    if(meeting.mode==="online" || !["offline","hybrid"].includes(meeting.mode) || meeting.campusRoomId!==device.roomId) fail(409,"请在该教室的线下或混合课堂中接入设备。");
    const existing=streams.get(id);
    if(existing){ if(existing.ownerId!==user.id || existing.meetingId!==meeting.id) fail(409,"设备正被另一课堂使用。"); return snapshot(existing); }
    const stream={ownerId:user.id,meetingId:meeting.id,deviceId:id,roomId:device.roomId,status:"connecting",error:null,frame:null,version:0,updatedAt:null,leaseAt:now(),sampledVersion:0,issuedVersions:new Map()};
    streams.set(id,stream);
    const accept=frame=>{ if(streams.get(id)!==stream)return;stream.frame=frame;stream.version++;stream.updatedAt=now();stream.status="live";stream.error=null;clearTimeout(stream.startTimer); };
    if(device.protocol!=="rtsp"){
      const tick=async()=>{if(streams.get(id)!==stream)return;try{stream.abort=new AbortController();accept(await fetchJpeg(device,{signal:stream.abort.signal}));}catch(error){stream.status="error";stream.frame=null;stream.error=error.message==="auth"?"设备认证失败，请检查凭据。":"未取得有效 JPEG，请检查抓图路径、网络和设备认证方式。";}finally{if(streams.get(id)===stream)stream.timer=setTimeout(tick,1000);}};
      tick();
    } else {
      if(device.username){url.username=device.username;url.password=device.password || "";}
      // 参数数组不经过 shell；凭据只交给本地 FFmpeg，不返回前端或写入日志。
      const child=spawnProcess(ffmpegPath,["-hide_banner","-loglevel","error","-nostdin","-rtsp_transport","tcp","-i",url.href,"-an","-vf","fps=1,scale=1280:720:force_original_aspect_ratio=decrease","-q:v","5","-f","image2pipe","-vcodec","mjpeg","pipe:1"],{windowsHide:true,stdio:["ignore","pipe","pipe"]});
      stream.child=child;let buffer=Buffer.alloc(0);
      child.stdout.on("data",chunk=>{
        buffer=Buffer.concat([buffer,chunk]); if(buffer.length>MAX_FRAME*2){buffer=Buffer.alloc(0);return;}
        let end;
        while((end=buffer.indexOf(Buffer.from([0xff,0xd9])))!==-1){const start=buffer.indexOf(Buffer.from([0xff,0xd8]));if(start>=0 && start<end && end-start<MAX_FRAME)accept(buffer.subarray(start,end+2));buffer=buffer.subarray(end+2);}
      });
      child.stderr.on("data",()=>{}); // 不落盘 FFmpeg 原始错误，防止 RTSP 凭据被写进日志。
      child.on("error",error=>{stream.status="error";stream.frame=null;stream.error=error.code==="ENOENT"?"未找到 FFmpeg，请安装或配置 FFMPEG_PATH。":"视频进程启动失败。";});
      child.on("exit",()=>{if(streams.get(id)===stream){stream.status="error";stream.frame=null;stream.error ||= "视频连接已断开，请检查协议、路径和凭据后重新接入。";}});
      stream.startTimer=setTimeout(()=>{if(streams.get(id)===stream && !stream.version){stream.status="error";stream.error ||= "15 秒内未收到视频，请核对校园网络和 RTSP 路径。";child.kill();}},15000);
    }
    return snapshot(stream);
  }
  function snapshot(stream) {
    const fresh=stream.frame && now()-stream.updatedAt<6000;
    return {deviceId:stream.deviceId,roomId:stream.roomId,status:stream.status==="live"&&!fresh?"stale":stream.status,error:stream.error,version:stream.version,updatedAt:stream.updatedAt};
  }
  function latest(user,id,meetingId) { const stream=owned(user,id,meetingId);stream.leaseAt=now();const info=snapshot(stream);if(info.status==="live"){stream.issuedVersions.set(info.version,now());for(const [v,t] of stream.issuedVersions)if(now()-t>6000)stream.issuedVersions.delete(v);}return {...info,frame:info.status==="live"?stream.frame.toString("base64"):null}; }
  function acceptObservation(user,id,meetingId,version) {
    const stream=owned(user,id,meetingId);
    if(snapshot(stream).status!=="live" || !Number.isInteger(version) || !stream.issuedVersions.has(version) || now()-stream.issuedVersions.get(version)>6000) fail(409,"画面已变化或过期，请基于最新帧重新观测。");
    if(version<=stream.sampledVersion) return false;
    stream.sampledVersion=version;return true;
  }
  const sweep=setInterval(()=>{for(const [id,stream] of streams)if(now()-stream.leaseAt>45000)stop(id);},5000);sweep.unref();
  return {list,allowed,configure,probe,start,latest,acceptObservation,
    stopOwned:(user,id,meetingId)=>{owned(user,id,meetingId);stop(id);},
    stopOwner:owner=>{for(const [id,stream] of streams)if(stream.ownerId===owner)stop(id);},
    statuses:owner=>[...streams.values()].filter(s=>s.ownerId===owner).map(snapshot),
    close:()=>{clearInterval(sweep);for(const id of streams.keys())stop(id);},
  };
}
module.exports={createGateway,readCatalog,connectionOptions,fetchJpeg};
