const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");

// 每次测试使用独立目录和随机端口；绝不读取或覆盖 backend/data/store.json。
test("双端课堂闭环、权限、并发与归档", async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aether-test-"));
  const mockAi = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => setTimeout(() => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ choices: [{ message: { content: "已根据课程资料解释事务一致性。" } }] })); }, 180));
  });
  await new Promise(resolve => mockAi.listen(0, "127.0.0.1", resolve));
  const portProbe = http.createServer();
  await new Promise(resolve => portProbe.listen(0, "127.0.0.1", resolve));
  const port = portProbe.address().port;
  await new Promise(resolve => portProbe.close(resolve));
  let child, logs = "";
  function start() {
    child = spawn(process.execPath, [path.join(__dirname, "server.js")], {
      env: { ...process.env, DATA_DIR: dataDir, HOST: "127.0.0.1", PORT: String(port), TEACHER_ACCESS_CODE: "test-access", AI_API_URL: `http://127.0.0.1:${mockAi.address().port}/chat`, AI_API_KEY: "test-placeholder", AI_MODEL: "test-model" },
      windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", d => { logs += d; }); child.stderr.on("data", d => { logs += d; });
  }
  async function ready() {
    for (let i = 0; i < 80; i++) {
      try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return; } catch {}
      await new Promise(r => setTimeout(r, 40));
    }
    throw new Error(logs);
  }
  async function stop() { if (child && child.exitCode === null) { const done = new Promise(r => child.once("exit", r)); child.kill(); await done; } }
  t.after(async () => {
    await stop(); await new Promise(r => mockAi.close(r));
    assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dataDir).startsWith("aether-test-"));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  start(); await ready();
  let meetingId;
  async function api(route, user, body, expected = 200, classId = meetingId) {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", ...(user ? { Authorization: `Bearer ${user.token}` } : {}), ...(classId ? { "X-Classroom-Id": classId } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json();
    assert.equal(response.status, expected, `${route}: ${JSON.stringify(data).slice(0, 300)}`);
    return data;
  }
  let teacher, student, peer, firstReview, otherTeacher, otherMeeting;
  await t.test("会话入口和空课堂", async () => {
    await api("/api/state", null, undefined, 401);
    await api("/api/register", null, { username: "teacher-a", password: "secure-test-123", role: "teacher", name: "测试教师", accessCode: "wrong" }, 403);
    teacher = await api("/api/register", null, { username: "teacher-a", password: "secure-test-123", role: "teacher", name: "测试教师", accessCode: "test-access" }, 201);
    assert.equal(teacher.state.students.length, 0);
    const started = await api("/api/classroom/start", teacher, { title: "闭环验证课", topic: "事务与数据一致性", roomId: "A101" }, 201);
    meetingId = started.meeting.id;
    teacher.code = started.meeting.code;
    assert.equal(started.state.metrics.totalStudents, 0);
    await api("/api/classroom/start", teacher, { title: "误开课", topic: "不应覆盖", roomId: "A101" }, 409);
  });
  await t.test("学生课堂码、唯一身份和加入前权限", async () => {
    student = await api("/api/register", null, { username: "student-a", password: "secure-test-123", role: "student", name: "学生甲" }, 201);
    peer = await api("/api/register", null, { username: "student-b", password: "secure-test-123", role: "student", name: "学生甲" }, 201);
    assert.notEqual(student.user.id, peer.user.id);
    assert.equal(student.state.meeting.code, "");
    await api("/api/classroom/end", student, {}, 403);
    await api("/api/student/telemetry", student, { pageVisible: true }, 409);
    await api("/api/classroom/join", student, { code: "wrong", roomId: "A101" }, 404);
    const joined = await api("/api/classroom/join", student, { code: teacher.code, roomId: "A101" }, 201);
    assert.equal(joined.state.students[0].attention, null);
    assert.equal(joined.state.rooms[0].cameraCount, 0);
    await api("/api/classroom/join", peer, { code: teacher.code, roomId: "A102" }, 201);
  });
  await t.test("遥测、手动反馈、摄像头口径和学生隐私", async () => {
    const reading = { pageVisible: true, windowFocused: true, idleSeconds: 3, cameraEnabled: false, faceDetected: null, faceCount: null };
    await api("/api/student/telemetry", student, { ...reading, studentId: peer.user.id }, 403);
    await api("/api/student/telemetry", student, { ...reading, idleSeconds: -1 }, 400);
    await api("/api/student/telemetry", student, reading, 201);
    await api("/api/feedback", student, { mood: "有疑问", message: "事务一致性需要再讲一次" }, 201);
    const own = await api("/api/state", student);
    assert.deepEqual(own.students.map(s => s.id), [student.user.id]);
    assert.equal(own.events.length, 0); assert.equal(own.latestReport, null);
    const state = await api("/api/state", teacher);
    assert.equal(state.metrics.totalStudents, 2);
    assert.equal(state.rooms.find(r => r.id === "A101").cameraCount, 0);
    assert.equal(state.rooms.find(r => r.id === "A101").activeCount, 1);
  });
  await t.test("SSE 推送按身份裁剪并真实同步", async () => {
    const abort = new AbortController();
    const stream = await fetch(`http://127.0.0.1:${port}/api/stream?token=${student.token}`, { signal: abort.signal });
    const reader = stream.body.getReader();
    try {
      const first = await reader.read();
      const value = new TextDecoder().decode(first.value);
      assert.match(value, /event: state/); assert.ok(!value.includes(peer.user.id));
      await api("/api/feedback", student, { mood: "听懂", message: "已接收到实时同步" }, 201);
      const next = await reader.read();
      assert.match(new TextDecoder().decode(next.value), /已接收到实时同步/);
    } finally { abort.abort(); await reader.cancel().catch(() => {}); }
  });
  await t.test("主动暂离保留到返回，疑问记录不被采样抹去", async () => {
    await api("/api/student/status", student, { status: "away", attention: 0, cameraSignal: "student-away" }, 201);
    const away = await api("/api/student/telemetry", student, { pageVisible: true, windowFocused: true, idleSeconds: 0, cameraEnabled: false }, 201);
    assert.equal(away.student.status, "away");
    await api("/api/student/status", student, { status: "focused", attention: 76, cameraSignal: "student-back" }, 201);
    await api("/api/student/status", student, { status: "confused", attention: 50, cameraSignal: "student-feedback" }, 201);
    const sampled = await api("/api/student/telemetry", student, { pageVisible: true, windowFocused: true, idleSeconds: 0, cameraEnabled: false }, 201);
    assert.equal(sampled.student.selfReport.status, "confused");
    assert.equal(sampled.student.explicitlyAway, false);
  });
  await t.test("未知视觉不沿用旧识别，手动举手仍独立保留", async () => {
    await api("/api/student/telemetry",student,{pageVisible:true,cameraEnabled:true,handRaised:true,sleeping:true},201);
    const lost=await api("/api/student/telemetry",student,{pageVisible:true,cameraEnabled:false,handRaised:null,sleeping:null},201);
    assert.equal(lost.student.handRaised,null);assert.equal(lost.student.sleeping,null);
    await api("/api/student/status",student,{status:"confused",attention:60,handRaised:true,cameraSignal:"raise-hand"},201);
    const manual=await api("/api/student/telemetry",student,{pageVisible:true,cameraEnabled:false,handRaised:null},201);
    assert.equal(manual.student.handRaised,true);
  });
  await t.test("教师资料保存、问答引用和异步并发合并", async () => {
    await api("/api/documents", student, { title: "越权", content: "不能上传" }, 403);
    await api("/api/documents", teacher, { title: "事务一致性", content: "事务一致性使用 atomiccommit 来确保全部成功或全部失败。" }, 201);
    const answerPromise = api("/api/ask", student, { question: "atomiccommit 如何保证事务一致性？" }, 201);
    await new Promise(r => setTimeout(r, 40));
    await api("/api/feedback", peer, { mood: "有疑问", message: "并发期间的反馈不能丢失" }, 201);
    const answer = await answerPromise;
    assert.ok(answer.sources.some(s => s.title === "事务一致性"));
    const state = await api("/api/state", teacher);
    assert.ok(state.feedback.some(f => f.message.includes("不能丢失")));
    assert.equal(state.qaHistory.length, 1);
    assert.equal((await api("/api/state", peer)).qaHistory.length, 0);
  });
  await t.test("教学回应→学生确认→教师结论", async () => {
    const report = await api("/api/ai/analyze", teacher, {}, 201);
    assert.equal(report.engine, "rule-based-v1");
    const created = await api("/api/interventions", teacher, { title: "补充例子", message: "请用订单事务理解一致性。", studentIds: [student.user.id], reportId: report.id }, 201);
    const id = created.intervention.id;
    await api("/api/interventions/respond", peer, { interventionId: id, outcome: "understood" }, 403);
    await api("/api/interventions/respond", student, { interventionId: id, outcome: "need-help" });
    await api("/api/interventions/respond", student, { interventionId: id, outcome: "understood" });
    const closed = await api("/api/interventions/close", teacher, { interventionId: id, note: "追加订单例子后学生确认理解，下次课用练习巩固。" });
    assert.equal(closed.intervention.responses.length, 1);
    assert.equal(closed.state.dataLoop.closed, 1);
    await api("/api/interventions/respond", student, { interventionId: id, outcome: "need-help" }, 409);
  });
  await t.test("投票、屏幕中继和传感器协同", async () => {
    await api("/api/meeting/control", teacher, { action: "startPoll", question: "理解了吗？" }, 201);
    await api("/api/poll/vote", student, { option: "已理解" });
    const poll = await api("/api/poll/close", teacher, {});
    assert.equal(poll.poll.totalAnswers, 1);
    await api("/api/screen/start", teacher, {}, 201);
    await api("/api/screen/frame", teacher, { frame: "data:image/jpeg;base64,/9j/2Q==" }, 202);
    assert.ok((await api("/api/screen/latest", student)).frame);
    await api("/api/screen/stop", teacher, {});
    await api("/api/sensor/event", teacher, { type: "enter", roomId: "A101" }, 201);
    await api("/api/sensor/event", teacher, { type: "invalid", roomId: "A101" }, 400);
  });

  await t.test("独立账号、同名教师同时开课，资料与实时推送隔离", async () => {
    await api("/api/register", null, {username:"teacher-a",password:"secure-test-123",role:"teacher",name:"重复账号",accessCode:"test-access"},409);
    await api("/api/login", null, {username:"teacher-a",password:"incorrect-pass"},401);
    const again = await api("/api/login", null, {username:"teacher-a",password:"secure-test-123"});
    assert.equal(again.user.id, teacher.user.id);
    otherTeacher=await api("/api/register",null,{username:"teacher-b",password:"secure-test-123",role:"teacher",name:"测试教师",accessCode:"test-access"},201);
    assert.notEqual(otherTeacher.user.id,teacher.user.id);
    assert.equal(otherTeacher.state.students.length,0);
    assert.equal(otherTeacher.state.documents.length,0);
    const started=await api("/api/classroom/start",otherTeacher,{title:"教师乙的独立课堂",topic:"账号隔离",roomId:"A101"},201);
    otherMeeting=started.meeting;
    assert.notEqual(otherMeeting.code,teacher.code);
    assert.equal((await api("/api/state",teacher)).meeting.id,meetingId);
    const abort=new AbortController();
    const stream=await fetch(`http://127.0.0.1:${port}/api/stream?token=${otherTeacher.token}`,{signal:abort.signal});
    const reader=stream.body.getReader();
    try {
      const first=new TextDecoder().decode((await reader.read()).value);
      assert.ok(first.includes(otherMeeting.id)); assert.ok(!first.includes(student.user.id));
      await api("/api/comments",teacher,{message:"仅教师甲课堂可见"});
      await api("/api/comments",otherTeacher,{message:"仅教师乙课堂可见"},200,otherMeeting.id);
      const next=new TextDecoder().decode((await reader.read()).value);
      assert.ok(next.includes("仅教师乙课堂可见")); assert.ok(!next.includes("仅教师甲课堂可见"));
    } finally { abort.abort(); await reader.cancel().catch(()=>{}); }
    const isolated=await api("/api/state",otherTeacher);
    assert.equal(isolated.students.length,0);assert.equal(isolated.documents.length,0);
    await api("/api/screen/start",teacher,{},201);
    await api("/api/screen/frame",teacher,{frame:"data:image/jpeg;base64,/9j/2Q=="},202);
    assert.equal((await api("/api/state",otherTeacher)).screenShare.active,false);
    await api("/api/screen/stop",teacher,{});
  });
  await t.test("签到账号去重、关闭后拒绝补签、评论开关与软隐藏", async () => {
    await api("/api/attendance/start",student,{},403);
    const started=await api("/api/attendance/start",teacher,{title:"到课确认",durationSeconds:120});
    const round=started.state.attendance.at(-1);
    await api("/api/attendance/start",teacher,{},409);
    await api("/api/attendance/checkin",student,{attendanceId:round.id});
    await api("/api/attendance/checkin",student,{attendanceId:round.id});
    const state=await api("/api/state",teacher);
    assert.equal(state.attendance.at(-1).responses.length,1);
    assert.equal((await api("/api/state",peer)).attendance.at(-1).responses.length,0);
    await api("/api/attendance/close",teacher,{attendanceId:round.id});
    await api("/api/attendance/checkin",peer,{attendanceId:round.id},409);
    const posted=await api("/api/comments",student,{message:"真实账号评论 <script>"});
    const comment=posted.state.comments.at(-1);
    await api("/api/comments/moderate",student,{commentId:comment.id,action:"hide"},403);
    await api("/api/comments/moderate",teacher,{commentId:comment.id,action:"pin"});
    await api("/api/comments/moderate",teacher,{commentId:comment.id,action:"hide"});
    assert.ok(!(await api("/api/state",student)).comments.some(c=>c.id===comment.id));
    assert.ok((await api("/api/state",teacher)).comments.some(c=>c.id===comment.id && c.hidden));
    await api("/api/comments/moderate",teacher,{commentId:comment.id,action:"restore"});
    await api("/api/comments/settings",teacher,{enabled:false});
    await api("/api/comments",peer,{message:"不应发送"},409);
    await api("/api/comments/settings",teacher,{enabled:true});
  });
  await t.test("切屏去重、后台时长与学生授权屏幕隔离", async () => {
    await api("/api/student/activity",student,{type:"hidden",eventId:"activity-0001"});
    await api("/api/student/activity",student,{type:"hidden",eventId:"activity-0001"});
    await api("/api/student/activity",student,{type:"hidden",eventId:"activity-0002"});
    await api("/api/student/activity",student,{type:"blur",eventId:"activity-0003"});
    await api("/api/student/activity",student,{type:"visible",eventId:"activity-0004"});
    const a=(await api("/api/state",teacher)).students.find(s=>s.id===student.user.id).activity;
    assert.equal(a.switchCount,1); assert.equal(a.blurCount,1); assert.ok(a.awayMs>0); assert.equal(a.hiddenSince,null);
    await api("/api/student-screen/frame",student,{frame:"data:image/jpeg;base64,/9j/2Q=="},409);
    await api("/api/student-screen/start",student,{});
    await api("/api/student-screen/frame",student,{frame:"data:image/jpeg;base64,/9j/2Q=="});
    assert.ok((await api("/api/student-screen/latest?studentId="+student.user.id,teacher)).frame);
    await api("/api/student-screen/latest?studentId="+student.user.id,peer,undefined,403);
    await api("/api/student-screen/latest?studentId="+student.user.id,otherTeacher,undefined,404);
    await api("/api/student-screen/stop",student,{});
    assert.equal((await api("/api/student-screen/latest?studentId="+student.user.id,teacher)).active,false);
  });
  await t.test("结课幂等、历史不可变、旧课堂写入拒绝", async () => {
    // 在隔离测试目录中模拟浏览器失去心跳，不能继续算成在线或摄像头接入。
    const db = new (require("node:sqlite").DatabaseSync)(path.join(dataDir, "aether.sqlite"));
    const stored = JSON.parse(db.prepare("SELECT state_json FROM workspaces WHERE owner_id=?").get(teacher.user.id).state_json);
    stored.students.find(s => s.id === peer.user.id).updatedAt = Date.now() - 60000;
    db.prepare("UPDATE workspaces SET state_json=? WHERE owner_id=?").run(JSON.stringify(stored), teacher.user.id); db.close();
    const presence = await api("/api/state", teacher);
    assert.equal(presence.students.find(s => s.id === peer.user.id).connection, "stale");
    assert.equal(presence.students.find(s => s.id === peer.user.id).attention, null);
    const ended = await api("/api/classroom/end", teacher, {}, 201); firstReview = ended.review;
    assert.equal(firstReview.interventions.length, 1);
    assert.equal(firstReview.attendance.length,1); assert.equal(firstReview.activity.find(s=>s.studentId===student.user.id).switchCount,1);
    await api("/api/classroom/review?meetingId="+firstReview.meeting.id,otherTeacher,undefined,404);
    await api("/api/report/export?meetingId="+firstReview.meeting.id,otherTeacher,undefined,404);
    assert.equal((await api("/api/classrooms",otherTeacher)).classrooms.length,0);
    assert.ok(firstReview.timeline.length > 0);
    assert.equal(firstReview.dataLoop.closed, 1);
    await api("/api/classroom/end", teacher, {});
    assert.equal((await api("/api/classrooms", teacher)).classrooms.length, 1);
    const exported = await api("/api/report/export?meetingId=" + meetingId, teacher);
    assert.match(exported.content, /订单例子/);
    await api("/api/student/telemetry", student, { pageVisible: true }, 409);
    const oldId = meetingId;
    const started = await api("/api/classroom/start", teacher, { title: "下一堂课", topic: "巩固练习", roomId: "A101" }, 201);
    meetingId = started.meeting.id;
    assert.equal(started.state.students.length, 0); assert.equal(started.state.qaHistory.length, 0);
    await api("/api/feedback", student, { mood: "听懂", message: "过期页面" }, 409, oldId);
    assert.deepEqual(await api("/api/classroom/review?meetingId=" + oldId, teacher), firstReview);
  });
  await t.test("模型回答延迟期间结课，回答不污染下一堂课", async () => {
    const current = await api("/api/state", teacher);
    await api("/api/classroom/join", student, { code: current.meeting.code, roomId: "A101" }, 201);
    const delayed = api("/api/ask", student, { question: "atomiccommit 是什么？" }, 409);
    await new Promise(r => setTimeout(r, 40));
    await api("/api/classroom/end", teacher, {}, 201);
    const next = await api("/api/classroom/start", teacher, { title: "第三堂课", topic: "异步隔离", roomId: "A101" }, 201);
    meetingId = next.meeting.id;
    await delayed;
    assert.equal((await api("/api/state", teacher)).qaHistory.length, 0);
  });
  await t.test("重启保留归档，会话失效后需重新登录", async () => {
    await stop(); start(); await ready();
    await api("/api/state", teacher, undefined, 401);
    teacher = await api("/api/login", null, { username: "teacher-a", password: "secure-test-123", role: "teacher" });
    const history = await api("/api/classrooms", teacher);
    assert.equal(history.classrooms.length, 2);
    assert.deepEqual(await api("/api/classroom/review?meetingId=" + firstReview.meeting.id, teacher), firstReview);
    await api("/api/logout", teacher, {});
    await api("/api/state", teacher, undefined, 401);
  });
});

test("存储升级保留旧数据，损坏数据保留可追溯副本", () => {
  const { createStore } = require("./store");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aether-store-test-"));
  try {
    const defaults = { schemaVersion: 7, meeting: { id: "default" }, students: [], feedback: [], qaHistory: [], aiReports: [], classroomEvents: [], sensorEvents: [], interventions: [], pollHistory: [], timeline: [] };
    const storage = createStore(directory, defaults);
    fs.writeFileSync(storage.storePath, JSON.stringify({ schemaVersion: 6, meeting: { id: "legacy" }, students: [{ id: "legacy-student", joinedAt: 1 }], qaHistory: [{ question: "保留的问题" }] }));
    storage.initialize();
    assert.equal(storage.read().students[0].id, "legacy-student");
    assert.equal(storage.read().qaHistory[0].question, "保留的问题");
    assert.equal(storage.read().schemaVersion, 7);
    storage.write(storage.read());
    fs.writeFileSync(storage.storePath, "{broken");
    storage.initialize();
    assert.equal(storage.read().meeting.id, "legacy");
    assert.ok(fs.readdirSync(directory).some(name => name.includes(".corrupt-")));
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("aether-store-test-"));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
