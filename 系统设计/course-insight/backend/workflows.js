const { randomUUID, randomBytes, timingSafeEqual } = require("node:crypto");

/**
 * 课堂工作流与权限边界。身份来自服务端会话，不能信任请求体中的 teacherId。
 * SQLite 账号拥有独立教学空间；请求上下文决定可访问的课堂与实时数据。
 */
function createWorkflows(ctx) {
  const sessions = new Map();
  const classroomTools = require("./classroom-tools").createClassroomTools(ctx);
  const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
  const text = (value, max, label) => {
    if (typeof value !== "string" || !value.trim() || value.length > max) fail(400, `${label}不能为空，且最多 ${max} 字。`);
    return value.trim();
  };
  const sessionFor = (token) => {
    const session = sessions.get(token);
    if (!session || session.expiresAt < Date.now()) { sessions.delete(token); return null; }
    return session;
  };

  function project(dashboard, session) {
    if (session?.user.role === "teacher") return dashboard;
    const id = session?.user.id;
    const joined = session?.meetingId === dashboard.meeting.id && ctx.database.membership(id)?.class_id === dashboard.meeting.id && dashboard.students.some(s => s.id === id);
    const own = dashboard.students.filter(s => joined && s.id === id);
    const interventions = dashboard.interventions.filter(item => joined && item.studentIds.includes(id)).map(item => ({
      ...item, responses: (item.responses || []).filter(r => r.studentId === id),
      studentIds: [id], baseline: undefined, followup: undefined,
    }));
    return {
      project: dashboard.project,
      meeting: { ...dashboard.meeting, code: joined ? dashboard.meeting.code : "" },
      metrics: joined ? dashboard.metrics : { totalStudents: 0 },
      rooms: joined ? dashboard.rooms.map(r => ({ ...r, averageAttention: undefined })) : [],
      students: own, sensorAttendees: [], events: [], latestReport: null, latestReview: null,
      screenShare: joined ? dashboard.screenShare : { active: false },
      poll: joined && dashboard.poll ? { ...dashboard.poll, answers: { [id]: dashboard.poll.answers?.[id] } } : null,
      interventions, feedback: dashboard.feedback.filter(f => joined && f.studentId === id),
      qaHistory: dashboard.qaHistory.filter(q => joined && q.userId === id),
      documents: joined ? dashboard.documents : [], classHistory: [],
      attendance: joined ? dashboard.attendance.map(round => ({ ...round, targetCount: round.targetIds.length, targetIds: [], responses: round.responses.filter(r => r.studentId === id) })) : [],
      comments: joined ? dashboard.comments.filter(c => !c.hidden) : [], commentSettings: dashboard.commentSettings,
      studentScreens: joined ? dashboard.studentScreens.filter(s => s.studentId === id) : [],
      dataLoop: null,
    };
  }

  function decorate(store, dashboard) {
    const interventions = store.interventions || [];
    return {
      ...dashboard, ...classroomTools.decorate(store), interventions, feedback: store.feedback, qaHistory: store.qaHistory,
      documents: store.knowledgeDocs, reports: store.aiReports, timeline: store.timeline,
      classHistory: (store.archives || []).map(a => ({ meeting: a.meeting, metrics: a.review.metrics, id: a.meeting.id })),
      dataLoop: {
        observed: dashboard.students.filter(s => s.telemetry).length,
        feedback: store.feedback.length, questions: store.qaHistory.length,
        interventions: interventions.length,
        responses: interventions.reduce((n, i) => n + i.responses.length, 0),
        closed: interventions.filter(i => i.status === "closed").length,
      },
    };
  }

  // 每个有效写入记录一份聚合样本，同一秒只更新最后一份，避免遥测膨胀。
  function record(store) {
    if (store.meeting.status !== "live") return;
    store.timeline ||= [];
    const dashboard = ctx.dashboard(store);
    const sample = { createdAt: Date.now(), meetingId: store.meeting.id, metrics: dashboard.metrics };
    if (store.timeline.length && sample.createdAt - store.timeline.at(-1).createdAt < 1000) store.timeline[store.timeline.length - 1] = sample;
    else store.timeline.push(sample);
    // 超长课堂保留首尾并均匀降采样，复盘说明此处是采样均值而非时间加权均值。
    if (store.timeline.length > 7200) store.timeline = store.timeline.filter((_, i) => i % 2 === 0 || i === store.timeline.length - 1);
  }

  function archive(store) {
    const review = ctx.review(store);
    review.meeting = { ...store.meeting, durationMinutes: review.meeting.durationMinutes };
    review.timeline = structuredClone(store.timeline);
    review.interventions = structuredClone(store.interventions);
    review.attendance = structuredClone(store.attendance);
    review.comments = structuredClone(store.comments);
    review.activity = store.students.map(s => ({ studentId: s.id, name: s.name, switchCount: s.activity?.switchCount || 0, blurCount: s.activity?.blurCount || 0, awayMs: s.activity?.awayMs || 0 }));
    review.dataLoop = decorate(store, ctx.dashboard(store)).dataLoop;
    const observed = store.timeline.filter(s => s.metrics.observedStudents > 0);
    review.metrics.snapshotAttention = review.metrics.averageAttention;
    review.metrics.averageAttention = observed.length ? Math.round(observed.reduce((n, s) => n + s.metrics.averageAttention, 0) / observed.length) : null;
    review.metrics.sampleCount = observed.length;
    review.highlights[0] = `本节课 ${review.meeting.durationMinutes} 分钟；有效过程样本 ${observed.length} 份，参与参考值为样本均值。`;
    review.highlights.push(`教学回应 ${store.interventions.length} 次，学生确认 ${review.dataLoop.responses} 份，教师完成跟进 ${review.dataLoop.closed} 次。`);
    store.classReviews.push(review);
    store.archives.push(structuredClone({
      meeting: store.meeting, review, students: store.students, feedback: store.feedback,
      qaHistory: store.qaHistory, interventions: store.interventions, reports: store.aiReports,
      events: store.classroomEvents, sensorEvents: store.sensorEvents, pollHistory: store.pollHistory,
      poll: store.poll, documents: store.knowledgeDocs, attendance: store.attendance, comments: store.comments,
    }));
    return review;
  }

  function exportReview(archive) {
    const r = archive.review;
    return [
      `# ${r.meeting.title} · 课堂复盘`, `主题：${r.meeting.topic}`,
      `时间：${new Date(r.meeting.startedAt).toLocaleString("zh-CN")} — ${new Date(r.meeting.endedAt).toLocaleString("zh-CN")}`,
      `过程样本均值：${r.metrics.averageAttention ?? "无有效样本"}；样本数：${r.metrics.sampleCount}`,
      "## 课堂结论", ...r.highlights.map(h => `- ${h}`),
      "## 教学回应与确认", ...r.interventions.flatMap(i => [
        `### ${i.title}`, i.message, `状态：${i.status === "closed" ? "已完成跟进" : "待跟进"}`,
        ...i.responses.map(a => `- ${a.studentName}：${a.outcome === "understood" ? "已理解" : "仍需帮助"}${a.message ? `；${a.message}` : ""}`),
        i.note ? `教师结论：${i.note}` : "",
      ]),
      "## 签到", ...(r.attendance || []).map(round => `- ${round.title}：${round.responses.length}/${round.targetIds.length} 人签到`),
      "## 页面活动", ...(r.activity || []).map(s => `- ${s.name}：切到后台 ${s.switchCount} 次，窗口失焦 ${s.blurCount} 次，后台停留 ${Math.round(s.awayMs / 1000)} 秒`),
      "## 评论区", ...(r.comments || []).filter(c => !c.hidden).map(c => `- ${c.name}：${c.message}`),
      "## 课程问答", ...archive.qaHistory.flatMap(q => [`### ${q.question}`, q.answer, `来源：${q.sources.map(s => s.title).join("、") || "无匹配资料"}`]),
      "## 统计说明", "人脸与姿态使用预训练视觉模型；参与参考值与风险是规则估计。过程均值为聚合样本均值，不是模型准确率。传感器事件为手动模拟。",
    ].join("\n\n");
  }

  async function prepare(req, res, route) {
    if (route === "/api/health") return false;
    if (["/api/login", "/api/register"].includes(route) && req.method === "POST") {
      const p = await ctx.readJson(req);
      if (!p || typeof p !== "object" || Array.isArray(p)) fail(400, "请求应为 JSON 对象。");
      const user = route === "/api/register" ? await ctx.database.register(p) : await ctx.database.login(p);
      const membership = user.role === "student" ? ctx.database.membership(user.id) : null;
      const ownerId = user.role === "teacher" ? user.id : membership?.owner_id || null;
      ctx.setOwner(ownerId);
      const store = ctx.read();
      const storedUser = store.users.find(u => u.id === user.id);
      if (storedUser) user.roomId = storedUser.roomId;
      if (ownerId && !storedUser) { store.users.push(user); ctx.write(store); }
      const token = randomBytes(32).toString("hex");
      const session = { user, token, ownerId, meetingId: membership?.class_id || null, expiresAt: Date.now() + 12 * 60 * 60 * 1000 };
      sessions.set(token, session);
      res.session = session;
      ctx.send(res, route === "/api/register" ? 201 : 200, { user, token, authMode: "account", state: ctx.dashboard(store) });
      return true;
    }
    const query = new URL(req.url, "http://localhost").searchParams;
    const token = String(req.headers.authorization || "").replace(/^Bearer /, "") || (route === "/api/stream" ? query.get("token") : "");
    const session = sessionFor(token);
    if (!session) fail(401, "会话已失效，请重新登录。");
    req.session = session;
    res.session = session;
    const user = session.user;
    ctx.setOwner(session.ownerId);
    if (route === "/api/classroom/join" && req.method === "POST" && user.role === "student") {
      const joining = await ctx.readJson(req);
      req.parsedBody = joining;
      const classroom = ctx.database.classByCode(joining.code);
      if (!classroom) fail(404, "课堂码无效，或课堂已经结束。");
      ctx.setOwner(classroom.owner_id);
    }
    if (route === "/api/session" && req.method === "GET") { ctx.send(res, 200, { user, state: ctx.dashboard(ctx.read()) }); return true; }
    if (route === "/api/logout" && req.method === "POST") {
      sessions.delete(token);
      classroomTools.clearStudent(user.id);
      if (session.user.role === "student") {
        const store = ctx.read();
        const student = store.students.find(s => s.id === session.user.id);
        if (student && store.meeting.status === "live") {
          student.status = "away"; student.attention = 0; student.explicitlyAway = true;
          if (student.telemetry) student.telemetry.cameraEnabled = false;
          ctx.event(store, { type: "student-leave", title: "学生退出课堂", detail: user.name + " 已退出工作空间。", roomId: user.roomId });
          ctx.write(store); ctx.broadcast();
        }
      }
      ctx.closeSession(session);
      ctx.send(res, 200, { ok: true }); return true;
    }
    const store = ctx.read();
    const teacherRoutes = ["/api/attendance/start", "/api/attendance/close", "/api/comments/settings", "/api/comments/moderate", "/api/student-screen/latest", "/api/classroom/start", "/api/classroom/end", "/api/meeting/control", "/api/sensor/event", "/api/ai/analyze", "/api/poll/close", "/api/screen/start", "/api/screen/frame", "/api/screen/stop", "/api/classroom/review", "/api/classrooms", "/api/report/export", "/api/interventions", "/api/interventions/close"];
    if ((teacherRoutes.includes(route) || (route === "/api/documents" && req.method !== "GET")) && user.role !== "teacher") fail(403, "此操作仅限教师。");
    const studentRoutes = ["/api/attendance/checkin", "/api/student/activity", "/api/student-screen/start", "/api/student-screen/stop", "/api/student-screen/frame", "/api/classroom/join", "/api/student/status", "/api/student/telemetry", "/api/feedback", "/api/poll/vote", "/api/ask", "/api/interventions/respond"];
    if (studentRoutes.includes(route) && user.role !== "student") fail(403, "此操作仅限学生。");
    if (req.method === "POST") {
      const p = await ctx.readJson(req);
      if (!p || typeof p !== "object" || Array.isArray(p)) fail(400, "请求应为 JSON 对象。");
      for (const key of ["studentId", "userId", "teacherId"]) if (p[key] && p[key] !== user.id) fail(403, "不能以其他成员的身份提交数据。");
      Object.assign(p, { studentId: user.id, userId: user.id, teacherId: user.id, teacherName: user.name, name: user.name, operator: user.name });
      if (!["/api/classroom/start", "/api/classroom/join", "/api/documents"].includes(route)) {
        if (req.headers["x-classroom-id"] !== store.meeting.id) fail(409, "课堂已经变化，请刷新后重新操作。");
        if (store.meeting.status !== "live" && route !== "/api/classroom/end") fail(409, "本节课堂已结束，不能再提交课堂数据。");
      }
      if (user.role === "student" && route !== "/api/classroom/join") {
        const student = store.students.find(s => s.id === user.id && s.joinedAt);
        if (!student || session.meetingId !== store.meeting.id || ctx.database.membership(user.id)?.class_id !== store.meeting.id) fail(409, "请先使用课堂码加入当前课堂。");
        p.roomId = student.roomId;
      }
      if (route === "/api/classroom/start") {
        if (store.meeting.status === "live") fail(409, "已有进行中的课堂，请返回课堂或先结束本节课。");
        text(p.title, 120, "课堂名称"); text(p.topic, 200, "课堂主题");
      }
      if (["/api/classroom/start", "/api/classroom/join", "/api/sensor/event"].includes(route) && !store.rooms.some(r => r.id === p.roomId)) fail(400, "教室不存在。");
      if (route === "/api/classroom/join") {
        if (store.meeting.status !== "live" || String(p.code || "").toUpperCase().trim() !== store.meeting.code.toUpperCase()) fail(404, "课堂未开设，或课堂码不正确。");
        ctx.closeSession(session);
        session.ownerId = ctx.ownerId();
        session.meetingId = store.meeting.id; session.user.roomId = p.roomId;
        ctx.database.bindStudent(user.id, session.ownerId, session.meetingId);
      }
      if (route === "/api/student/status") {
        if (!["focused", "confused", "tired", "away"].includes(p.status)) fail(400, "状态无效。");
        if (typeof p.attention !== "number" || !Number.isFinite(p.attention) || p.attention < 0 || p.attention > 100) fail(400, "参与参考值应在 0 到 100 之间。");
      }
      if (route === "/api/student/telemetry") {
        for (const key of ["idleSeconds", "brightness", "motion", "faceCount", "faceScore"]) if (p[key] != null && (typeof p[key] !== "number" || !Number.isFinite(p[key]) || p[key] < 0)) fail(400, "遥测数值无效：" + key);
        for (const key of ["pageVisible", "windowFocused", "cameraEnabled", "faceDetected", "handRaised", "sleeping"]) if (p[key] != null && typeof p[key] !== "boolean") fail(400, "遥测标记无效：" + key);
        if (p.faceCount > 50 || p.faceScore > 1 || p.idleSeconds > 86400 || p.brightness > 255 || p.motion > 255) fail(400, "遥测数值超出范围。");
      }
      if (route === "/api/sensor/event" && !["enter", "leave"].includes(p.type)) fail(400, "传感器事件仅支持进入或离开。");
      if (route === "/api/ask") text(p.question, 2000, "问题");
      if (route === "/api/feedback") { text(p.mood, 40, "反馈类型"); text(p.message, 1000, "反馈内容"); }
      if (route === "/api/meeting/control" && ["poll", "startPoll"].includes(p.action) && store.poll?.status === "active") fail(409, "请先结束当前投票。");
      if (route === "/api/meeting/control" && !["muteAll", "startPoll", "shareMaterial"].includes(p.action)) fail(400, "课堂控制操作不存在。");
      req.parsedBody = p;
    }
    if (user.role === "student" && ["/api/screen/latest", "/api/documents"].includes(route) && (session.meetingId !== store.meeting.id || ctx.database.membership(user.id)?.class_id !== store.meeting.id)) fail(403, "加入课堂后才能查看课堂内容。");
    if (await classroomTools.handle(req, res, route)) return true;
    if (route === "/api/classrooms" && req.method === "GET") { ctx.send(res, 200, { classrooms: decorate(store, ctx.dashboard(store)).classHistory.reverse() }); return true; }
    if (route === "/api/documents") {
      if (req.method === "GET") { ctx.send(res, 200, { documents: store.knowledgeDocs }); return true; }
      if (req.method === "POST") {
        const p = req.parsedBody;
        if (store.knowledgeDocs.length >= 200) fail(409, "资料库已达 200 篇上限。");
        const document = { id: randomUUID(), title: text(p.title, 120, "资料标题"), content: text(p.content, 50000, "资料内容"), createdAt: Date.now(), author: user.name };
        store.knowledgeDocs.push(document); ctx.write(store); ctx.broadcast(); ctx.send(res, 201, { document, state: ctx.dashboard(store) }); return true;
      }
    }
    if (route === "/api/interventions" && req.method === "POST") {
      const p = req.parsedBody;
      const studentIds = p.studentIds == null ? store.students.map(s => s.id) : p.studentIds;
      if (!Array.isArray(studentIds) || !studentIds.length || studentIds.some(id => !store.students.some(s => s.id === id))) fail(400, "请选择至少一位当前课堂学生。");
      const item = { id: randomUUID(), meetingId: store.meeting.id, title: text(p.title, 120, "回应标题"), message: text(p.message, 1000, "回应内容"), kind: String(p.kind || "check_in"), reportId: p.reportId || null, studentIds: [...new Set(studentIds)], responses: [], status: "open", createdAt: Date.now(), baseline: ctx.dashboard(store).metrics };
      store.interventions.push(item); ctx.event(store, { type: "intervention", title: "教师发起教学回应", detail: item.title, roomId: "ALL" }); ctx.write(store); ctx.broadcast(); ctx.send(res, 201, { intervention: item, state: ctx.dashboard(store) }); return true;
    }
    if (["/api/interventions/respond", "/api/interventions/close"].includes(route) && req.method === "POST") {
      const p = req.parsedBody;
      const item = store.interventions.find(i => i.id === p.interventionId);
      if (!item) fail(404, "教学回应不存在。");
      if (item.status !== "open") fail(409, "该跟进已结束。");
      if (route.endsWith("respond")) {
        if (!item.studentIds.includes(user.id)) fail(403, "这条教学回应不属于你。");
        if (!["understood", "need-help"].includes(p.outcome)) fail(400, "请选择理解情况。");
        item.responses = item.responses.filter(r => r.studentId !== user.id);
        item.responses.push({ studentId: user.id, studentName: user.name, outcome: p.outcome, message: String(p.message || "").slice(0, 500), createdAt: Date.now() });
        const student = store.students.find(s => s.id === user.id);
        student.selfReport = { status: p.outcome === "understood" ? "focused" : "confused", createdAt: Date.now(), signal: "intervention-response" };
        ctx.event(store, { type: "intervention-response", title: "学生确认教学效果", detail: `${user.name}：${p.outcome === "understood" ? "已理解" : "仍需帮助"}`, roomId: user.roomId });
      } else {
        item.note = text(p.note, 1000, "跟进结论"); item.status = "closed"; item.closedAt = Date.now(); item.followup = ctx.dashboard(store).metrics;
        ctx.event(store, { type: "intervention-close", title: "教师完成教学跟进", detail: item.note, roomId: "ALL" });
      }
      ctx.write(store); ctx.broadcast(); ctx.send(res, 200, { intervention: item, state: ctx.dashboard(store) }); return true;
    }
    if (route === "/api/classroom/end" && req.method === "POST") {
      if (store.meeting.status === "draft") fail(409, "尚未开课。");
      if (store.meeting.status === "ended") { ctx.send(res, 200, { review: store.classReviews.at(-1), state: ctx.dashboard(store) }); return true; }
      record(store);
      classroomTools.clearClass(store);
      for (const student of store.students) {
        if (student.activity?.hiddenSince != null) { student.activity.awayMs += Date.now() - student.activity.hiddenSince; student.activity.hiddenSince = null; }
      }
      for (const round of store.attendance) { if (round.status === "active") { round.status = "closed"; round.closedAt = Date.now(); } }
      // 冻结结课时的连接状态，防止归档后重新将掉线成员计算成在线。
      const finalStudents = ctx.dashboard(store).students;
      store.students = store.students.map(student => finalStudents.find(s => s.id === student.id) || student);
      store.meeting.status = "ended"; store.meeting.endedAt = Date.now();
      if (store.poll?.status === "active") { store.poll.status = "closed"; store.poll.closedAt = Date.now(); }
      ctx.resetScreen();
      ctx.event(store, { type: "classroom-end", title: "课堂结束并归档", detail: `${user.name} 完成本节课堂。`, roomId: "ALL" });
      const review = archive(store); ctx.write(store); ctx.broadcast(); ctx.send(res, 201, { review, state: ctx.dashboard(store) }); return true;
    }
    if (["/api/classroom/review", "/api/report/export"].includes(route) && req.method === "GET") {
      const id = query.get("meetingId");
      const saved = id ? store.archives.find(a => a.meeting.id === id) : (route.endsWith("review") || store.meeting.status === "ended" ? store.archives.at(-1) : null);
      if (id && !saved) fail(404, "未找到该课堂归档。");
      if (route.endsWith("review")) { if (!saved) fail(404, "还没有已结束的课堂复盘。"); ctx.send(res, 200, saved.review); return true; }
      if (saved) { ctx.send(res, 200, { filename: `${saved.meeting.id}-review.md`, content: exportReview(saved) }); return true; }
    }
    return false;
  }
  return { prepare, project, decorate, record, sessionFor };
}

module.exports = { createWorkflows };
