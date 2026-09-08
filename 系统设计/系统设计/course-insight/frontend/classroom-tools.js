// 课堂管理的界面和设备生命周期。屏幕图像只通过已鉴权接口短暂中继。
const classroomUi = { stream: null, captureTimer: null, viewTimer: null, busy: false, viewing: false, generation: 0, activityQueue: Promise.resolve() };

function setupClassroomTools() {
  byId("authModeButton").addEventListener("click", () => {
    app.authMode = app.authMode === "login" ? "register" : "login";
    byId("registerNameField").classList.toggle("hidden", app.authMode !== "register");
    byId("loginPasswordInput").autocomplete = app.authMode === "register" ? "new-password" : "current-password";
    byId("authModeButton").textContent = app.authMode === "register" ? "已有账号？返回登录" : "没有账号？注册新账号";
    els.loginButton.textContent = app.authMode === "register" ? "注册并进入" : "登录系统";
    els.loginMessage.textContent = "";
    setRole(app.role);
  });
  byId("loginPasswordInput").addEventListener("keydown", e => { if (e.key === "Enter") login(); });
  const teacher = document.createElement("section");
  teacher.id = "classroomManagement";
  teacher.className = "management-panel";
  teacher.innerHTML = `<div class="management-heading"><div><p class="eyebrow">CLASSROOM OPERATIONS</p><h2>课堂管理</h2><p>签到、参与情况与课堂交流，在一个地方处理。</p></div><a class="ghost-button" href="/vision-lab.html" target="_blank" rel="noopener">视觉验证实验室 ↗</a></div>
    <div class="management-tabs" role="tablist" aria-label="课堂管理"><button role="tab" id="tab-attendance" aria-controls="pane-attendance" aria-selected="true" data-tool-tab="attendance">课堂签到</button><button role="tab" id="tab-activity" aria-controls="pane-activity" aria-selected="false" tabindex="-1" data-tool-tab="activity">页面活动</button><button role="tab" id="tab-screens" aria-controls="pane-screens" aria-selected="false" tabindex="-1" data-tool-tab="screens">学生屏幕</button><button role="tab" id="tab-comments" aria-controls="pane-comments" aria-selected="false" tabindex="-1" data-tool-tab="comments">课堂评论</button></div>
    <div id="pane-attendance" role="tabpanel" aria-labelledby="tab-attendance"><div class="management-form"><label>签到名称<input id="attendanceTitle" maxlength="80" value="课堂签到"/></label><label>有效时间<select id="attendanceDuration"><option value="120">2 分钟</option><option value="300">5 分钟</option><option value="600">10 分钟</option></select></label><button id="startAttendance">发起签到</button></div><div id="teacherAttendance"></div></div>
    <div id="pane-activity" role="tabpanel" aria-labelledby="tab-activity" class="hidden"><p class="tool-hint">切屏统计页面进入后台的次数；窗口失焦单独记录。浏览器无法判断访问了哪个应用，也不能据此判定作弊或不专注。</p><div class="table-scroll"><table class="activity-table"><thead><tr><th>学生</th><th>切到后台</th><th>窗口失焦</th><th>后台时长</th><th>页面状态</th></tr></thead><tbody id="activityRows"></tbody></table></div></div>
    <div id="pane-screens" role="tabpanel" aria-labelledby="tab-screens" class="hidden"><p class="tool-hint">仅查看学生主动授权的共享画面。约每秒更新一次，不含声音，学生可随时停止。</p><label>选择学生<select id="studentScreenSelect"><option value="">暂无学生共享</option></select></label><p id="studentScreenViewerStatus" role="status">等待学生主动共享</p><img id="teacherStudentScreen" class="shared-screen hidden" alt="学生主动共享的屏幕"/></div>
    <div id="pane-comments" role="tabpanel" aria-labelledby="tab-comments" class="hidden"><div class="management-heading"><p id="commentsSettingStatus"></p><button id="toggleComments" class="ghost-button">关闭评论区</button></div><div id="teacherComments" class="comments-feed"></div><form id="teacherCommentForm" class="comment-form"><label class="sr-only" for="teacherCommentInput">教师评论</label><input id="teacherCommentInput" maxlength="1000" placeholder="发布课堂讨论或提示…" required/><button>发送</button></form></div>`;
  byId("teacherOverview").after(teacher);
  document.querySelectorAll('nav[data-role="teacher"]').forEach(nav => {
    const link = document.createElement("a"); link.className = "nav-item"; link.href = "/vision-lab.html"; link.target = "_blank"; link.rel = "noopener"; link.textContent = "视觉验证实验室 ↗"; nav.append(link);
  });
  const nav = byId("teacherView").querySelector("nav");
  const anchor = document.createElement("a"); anchor.href = "#classroomManagement"; anchor.className = "nav-item"; anchor.textContent = "签到与课堂管理"; nav.append(anchor);
  const student = document.createElement("section"); student.className = "management-panel student-management";
  student.innerHTML = `<div class="management-heading"><div><p class="eyebrow">CLASSROOM PARTICIPATION</p><h2>课堂互动</h2></div><button id="shareStudentScreen" class="ghost-button">共享我的屏幕</button></div><p id="ownScreenStatus" class="tool-hint">共享前请选择窗口或屏幕；只有本课堂教师可以查看，画面不保存。</p><p id="activityDelivery" class="tool-hint" role="status">本页会记录进入后台、返回和窗口失焦事件。</p><div id="studentAttendance"></div><h3>课堂评论</h3><p id="studentCommentsStatus" class="tool-hint"></p><div id="studentComments" class="comments-feed"></div><form id="studentCommentForm" class="comment-form"><label class="sr-only" for="studentCommentInput">课堂评论</label><input id="studentCommentInput" maxlength="1000" placeholder="和老师交流你的想法…" required/><button>发送</button></form>`;
  byId("studentView").querySelector(".meeting-header").after(student);
  teacher.querySelectorAll("[data-tool-tab]").forEach(button => {
    button.addEventListener("click", () => {
      teacher.querySelectorAll("[data-tool-tab]").forEach(tab => { const active = tab === button; tab.setAttribute("aria-selected", active); tab.tabIndex = active ? 0 : -1; byId("pane-" + tab.dataset.toolTab).classList.toggle("hidden", !active); });
      syncStudentScreenViewer();
    });
    button.addEventListener("keydown", e => { if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return; e.preventDefault(); const tabs = [...teacher.querySelectorAll("[data-tool-tab]")]; const next = e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : (tabs.indexOf(button) + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length; tabs[next].click(); tabs[next].focus(); });
  });
  byId("startAttendance").onclick = e => runAction(e.currentTarget, () => classroomPost("/api/attendance/start", { title: byId("attendanceTitle").value, durationSeconds: Number(byId("attendanceDuration").value) }));
  byId("toggleComments").onclick = e => runAction(e.currentTarget, () => classroomPost("/api/comments/settings", { enabled: !app.dashboard.commentSettings.enabled }));
  for (const role of ["teacher", "student"]) byId(role + "CommentForm").onsubmit = async e => {
    e.preventDefault(); const input = byId(role + "CommentInput");
    await runAction(e.currentTarget.querySelector("button"), async () => { await classroomPost("/api/comments", { message: input.value }); input.value = ""; });
  };
  document.addEventListener("click", e => {
    const button = e.target.closest("[data-classroom-action]"); if (!button) return;
    runAction(button, () => classroomPost(button.dataset.classroomAction, JSON.parse(button.dataset.payload)));
  });
  byId("shareStudentScreen").onclick = e => runAction(e.currentTarget, () => classroomUi.stream ? stopStudentScreen() : startStudentScreen());
  byId("studentScreenSelect").onchange = () => { classroomUi.generation++; byId("teacherStudentScreen").classList.add("hidden"); refreshStudentScreen().catch(showError); };
  document.addEventListener("visibilitychange", () => reportPageActivity(document.hidden ? "hidden" : "visible"));
  window.addEventListener("blur", () => reportPageActivity("blur"));
  window.addEventListener("focus", () => reportPageActivity("focus"));
}

async function classroomPost(route, payload) {
  const result = await request(route, { method: "POST", body: JSON.stringify(payload) });
  if (result.state) renderDashboard(result.state);
  return result;
}
function classroomAction(label, route, payload) {
  return `<button class="ghost-button" data-classroom-action="${route}" data-payload="${escapeHtml(JSON.stringify(payload))}">${escapeHtml(label)}</button>`;
}
function renderClassroomTools(state) {
  const live = state.meeting.status === "live";
  const rounds = state.attendance || [];
  byId("startAttendance").disabled = !live || !state.students.length || rounds.some(r => r.status === "active");
  for (const role of ["teacher", "student"]) {
    byId(role + "Attendance").innerHTML = rounds.length ? rounds.slice().reverse().map(round => {
      const checked = round.responses.some(r => r.studentId === app.user?.id);
      const actions = round.status === "active" ? role === "teacher" ? classroomAction("结束签到", "/api/attendance/close", { attendanceId: round.id }) : checked ? '<span class="attendance-success">已签到</span>' : classroomAction("立即签到", "/api/attendance/checkin", { attendanceId: round.id }) : '<span class="tool-hint">已结束</span>';
      const names = role === "teacher" ? `<details><summary>已签到 ${round.responses.length} / ${round.targetIds.length} 人 · 查看名单</summary><p>已签到：${escapeHtml(round.responses.map(r => r.name).join("、") || "暂无")}</p><p>未签到：${escapeHtml(state.students.filter(s => round.targetIds.includes(s.id) && !round.responses.some(r => r.studentId === s.id)).map(s => s.name).join("、") || "无")}</p></details>` : `<p>${checked ? "签到已记录" : "请在截止时间前完成签到"}</p>`;
      return `<article class="attendance-round"><div><strong>${escapeHtml(round.title)}</strong><small>截止 ${formatTime(round.expiresAt)}</small>${names}</div>${actions}</article>`;
    }).join("") : emptyState("暂无签到", role === "teacher" ? "学生加入后发起限时签到，结果会随课堂归档。" : "教师发起后，可在这里签到。");
    const comments = (state.comments || []).slice().sort((a,b) => Number(b.pinned) - Number(a.pinned) || a.createdAt - b.createdAt);
    byId(role + "Comments").innerHTML = comments.length ? comments.filter(c => role === "teacher" || !c.hidden).map(c => `<article class="class-comment ${c.hidden ? "comment-hidden" : ""}"><header><strong>${escapeHtml(c.name)}</strong><span>${c.role === "teacher" ? "教师 · " : ""}${formatTime(c.createdAt)}${c.pinned ? " · 置顶" : ""}${c.hidden ? " · 已隐藏" : ""}</span></header><p>${escapeHtml(c.message)}</p>${role === "teacher" ? `<div class="comment-actions">${classroomAction(c.pinned ? "取消置顶" : "置顶", "/api/comments/moderate", {commentId:c.id,action:c.pinned?"unpin":"pin"})}${classroomAction(c.hidden ? "恢复" : "隐藏", "/api/comments/moderate", {commentId:c.id,action:c.hidden?"restore":"hide"})}</div>` : ""}</article>`).join("") : emptyState("还没有评论", "围绕课堂内容交流，问题也可以交给智能问答。");
    const disabled = !live || (role === "student" && !state.commentSettings?.enabled);
    byId(role + "CommentForm").querySelectorAll("input,button").forEach(el => { el.disabled = disabled; });
  }
  byId("toggleComments").disabled = !live;
  byId("toggleComments").textContent = state.commentSettings?.enabled ? "关闭评论区" : "开放评论区";
  byId("commentsSettingStatus").textContent = state.commentSettings?.enabled ? "评论区已开放 · 可置顶或隐藏评论" : "评论区已关闭 · 教师仍可发布提示";
  byId("studentCommentsStatus").textContent = state.commentSettings?.enabled ? "评论对本课堂师生可见" : "教师已关闭评论区";
  byId("activityRows").innerHTML = state.students.length ? state.students.map(s => {
    const a = s.activity; const seconds = a ? Math.floor((a.awayMs + (a.hiddenSince == null ? 0 : Date.now() - a.hiddenSince)) / 1000) : 0;
    return `<tr><td>${escapeHtml(s.name)}</td><td>${a?.switchCount ?? "—"}</td><td>${a?.blurCount ?? "—"}</td><td>${a ? seconds + " 秒" : "—"}</td><td>${!a ? "等待事件" : a.hiddenSince == null ? "前台" : "后台"}${s.connection === "stale" ? " · 已断联" : ""}</td></tr>`;
  }).join("") : '<tr><td colspan="5">等待学生加入课堂</td></tr>';
  const select = byId("studentScreenSelect"); const selected = select.value;
  const options = '<option value="">选择正在共享的学生</option>' + (state.studentScreens || []).map(s => `<option value="${escapeHtml(s.studentId)}">${escapeHtml(s.name)}</option>`).join("");
  if (select.innerHTML !== options) { select.innerHTML = options; if ([...select.options].some(o => o.value === selected)) select.value = selected; }
  byId("shareStudentScreen").disabled = !live;
  if (!live) stopStudentScreen(false).catch(showError);
  syncStudentScreenViewer();
}

function reportPageActivity(type) {
  if (app.user?.role !== "student" || app.page !== "studentClass" || app.dashboard?.meeting.status !== "live") return;
  const meetingId = app.dashboard.meeting.id;
  const token = app.token;
  // 串行发送保留 hidden→visible 的事件顺序；失败不伪造为已同步。
  classroomUi.activityQueue = classroomUi.activityQueue.catch(() => {}).then(async () => {
    if (app.token !== token || app.dashboard?.meeting.id !== meetingId) return;
    try {
      await request("/api/student/activity", { method: "POST", body: JSON.stringify({type, eventId: crypto.randomUUID()}), keepalive: true, headers: { "X-Classroom-Id": meetingId } });
      byId("activityDelivery").textContent = "页面活动已同步 · " + formatTime(Date.now());
    } catch (error) { byId("activityDelivery").textContent = "页面活动未同步：" + error.message; }
  });
}
function classroomPageChanged(page) {
  if (page !== "studentClass") stopStudentScreen().catch(showError);
  else reportPageActivity(document.hidden ? "hidden" : "visible");
  if (page !== "teacherClass") { clearInterval(classroomUi.viewTimer); classroomUi.viewTimer = null; classroomUi.generation++; }
  else syncStudentScreenViewer();
}
async function startStudentScreen() {
  if (!navigator.mediaDevices?.getDisplayMedia) throw new Error("当前浏览器无法共享屏幕，请使用桌面版 Chrome 或 Edge，并通过 localhost 或 HTTPS 访问。");
  const token = app.token, meetingId = app.dashboard?.meeting.id;
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 1 }, audio: false });
  if (app.token !== token || app.dashboard?.meeting.id !== meetingId || app.page !== "studentClass" || app.dashboard?.meeting.status !== "live") { stream.getTracks().forEach(track => track.stop()); throw new Error("课堂已变化，请在当前课堂重新选择共享画面。"); }
  classroomUi.stream = stream;
  try {
    await classroomPost("/api/student-screen/start", {});
    const video = document.createElement("video"); video.muted = true; video.srcObject = stream; await video.play();
    const canvas = document.createElement("canvas"); const context = canvas.getContext("2d");
    byId("shareStudentScreen").textContent = "停止共享屏幕";
    byId("ownScreenStatus").textContent = "正在向本课堂教师共享所选画面 · 随时可停止";
    stream.getVideoTracks()[0].addEventListener("ended", () => stopStudentScreen().catch(showError), {once:true});
    classroomUi.captureTimer = setInterval(async () => {
      if (classroomUi.busy || !video.videoWidth || classroomUi.stream !== stream) return;
      classroomUi.busy = true;
      try { canvas.width = Math.min(1280, video.videoWidth); canvas.height = Math.round(video.videoHeight * canvas.width / video.videoWidth); context.drawImage(video,0,0,canvas.width,canvas.height); await request("/api/student-screen/frame", {method:"POST",body:JSON.stringify({frame:canvas.toDataURL("image/jpeg",0.65)})}); }
      catch (error) { if (classroomUi.stream === stream) { await stopStudentScreen(); showError(error); } }
      finally { classroomUi.busy = false; }
    }, 1000);
  } catch (error) { await stopStudentScreen(); throw error; }
}
async function stopStudentScreen(notify = true) {
  const stream = classroomUi.stream; classroomUi.stream = null;
  clearInterval(classroomUi.captureTimer); classroomUi.captureTimer = null;
  stream?.getTracks().forEach(track => track.stop());
  if (byId("shareStudentScreen")) byId("shareStudentScreen").textContent = "共享我的屏幕";
  if (stream) { byId("ownScreenStatus").textContent = "屏幕共享已停止"; if (notify && app.token && app.dashboard?.meeting.status === "live") await classroomPost("/api/student-screen/stop", {}); }
}
function syncStudentScreenViewer() {
  if (app.user?.role !== "teacher" || app.page !== "teacherClass" || byId("pane-screens").classList.contains("hidden")) { clearInterval(classroomUi.viewTimer); classroomUi.viewTimer = null; return; }
  if (!classroomUi.viewTimer) { refreshStudentScreen().catch(showError); classroomUi.viewTimer = setInterval(() => refreshStudentScreen().catch(showError), 1000); }
}
async function refreshStudentScreen() {
  if (classroomUi.viewing) return;
  const studentId = byId("studentScreenSelect").value; const img = byId("teacherStudentScreen"); const generation = classroomUi.generation;
  if (!studentId) { img.classList.add("hidden"); img.removeAttribute("src"); byId("studentScreenViewerStatus").textContent = "请选择正在共享的学生"; return; }
  classroomUi.viewing = true;
  try {
    const data = await request("/api/student-screen/latest?studentId=" + encodeURIComponent(studentId));
    if (generation !== classroomUi.generation || byId("studentScreenSelect").value !== studentId) return;
    img.classList.toggle("hidden", !data.active || !data.frame);
    if (data.active && data.frame) img.src = data.frame; else img.removeAttribute("src");
    byId("studentScreenViewerStatus").textContent = data.active ? "学生授权共享 · 更新于 " + formatTime(data.updatedAt) : "共享已停止或连接已过期";
  } catch (error) { img.classList.add("hidden"); img.removeAttribute("src"); byId("studentScreenViewerStatus").textContent = error.message; }
  finally { classroomUi.viewing = false; }
}

function renderManagementReview(review) {
  let node = byId("reviewManagement");
  if (!node) { node = document.createElement("section"); node.id="reviewManagement"; node.className="management-panel"; byId("reviewView").querySelector(".workspace-footer").before(node); }
  const rounds=review.attendance || [], activity=review.activity || [];
  node.innerHTML='<h2>课堂管理复盘</h2><div class="review-management-summary">'+rounds.map(r=>'<p><strong>'+escapeHtml(r.title)+'</strong> · 已签到 '+r.responses.length+' / '+r.targetIds.length+' 人</p>').join('')+'<p>课堂评论 '+(review.comments || []).filter(c=>!c.hidden).length+' 条</p><div class="table-scroll"><table class="activity-table"><thead><tr><th>学生</th><th>切到后台</th><th>窗口失焦</th><th>后台时长</th></tr></thead><tbody>'+activity.map(a=>'<tr><td>'+escapeHtml(a.name)+'</td><td>'+a.switchCount+'</td><td>'+a.blurCount+'</td><td>'+Math.floor(a.awayMs/1000)+' 秒</td></tr>').join('')+'</tbody></table></div></div>';
}
