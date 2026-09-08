const path=require("node:path");
const net=require("node:net");
const {execFile}=require("node:child_process");
const {readCatalog}=require("../backend/campus-gateway");
const directory=path.resolve(process.env.DATA_DIR || path.join(__dirname,"../backend/data"));
const filename=process.env.CAMPUS_CONFIG_PATH || path.join(directory,"campus-cameras.json");

async function main(){
  const roomId=process.argv[2];
  if(!roomId)throw new Error("用法：npm run campus:diagnose -- 教室号。只检查指定教室的一台登记设备。");
  const device=readCatalog(filename).devices.find(d=>d.roomId===roomId);
  if(!device)throw new Error("该教室没有登记设备。");
  const tcp=await new Promise(resolve=>{let finished=false;const socket=net.createConnection({host:device.host,port:device.port || 554});const done=reachable=>{if(finished)return;finished=true;socket.destroy();resolve(reachable);};socket.setTimeout(2000,()=>done(false));socket.on("connect",()=>done(true));socket.on("error",()=>done(false));});
  const ffmpeg=await new Promise(resolve=>execFile(process.env.FFMPEG_PATH || "ffmpeg",["-version"],{windowsHide:true,timeout:5000},error=>resolve(!error)));
  console.log(JSON.stringify({roomId,protocol:device.protocol,port:device.port || 554,tcpReachable:tcp,streamPathConfigured:!!device.streamPath,ffmpegAvailable:ffmpeg,videoVerified:false,message:tcp?"端口可达，仍需验证协议、路径与认证。":"端口不可达；检查校园网/VPN与设备端口，不能据此判断密码是否正确。"},null,2));
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
