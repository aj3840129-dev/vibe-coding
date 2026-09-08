// 仅在服务器本地执行：给已注册教师授予登记表中指定教室的权限。
const fs=require("node:fs");
const path=require("node:path");
const {DatabaseSync}=require("node:sqlite");
const {readCatalog}=require("../backend/campus-gateway");
const directory=path.resolve(process.env.DATA_DIR || path.join(__dirname,"../backend/data"));
const filename=process.env.CAMPUS_CONFIG_PATH || path.join(directory,"campus-cameras.json");
const [username,roomId]=process.argv.slice(2);
if(!username){console.error("用法：npm run campus:grant -- 教师账号 [教室号]");process.exitCode=1;}
else{
  let db;
  try{
    db=new DatabaseSync(path.join(directory,"aether.sqlite"),{readOnly:true});
    const account=db.prepare("SELECT username, role FROM accounts WHERE username=?").get(username.toLowerCase());
    if(!account || account.role!=="teacher")throw new Error("请先在系统注册该教师账号。");
    const config=readCatalog(filename);let count=0;
    for(const device of config.devices){if(roomId && device.roomId!==roomId)continue;if(!device.allowedUsernames.includes(account.username))device.allowedUsernames.push(account.username);count++;}
    if(!count)throw new Error("没有匹配的登记设备，请先建立私有摄像头配置。");
    fs.writeFileSync(filename+".tmp",JSON.stringify(config,null,2),{mode:0o600});fs.renameSync(filename+".tmp",filename);
    console.log(`已授权 ${count} 台登记设备。刷新教师工作台即可查看；不会输出设备密码。`);
  }catch(error){console.error(error.message);process.exitCode=1;}finally{db?.close();}
}
