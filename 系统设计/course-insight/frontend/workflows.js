// 课堂工作流：导航、教学跟进、资料管理与历史复盘。
// 保持采样与模型逻辑在 app.js，本文件只处理用户行动与业务记录。
const workflowUi = { noticeTimer: null, memberKey: "", historyLoading: false, lastNotice: null };
const byId = id => document.getElementById(id);

function notifyUser(message, isError = false) {
  const node = byId("appNotice");
  node.textContent = message;
  node.className = "app-notice" + (isError ? " error" : "");
  clearTimeout(workflowUi.noticeTimer);
  workflowUi.noticeTimer = setTimeout(() => node.classList.add("hidden"), 6000);
}
function showError(error) { notifyUser(error?.message || "操作失败，请重试。", true); }

async function runAction(button, operation) {
  if (button.disabled) return;
  button.disabled = true;
  try { await operation(); }
  catch (error) { showError(error); }
  finally { button.disabled = false; }
}

function syncNavigation(page) {
  document.querySelectorAll("[data-page]").forEach(node => {
    node.classList.toggle("active", node.dataset.page === page);
    if (node.dataset.page === page) node.setAttribute("aria-current", "page");
    else node.removeAttribute("aria-current");
  });
  document.title = ({ login: "欢迎", teacherHome: "教师工作台", teacherClass: "实时课堂", review: "课堂复盘", studentJoin: "加入课堂", studentClass: "我的课堂" }[page] || "课堂") + " · 智课云舱";
}

async function navigatePage(page) {
  if (!app.user) { showPage("login"); return; }
  if (app.user.role === "student" && !["studentJoin", "studentClass"].includes(page)) return;
  if (app.user.role === "teacher" && !["teacherHome", "teacherClass", "review"].includes(page)) return;
  if (page === "teacherClass" && app.dashboard?.meeting.status !== "live") { notifyUser("请先开设课堂，或从历史记录查看复盘。"); showPage("teacherHome"); return; }
  if (page === "studentClass" && (!app.dashboard?.students.some(s => s.id === app.user.id) || app.dashboard.meeting.status !== "live")) { notifyUser("请先输入课堂码加入课堂。"); showPage("studentJoin"); return; }
  if (page === "review") {
    const review = await request("/api/classroom/review");
    app.selectedReview = review;
    renderReview(review);
  }
  showPage(page);
  window.scrollTo({ top: 0, behavior: "instant" });
}

// 使用原生 dialog 保留键盘焦点与 Escape 行为，替代阻断浏览器的 prompt。
function textDialog(title, label, initial = "") {
  return new Promise(resolve => {
    const dialog = document.createElement("dialog");
    dialog.className = "workflow-dialog";
    dialog.innerHTML = `<form method="dialog"><h2>${escapeHtml(title)}</h2><label>${escapeHtml(label)}<textarea maxlength="1000" rows="4" required>${escapeHtml(initial)}</textarea></label><div class="dialog-actions"><button value="cancel" formnovalidate class="ghost-button">取消</button><button value="confirm">确认</button></div></form>`;
    document.body.append(dialog);
    dialog.addEventListener("close", () => { const result = dialog.returnValue === "confirm" ? dialog.querySelector("textarea").value.trim() : null; dialog.remove(); resolve(result); }, { once: true });
    dialog.showModal();
    dialog.querySelector("textarea").focus();
  });
}

function setupWorkflows() {
  document.querySelectorAll("[data-page]").forEach(button => button.addEventListener("click", event => { event.preventDefault(); navigatePage(button.dataset.page).catch(showError); }));
  byId("resumeClassButton").addEventListener("click", () => navigatePage("teacherClass").catch(showError));
  byId("refreshHistoryButton").addEventListener("click", () => loadClassHistory().catch(showError));
  byId("createInterventionButton").addEventListener("click", event => runAction(event.currentTarget, createIntervention));
  byId("saveDocumentButton").addEventListener("click", event => runAction(event.currentTarget, saveDocument));
  byId("loginNameInput").addEventListener("keydown", event => { if (event.key === "Enter") login(); });
  byId("joinCodeInput").addEventListener("keydown", event => { if (event.key === "Enter") joinClassroom(); });
  // 老页面保留的异步操作统一显示可操作错误，避免只在控制台留下拒绝记录。
  window.addEventListener("unhandledrejection", event => { event.preventDefault(); showError(event.reason); });
  document.addEventListener("click", event => {
    const room = event.target.closest("[data-room-id]");
    if (room) { app.teacherRoomFilter = room.dataset.roomId; els.teacherSensorRoomSelect.value = room.dataset.roomId; renderDashboard(app.dashboard); }
  });
  document.addEventListener("keydown", event => {
    if (["Enter", " "].includes(event.key) && event.target.matches("[data-room-id]")) { event.preventDefault(); event.target.click(); }
  });
  syncNavigation("login");
}

function renderWorkflows(dashboard) {
  const live = dashboard.meeting.status === "live";
  byId("resumeClassButton").classList.toggle("hidden", !live);
  els.startClassButton.disabled = live;
  ["endClassButton", "teacherReportButton", "pollButton", "muteAllButton", "screenShareButton", "shareMaterialButton", "teacherSensorEnterButton", "teacherSensorLeaveButton", "createInterventionButton"].forEach(id => { byId(id).disabled = !live; });
  byId("studentTeacherName").textContent = dashboard.meeting.teacherName || "课堂教师";
  byId("studentTopicText").textContent = dashboard.meeting.topic;
  if (app.user?.role === "student" && dashboard.meeting.notice && workflowUi.lastNotice !== dashboard.meeting.notice.id && app.page === "studentClass") {
    workflowUi.lastNotice = dashboard.meeting.notice.id;
    notifyUser(dashboard.meeting.notice.message);
  }
  const loop = dashboard.dataLoop;
  if (loop) byId("teacherLoopSummary").innerHTML = `<span>教学反馈闭环</span><strong>${loop.closed} / ${loop.interventions} 次跟进完成</strong><small>${loop.feedback} 条反馈 · ${loop.questions} 次提问 · ${loop.responses} 份效果确认</small>`;
  const memberKey = dashboard.students.map(s => s.id + s.name).join("|");
  if (memberKey !== workflowUi.memberKey) {
    const selected = byId("interventionStudentSelect").value;
    byId("interventionStudentSelect").innerHTML = '<option value="all">全体学生</option>' + dashboard.students.map(s => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)} · ${escapeHtml(s.roomId)}</option>`).join("");
    if ([...byId("interventionStudentSelect").options].some(o => o.value === selected)) byId("interventionStudentSelect").value = selected;
    workflowUi.memberKey = memberKey;
  }
  const items = dashboard.interventions || [];
  renderInterventions(byId("teacherInterventionList"), items, "teacher");
  renderInterventions(byId("studentInterventionList"), items, "student");
  const documents = dashboard.documents || [];
  byId("teacherDocumentList").innerHTML = documents.length ? documents.map(d => `<details class="document-item"><summary>${escapeHtml(d.title)}<span>${d.content.length} 字</span></summary><p>${escapeHtml(d.content)}</p></details>`).join("") : emptyState("还没有资料", "粘贴讲义后，学生提问可检索并引用其中的内容。");
  const questions = dashboard.qaHistory || [];
  byId("studentQaHistory").innerHTML = questions.length ? questions.slice().reverse().map(q => `<details class="qa-history-item"><summary>${escapeHtml(q.question)}</summary><p>${escapeHtml(q.answer)}</p><small>${formatTime(q.createdAt)} · ${escapeHtml(q.engine)}</small></details>`).join("") : emptyState("还没有提问记录", "问题与回答会保存在本节课堂中。");
  if (app.role === "teacher") renderHistory(dashboard.classHistory || []);
}

function responseLabel(outcome) { return outcome === "understood" ? "已理解" : "仍需帮助"; }

function renderInterventions(node, items, role, readonly = false) {
  if (!items.length) { node.innerHTML = emptyState("暂无教学回应", "课堂反馈产生后，教师可发起讲解或关怀，学生确认是否得到帮助。"); return; }
  node.innerHTML = items.slice().reverse().map(item => {
    const responses = item.responses || [];
    const own = responses.find(r => r.studentId === app.user?.id);
    const pending = item.studentIds.length - responses.length;
    const status = item.status === "closed" ? "跟进完成" : `${Math.max(0, pending)} 人待确认`;
    const buttons = readonly || item.status === "closed" ? "" : role === "student" ? `<div class="intervention-actions"><button data-response="understood" data-id="${item.id}" class="${own?.outcome === "understood" ? "selected" : "ghost-button"}">我已理解</button><button data-response="need-help" data-id="${item.id}" class="${own?.outcome === "need-help" ? "selected" : "ghost-button"}">仍需帮助</button></div>` : `<button class="ghost-button" data-close-intervention="${item.id}">记录跟进结论</button>`;
    return `<article class="intervention-item"><div class="intervention-heading"><strong>${escapeHtml(item.title)}</strong><span class="subtle-tag">${escapeHtml(status)}</span></div><p>${escapeHtml(item.message)}</p><small>${formatTime(item.createdAt)}${role === "teacher" ? ` · ${responses.length}/${item.studentIds.length} 人已反馈` : own ? ` · 你反馈：${responseLabel(own.outcome)}` : " · 等待你的反馈"}</small>${role === "teacher" && responses.length ? `<ul class="response-list">${responses.map(r => `<li>${escapeHtml(r.studentName)}：${responseLabel(r.outcome)}</li>`).join("")}</ul>` : ""}${item.note ? `<p class="followup-note">跟进结论：${escapeHtml(item.note)}</p>` : ""}${buttons}</article>`;
  }).join("");
  node.querySelectorAll("[data-response]").forEach(button => button.addEventListener("click", () => runAction(button, async () => {
    const data = await request("/api/interventions/respond", { method: "POST", body: JSON.stringify({ interventionId: button.dataset.id, outcome: button.dataset.response }) });
    renderDashboard(data.state); notifyUser("你的理解情况已同步给教师。");
  })));
  node.querySelectorAll("[data-close-intervention]").forEach(button => button.addEventListener("click", () => runAction(button, async () => {
    const note = await textDialog("记录跟进结论", "本次调整的效果与下一步安排");
    if (!note) return;
    const data = await request("/api/interventions/close", { method: "POST", body: JSON.stringify({ interventionId: button.dataset.closeIntervention, note }) });
    renderDashboard(data.state); notifyUser("跟进结论已保存，将进入课堂复盘。");
  })));
}

async function createIntervention() {
  const select = byId("interventionActionSelect");
  const studentId = byId("interventionStudentSelect").value;
  const message = byId("interventionNoteInput").value.trim();
  if (!message) throw new Error("请填写给学生的说明。");
  const data = await request("/api/interventions", { method: "POST", body: JSON.stringify({
    title: select.selectedOptions[0].textContent, kind: select.value, message,
    ...(studentId === "all" ? {} : { studentIds: [studentId] }), reportId: app.dashboard.latestReport?.id,
  }) });
  renderDashboard(data.state);
  byId("interventionNoteInput").value = "";
  byId("interventionMessage").textContent = "已发送，等待学生确认理解情况。";
}

async function saveDocument() {
  const title = byId("documentTitleInput").value.trim();
  const content = byId("documentContentInput").value.trim();
  if (!title || !content) throw new Error("请填写资料标题与正文。");
  const data = await request("/api/documents", { method: "POST", body: JSON.stringify({ title, content }) });
  renderDashboard(data.state);
  byId("documentTitleInput").value = "";
  byId("documentContentInput").value = "";
  byId("documentMessage").textContent = "资料已保存，后续课程问答将纳入检索。";
}

async function loadClassHistory() {
  if (!app.token || app.user?.role !== "teacher" || workflowUi.historyLoading) return;
  workflowUi.historyLoading = true;
  try { const data = await request("/api/classrooms"); renderHistory(data.classrooms); }
  finally { workflowUi.historyLoading = false; }
}

function renderHistory(items) {
  byId("teacherHistoryList").innerHTML = items.length ? items.slice().sort((a, b) => b.meeting.endedAt - a.meeting.endedAt).map(item => `<article class="history-item"><div class="history-icon">课</div><div><h3>${escapeHtml(item.meeting.title)}</h3><p>${escapeHtml(item.meeting.topic)}</p><small>${new Date(item.meeting.endedAt).toLocaleString("zh-CN")} · ${item.metrics.totalStudents} 名学生</small></div><button class="ghost-button" data-review-id="${escapeHtml(item.id)}">查看复盘</button></article>`).join("") : emptyState("暂无历史课堂", "完成第一堂课后，在这里回看课堂分析与反馈。");
  byId("teacherHistoryList").querySelectorAll("[data-review-id]").forEach(button => button.addEventListener("click", () => runAction(button, async () => {
    const review = await request("/api/classroom/review?meetingId=" + encodeURIComponent(button.dataset.reviewId));
    app.selectedReview = review; renderReview(review); showPage("review"); window.scrollTo(0, 0);
  })));
}

function renderReviewExtras(review) {
  renderManagementReview(review);
  renderInterventions(byId("reviewInterventionList"), review.interventions || [], "teacher", true);
  const samples = (review.timeline || []).filter(s => s.metrics.observedStudents > 0);
  if (!samples.length) { byId("reviewTimelineChart").innerHTML = emptyState("没有有效过程样本", "未采集到学生状态时，不生成虚构曲线。"); return; }
  const start = samples[0].createdAt, duration = Math.max(1, samples.at(-1).createdAt - start);
  const points = samples.map(s => `${40 + (s.createdAt - start) / duration * 600},${170 - Math.min(100, Math.max(0, s.metrics.averageAttention)) * 1.4}`).join(" ");
  byId("reviewTimelineChart").innerHTML = `<svg viewBox="0 0 680 210" role="img" aria-label="课堂参与参考值趋势，${samples.length} 份有效样本"><g stroke="#e2e8f0">${[0, 50, 100].map(n => `<line x1="40" x2="645" y1="${170 - n * 1.4}" y2="${170 - n * 1.4}"/><text x="8" y="${174 - n * 1.4}" stroke="none" fill="#64748b" font-size="11">${n}</text>`).join("")}</g><polyline points="${points}" fill="none" stroke="#4f67dc" stroke-width="3" stroke-linejoin="round"/>${samples.length === 1 ? `<circle cx="40" cy="${170 - samples[0].metrics.averageAttention * 1.4}" r="4" fill="#4f67dc"/>` : ""}<text x="40" y="200" font-size="12" fill="#64748b">${formatTime(start)}</text><text x="645" y="200" text-anchor="end" font-size="12" fill="#64748b">${formatTime(samples.at(-1).createdAt)}</text></svg><p class="section-copy">${samples.length} 份聚合样本 · 过程均值 ${review.metrics.averageAttention ?? "—"}；曲线反映规则估计，不代表真实学习成效。</p>`;
}
