const {execFileSync}=require("node:child_process");
const fs=require("node:fs");
const path=require("node:path");
const root=path.resolve(__dirname,"..");
const repositoryRoot=execFileSync("git",["-c","safe.directory="+root,"rev-parse","--show-toplevel"],{cwd:root,encoding:"utf8",windowsHide:true}).trim();
const files=execFileSync("git",["-c","safe.directory="+root,"ls-files","--full-name","-z"],{cwd:root,encoding:"utf8",windowsHide:true}).split("\0").filter(Boolean);
const forbidden=files.filter(file=>/(^|\/)(backend\/data\/|\.runtime\/)|(^|\/)\.env$|campus-cameras\.local\.json$|\.sqlite(-wal|-shm)?$/.test(file));
if(forbidden.length){console.error("发布检查失败：私有数据出现在 Git 跟踪范围：\n"+forbidden.join("\n"));process.exitCode=1;}
else{for(const file of files.filter(f=>/\.(js|json|md|yml|html)$/.test(f))){const text=fs.readFileSync(path.join(repositoryRoot,file),"utf8");if(/rtsp:\/\/[^\s/]+:[^\s@]+@/.test(text)){console.error("发布检查失败：发现含凭据的视频地址，文件："+file);process.exitCode=1;}}if(!process.exitCode)console.log("发布检查通过：私有数据目录和设备凭据 URL 未进入跟踪文件。");}
