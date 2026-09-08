const { randomUUID } = require("node:crypto");

/** 签到、评论与授权屏幕共享。图片仅驻留内存，业务事件进入课堂数据库。 */
function createClassroomTools(ctx) {
  const screens = new Map();
  const screenKey = id => `${ctx.ownerId()}:${id}`;
  const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
  function screenList(store) {
    return store.students.flatMap(student => {
      const frame = screens.get(screenKey(student.id));
      return frame && ctx.database.membership(student.id)?.class_id === store.meeting.id && frame.meetingId === store.meeting.id && Date.now() - frame.updatedAt < 15000
        ? [{ studentId: student.id, name: student.name, updatedAt: frame.updatedAt, version: frame.version }] : [];
    });
  }
  function decorate(store) {
    return {
      attendance: (store.attendance || []).map(round => ({ ...round, status: round.status === "active" && Date.now() > round.expiresAt ? "closed" : round.status })),
      comments: store.comments || [], commentSettings: store.commentSettings || { enabled: true },
      studentScreens: screenList(store),
    };
  }
  async function handle(req, res, route) {
    const p = req.parsedBody || {};
    const store = ctx.read();
    const user = req.session.user;
    const send = data => ctx.send(res, 200, data);
    const save = () => { ctx.write(store); ctx.broadcast(); send({ state: ctx.dashboard(store) }); };

    if (route === "/api/attendance/start" && req.method === "POST") {
      if (store.attendance.some(r => r.status === "active" && r.expiresAt > Date.now())) fail(409, "请先结束当前签到。");
      const duration = Number(p.durationSeconds || 120);
      if (!Number.isInteger(duration) || duration < 30 || duration > 1800) fail(400, "签到时长须为 30–1800 秒。");
      const targetIds = store.students.map(s => s.id);
      if (!targetIds.length) fail(409, "学生加入后才能发起签到。");
      const round = { id: randomUUID(), title: String(p.title || "课堂签到").slice(0, 80), startedAt: Date.now(), expiresAt: Date.now() + duration * 1000, status: "active", targetIds, responses: [] };
      store.attendance.push(round);
      ctx.event(store, { type: "attendance-start", title: "教师发起签到", detail: `${round.title}，限时 ${duration} 秒。`, roomId: "ALL" });
      save(); return true;
    }
    if (route === "/api/attendance/close" && req.method === "POST") {
      const round = store.attendance.find(r => r.id === p.attendanceId);
      if (!round) fail(404, "签到记录不存在。");
      round.status = "closed"; round.closedAt = Date.now();
      ctx.event(store, { type: "attendance-close", title: "教师结束签到", detail: `${round.responses.length}/${round.targetIds.length} 人完成签到。`, roomId: "ALL" });
      save(); return true;
    }
    if (route === "/api/attendance/checkin" && req.method === "POST") {
      const round = store.attendance.find(r => r.id === p.attendanceId);
      if (!round || round.status !== "active" || round.expiresAt <= Date.now()) fail(409, "签到已结束。");
      // 允许签到发起后进入课堂的学生加入本轮名单；按账号去重。
      if (!round.targetIds.includes(user.id)) round.targetIds.push(user.id);
      if (!round.responses.some(r => r.studentId === user.id)) {
        round.responses.push({ studentId: user.id, name: user.name, checkedAt: Date.now() });
        ctx.event(store, { type: "attendance-checkin", title: "学生签到", detail: `${user.name} 已签到。`, roomId: user.roomId });
      }
      save(); return true;
    }
    if (route === "/api/comments/settings" && req.method === "POST") {
      if (typeof p.enabled !== "boolean") fail(400, "请选择开启或关闭评论区。");
      store.commentSettings.enabled = p.enabled;
      ctx.event(store, { type: "comments-settings", title: p.enabled ? "评论区已开放" : "评论区已关闭", detail: "教师更新课堂评论设置。", roomId: "ALL" });
      save(); return true;
    }
    if (route === "/api/comments" && req.method === "POST") {
      if (!store.commentSettings.enabled && user.role !== "teacher") fail(409, "教师已关闭评论区。");
      if (typeof p.message !== "string" || !p.message.trim() || p.message.length > 1000) fail(400, "评论须为 1–1000 字。");
      const last = store.comments.findLast(c => c.userId === user.id);
      if (last && Date.now() - last.createdAt < 1500) fail(429, "发送太快，请稍后再试。");
      store.comments.push({ id: randomUUID(), userId: user.id, name: user.name, role: user.role, message: p.message.trim(), createdAt: Date.now(), hidden: false, pinned: false });
      save(); return true;
    }
    if (route === "/api/comments/moderate" && req.method === "POST") {
      const comment = store.comments.find(c => c.id === p.commentId);
      if (!comment) fail(404, "评论不存在。");
      if (!["hide", "restore", "pin", "unpin"].includes(p.action)) fail(400, "评论管理操作无效。");
      if (["pin", "unpin"].includes(p.action)) comment.pinned = p.action === "pin";
      else comment.hidden = p.action === "hide";
      ctx.event(store, { type: "comment-moderation", title: "教师管理评论", detail: p.action === "hide" ? "已隐藏一条评论，原记录保留。" : "已更新评论显示状态。", roomId: "ALL" });
      save(); return true;
    }
    if (route === "/api/student/activity" && req.method === "POST") {
      const student = store.students.find(s => s.id === user.id);
      if (!/^[a-z0-9-]{8,100}$/i.test(String(p.eventId || "")) || !["hidden", "visible", "blur", "focus"].includes(p.type)) fail(400, "页面活动事件无效。");
      student.activity ||= { switchCount: 0, blurCount: 0, awayMs: 0, hiddenSince: null, recentIds: [] };
      const activity = student.activity;
      if (!activity.recentIds.includes(p.eventId)) {
        activity.recentIds.push(p.eventId); activity.recentIds = activity.recentIds.slice(-200);
        const now = Date.now();
        // hidden 表示页面切到后台；blur 单独统计，防止同一次切换重复计数。
        if (p.type === "hidden" && activity.hiddenSince === null) { activity.switchCount++; activity.hiddenSince = now; }
        if (p.type === "visible" && activity.hiddenSince !== null) { activity.awayMs += now - activity.hiddenSince; activity.hiddenSince = null; }
        if (p.type === "blur") activity.blurCount++;
        activity.lastEventAt = now;
        ctx.event(store, { type: "page-activity", title: "页面活动", detail: `${user.name}：${{ hidden: "切到后台", visible: "返回课堂页面", blur: "窗口失焦", focus: "窗口聚焦" }[p.type]}`, roomId: user.roomId });
      }
      save(); return true;
    }
    if (route.startsWith("/api/student-screen/") && req.method === "POST") {
      const key = screenKey(user.id);
      if (route.endsWith("/start")) {
        screens.set(key, { studentId: user.id, meetingId: store.meeting.id, frame: null, updatedAt: Date.now(), version: 0 });
        ctx.event(store, { type: "student-screen-start", title: "学生开始共享屏幕", detail: `${user.name} 主动授权共享。`, roomId: user.roomId });
        save(); return true;
      }
      if (route.endsWith("/stop")) {
        screens.delete(key);
        ctx.event(store, { type: "student-screen-stop", title: "学生停止共享屏幕", detail: `${user.name} 已停止共享。`, roomId: user.roomId });
        save(); return true;
      }
      if (route.endsWith("/frame")) {
        const share = screens.get(key);
        if (!share || share.meetingId !== store.meeting.id) fail(409, "请先主动开启屏幕共享。");
        if (typeof p.frame !== "string" || p.frame.length > 700000 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(p.frame)) fail(400, "屏幕画面格式或大小无效。");
        Object.assign(share, { frame: p.frame, updatedAt: Date.now(), version: share.version + 1 });
        send({ version: share.version }); return true;
      }
    }
    if (route === "/api/student-screen/latest" && req.method === "GET") {
      const id = new URL(req.url, "http://localhost").searchParams.get("studentId");
      if (!store.students.some(s => s.id === id)) fail(404, "当前课堂没有这位学生。");
      const share = screens.get(screenKey(id));
      const active = share && ctx.database.membership(id)?.class_id === store.meeting.id && share.meetingId === store.meeting.id && Date.now() - share.updatedAt < 15000;
      send(active ? { active: true, frame: share.frame, version: share.version, updatedAt: share.updatedAt } : { active: false }); return true;
    }
    return false;
  }
  function clearStudent(id) { screens.delete(screenKey(id)); }
  function clearClass(store) { for (const student of store.students) clearStudent(student.id); }
  return { handle, decorate, clearStudent, clearClass };
}

module.exports = { createClassroomTools };
