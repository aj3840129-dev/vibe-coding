const app = {
  role: "teacher",
  authMode: "login",
  user: null,
  token: null,
  page: "login",
  selectedReview: null,
  dashboard: null,
  stream: null,
  teacherRoomFilter: "A101",
  screenShare: {
    stream: null,
    captureTimer: null,
    viewerTimer: null,
    uploading: false,
    lastVersion: 0,
  },
  camera: {
    stream: null,
    timer: null,
    previousFrame: null,
  },
  monitor: {
    timer: null,
    posting: false,
    generation: 0,
    lastActivityAt: Date.now(),
    lastFrame: null,
    faceDetector: null,
    mediaPipeDetector: null,
    mediaPipeLoading: false,
    mediaPipeUnavailable: false,
    mediaPipeError: "",
    poseDetector: null,
    poseLoading: false,
    poseUnavailable: false,
    poseError: "",
    poseLastTs: 0,
    handRaiseSince: null,
    handRaisedActive: false,
    faceLandmarker: null,
    faceLandmarkerLoading: false,
    faceLandmarkerUnavailable: false,
    faceLandmarkerError: "",
    sleepSince: null,
    sleepActive: false,
    lastSleepDetail: "",
  },
};

const mediaPipeFaceConfig = {
  // 本地托管，避免 CDN 在国内网络加载失败（原 jsdelivr @0.10.22 版本不存在导致 404）。
  moduleUrl: "/vendor/mediapipe/vision_bundle.mjs",
  wasmRoot: "/vendor/mediapipe/wasm",
  modelUrl: "/vendor/mediapipe/models/blaze_face_short_range.tflite",
};

const mediaPipePoseConfig = {
  moduleUrl: "/vendor/mediapipe/vision_bundle.mjs",
  wasmRoot: "/vendor/mediapipe/wasm",
  modelUrl: "/vendor/mediapipe/models/pose_landmarker_lite.task",
  // 举手需持续满足判据的时间窗（毫秒），用于去抖，避免瞬间抬手误报。
  holdMs: 1500,
};

const mediaPipeSleepConfig = {
  moduleUrl: "/vendor/mediapipe/vision_bundle.mjs",
  wasmRoot: "/vendor/mediapipe/wasm",
  modelUrl: "/vendor/mediapipe/models/face_landmarker.task",
  // 双眼闭合程度阈值（blendshape eyeBlink，0~1，越大越闭）。
  blinkThreshold: 0.5,
  // 需持续闭眼多久才发出提示（毫秒），避免正常眨眼误报。
  holdMs: 3000,
};

// Face 与 Pose 检测器共享同一 wasm 实例，其内部时间戳空间是共用的。
// 必须让所有 detectForVideo 调用共用一个严格单调递增的时钟，否则会 timestamp mismatch。
let visionClock = 0;
function nextVisionTs() {
  visionClock = Math.max(Date.now(), visionClock + 1);
  return visionClock;
}

const els = {
  loginView: document.querySelector("#loginView"),
  teacherHomeView: document.querySelector("#teacherHomeView"),
  studentJoinView: document.querySelector("#studentJoinView"),
  teacherView: document.querySelector("#teacherView"),
  reviewView: document.querySelector("#reviewView"),
  studentView: document.querySelector("#studentView"),
  teacherRoleButton: document.querySelector("#teacherRoleButton"),
  studentRoleButton: document.querySelector("#studentRoleButton"),
  loginNameInput: document.querySelector("#loginNameInput"),
  loginRoomSelect: document.querySelector("#loginRoomSelect"),
  roomLoginField: document.querySelector("#roomLoginField"),
  loginButton: document.querySelector("#loginButton"),
  loginMessage: document.querySelector("#loginMessage"),
  logoutButtons: document.querySelectorAll(".logout-button"),
  classTitleInput: document.querySelector("#classTitleInput"),
  classTopicInput: document.querySelector("#classTopicInput"),
  classRoomSelect: document.querySelector("#classRoomSelect"),
  startClassButton: document.querySelector("#startClassButton"),
  teacherClassPreview: document.querySelector("#teacherClassPreview"),
  joinCodeInput: document.querySelector("#joinCodeInput"),
  joinRoomSelect: document.querySelector("#joinRoomSelect"),
  joinClassButton: document.querySelector("#joinClassButton"),
  joinMessage: document.querySelector("#joinMessage"),
  studentClassPreview: document.querySelector("#studentClassPreview"),
  teacherMeetingTitle: document.querySelector("#teacherMeetingTitle"),
  studentMeetingTitle: document.querySelector("#studentMeetingTitle"),
  meetingCode: document.querySelector("#meetingCode"),
  teacherStreamStatus: document.querySelector("#teacherStreamStatus"),
  studentStreamStatus: document.querySelector("#studentStreamStatus"),
  teacherActiveStudents: document.querySelector("#teacherActiveStudents"),
  teacherFocusRate: document.querySelector("#teacherFocusRate"),
  teacherRiskScore: document.querySelector("#teacherRiskScore"),
  teacherVideoGrid: document.querySelector("#teacherVideoGrid"),
  teacherRoomGrid: document.querySelector("#teacherRoomGrid"),
  teacherStudentList: document.querySelector("#teacherStudentList"),
  teacherEventList: document.querySelector("#teacherEventList"),
  teacherReportButton: document.querySelector("#teacherReportButton"),
  teacherReportBox: document.querySelector("#teacherReportBox"),
  endClassButton: document.querySelector("#endClassButton"),
  exportReportButton: document.querySelector("#exportReportButton"),
  backToTeacherButton: document.querySelector("#backToTeacherButton"),
  reviewExportButton: document.querySelector("#reviewExportButton"),
  reviewTitle: document.querySelector("#reviewTitle"),
  reviewSummaryCards: document.querySelector("#reviewSummaryCards"),
  reviewHighlights: document.querySelector("#reviewHighlights"),
  statusChart: document.querySelector("#statusChart"),
  roomChart: document.querySelector("#roomChart"),
  eventChart: document.querySelector("#eventChart"),
  muteAllButton: document.querySelector("#muteAllButton"),
  pollButton: document.querySelector("#pollButton"),
  teacherPollPanel: document.querySelector("#teacherPollPanel"),
  studentPollPanel: document.querySelector("#studentPollPanel"),
  screenShareButton: document.querySelector("#screenShareButton"),
  teacherSharePanel: document.querySelector("#teacherSharePanel"),
  teacherShareStatus: document.querySelector("#teacherShareStatus"),
  teacherScreenPreview: document.querySelector("#teacherScreenPreview"),
  teacherScreenCanvas: document.querySelector("#teacherScreenCanvas"),
  studentScreenPanel: document.querySelector("#studentScreenPanel"),
  studentShareTitle: document.querySelector("#studentShareTitle"),
  studentShareStatus: document.querySelector("#studentShareStatus"),
  studentScreenImage: document.querySelector("#studentScreenImage"),
  shareMaterialButton: document.querySelector("#shareMaterialButton"),
  teacherSensorRoomSelect: document.querySelector("#teacherSensorRoomSelect"),
  teacherSensorEnterButton: document.querySelector("#teacherSensorEnterButton"),
  teacherSensorLeaveButton: document.querySelector("#teacherSensorLeaveButton"),
  teacherSignalSummary: document.querySelector("#teacherSignalSummary"),
  cameraPreview: document.querySelector("#cameraPreview"),
  cameraCanvas: document.querySelector("#cameraCanvas"),
  cameraButton: document.querySelector("#cameraButton"),
  focusedButton: document.querySelector("#focusedButton"),
  confusedButton: document.querySelector("#confusedButton"),
  tooFastButton: document.querySelector("#tooFastButton"),
  raiseHandButton: document.querySelector("#raiseHandButton"),
  awayButton: document.querySelector("#awayButton"),
  backButton: document.querySelector("#backButton"),
  cameraReading: document.querySelector("#cameraReading"),
  handRaiseDebug: document.querySelector("#handRaiseDebug"),
  sleepDebug: document.querySelector("#sleepDebug"),
  studentAttention: document.querySelector("#studentAttention"),
  studentStatusText: document.querySelector("#studentStatusText"),
  studentMonitorEvidence: document.querySelector("#studentMonitorEvidence"),
  studentSignalGrid: document.querySelector("#studentSignalGrid"),
  studentPeerGrid: document.querySelector("#studentPeerGrid"),
  studentQuestionInput: document.querySelector("#studentQuestionInput"),
  studentAskButton: document.querySelector("#studentAskButton"),
  studentAnswerBox: document.querySelector("#studentAnswerBox"),
};

// 每次请求携带当前会话及课堂版本，避免旧标签页写入下一节课。
async function request(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...options.headers };
  if (app.token) headers.Authorization = 'Bearer ' + app.token;
  if (app.dashboard?.meeting?.id) headers["X-Classroom-Id"] = app.dashboard.meeting.id;
  let response;
  try {
    response = await fetch(path, { ...options, headers, signal: options.signal || AbortSignal.timeout(35000) });
  } catch (error) {
    throw new Error(error.name === "TimeoutError" ? "请求超时，请检查连接后重试。" : "无法连接课堂服务，请检查服务是否启动。");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || "请求失败，请重试。");
    error.status = response.status;
    if (response.status === 401 && app.token && path !== "/api/login") clearSession();
    throw error;
  }
  return data;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function statusText(status) {
  return {
    focused: "专注",
    confused: "疑惑",
    tired: "疲劳",
    away: "离开",
  }[status] || "未知";
}

function statusClass(status) {
  return {
    focused: "focused",
    confused: "confused",
    tired: "tired",
    away: "away",
  }[status] || "confused";
}

function formatTime(value) {
  return value ? new Date(value).toLocaleTimeString("zh-CN", { hour12: false }) : "--";
}

function signalClass(active) {
  if (active === null || active === undefined) return "neutral";
  return active ? "ok" : "warn";
}

function signalText(value, positive, negative, unknown = "未接入") {
  if (value === null || value === undefined) return unknown;
  return value ? positive : negative;
}

function telemetrySignalItems(student) {
  const telemetry = student.telemetry || {};
  return [
    {
      label: "页面",
      value: signalText(telemetry.pageVisible, "可见", "切离"),
      active: telemetry.pageVisible,
    },
    {
      label: "窗口",
      value: signalText(telemetry.windowFocused, "聚焦", "失焦"),
      active: telemetry.windowFocused,
    },
    {
      label: "交互",
      value: telemetry.idleSeconds === undefined ? "等待" : `${telemetry.idleSeconds}s`,
      active: telemetry.idleSeconds === undefined ? null : telemetry.idleSeconds <= 25,
    },
    {
      label: "摄像头",
      value: signalText(telemetry.cameraEnabled, "已接入", "未开启"),
      active: telemetry.cameraEnabled,
    },
    {
      label: "人脸",
      value: signalText(telemetry.faceDetected, `${telemetry.faceCount || 1} 人`, "未检测", "浏览器不支持"),
      active: telemetry.faceDetected,
    },
    {
      label: "AI引擎",
      value: telemetry.faceEngine || (telemetry.cameraEnabled ? "加载中" : "未启用"),
      active: telemetry.cameraEnabled ? telemetry.faceEngine !== "fallback-frame-signal" : null,
    },
    {
      label: "画面",
      value:
        telemetry.brightness === null || telemetry.brightness === undefined
          ? "未采样"
          : `亮${telemetry.brightness} / 动${telemetry.motion ?? "--"}`,
      active: telemetry.brightness === null || telemetry.brightness === undefined ? null : telemetry.brightness >= 24,
    },
  ];
}

function renderSignalGrid(student) {
  return telemetrySignalItems(student)
    .map(
      (item) => `
        <div class="signal-chip ${signalClass(item.active)}">
          <span>${escapeHtml(item.label)}</span>
          <strong>${escapeHtml(item.value)}</strong>
        </div>
      `
    )
    .join("");
}

function emptyState(title, detail) {
  return `
    <div class="empty-state">
      <strong>${escapeHtml(title)}</strong>
      <span>${escapeHtml(detail)}</span>
    </div>
  `;
}

function stopAutoMonitor() {
  app.monitor.generation += 1;
  if (app.monitor.timer) {
    window.clearInterval(app.monitor.timer);
    app.monitor.timer = null;
  }
}

function stopCamera() {
  stopVisionSampling();
  if (app.camera.timer) {
    window.clearInterval(app.camera.timer);
    app.camera.timer = null;
  }
  if (app.camera.stream) {
    app.camera.stream.getTracks().forEach((track) => track.stop());
    app.camera.stream = null;
  }
  app.camera.previousFrame = null;
  app.monitor.mediaPipeError = "";
  app.monitor.handRaiseSince = null;
  app.monitor.handRaisedActive = false;
  app.monitor.sleepSince = null;
  app.monitor.sleepActive = false;
  els.cameraPreview.srcObject = null;
  els.cameraPreview.closest(".camera-panel")?.classList.remove("camera-active");
  els.cameraButton.disabled = false;
  els.cameraButton.textContent = "开启摄像头";
}

function setRole(role) {
  app.role = role;
  els.teacherRoleButton.classList.toggle("active", role === "teacher");
  els.studentRoleButton.classList.toggle("active", role === "student");
  els.roomLoginField.classList.add("hidden");
  document.querySelector("#teacherAccessCodeField")?.classList.toggle("hidden", role !== "teacher" || app.authMode !== "register");
}

function showPage(page) {
  const pages = {
    login: els.loginView,
    teacherHome: els.teacherHomeView,
    studentJoin: els.studentJoinView,
    teacherClass: els.teacherView,
    review: els.reviewView,
    studentClass: els.studentView,
  };
  app.page = page;
  classroomPageChanged(page);
  campusPageChanged(page);
  syncNavigation(page);
  Object.entries(pages).forEach(([name, node]) => {
    node.classList.toggle("hidden", name !== page);
  });
  if (page === "studentClass") startAutoMonitor();
  else stopAutoMonitor();
  if (page !== "studentClass") stopCamera();
  if (page === "teacherHome") loadClassHistory().catch(showError);
}

function showEntryForRole(role) {
  showPage(role === "teacher" ? "teacherHome" : "studentJoin");
}

async function login() {
  els.loginButton.disabled = true;
  els.loginButton.textContent = "登录中";
  els.loginMessage.textContent = "";
  try {
    const data = await request(app.authMode === "register" ? "/api/register" : "/api/login", {
      method: "POST",
      body: JSON.stringify({
        role: app.role,
        username: byId("loginUsernameInput").value.trim(),
        password: byId("loginPasswordInput").value,
        name: els.loginNameInput.value.trim(),
        roomId: els.loginRoomSelect.value,
        accessCode: document.querySelector("#teacherAccessCodeInput")?.value || "",
      }),
    });
    byId("loginPasswordInput").value = "";
    app.user = data.user;
    app.token = data.token;
    saveSession();
    renderDashboard(data.state);
    showEntryForRole(app.user.role);
    connectStream();
  } catch (error) {
    const networkHint = error instanceof TypeError ? "无法连接后端，请先运行 npm start，并通过终端显示的地址访问。" : error.message;
    els.loginMessage.textContent = networkHint;
  } finally {
    els.loginButton.disabled = false;
    els.loginButton.textContent = app.authMode === "register" ? "注册并进入" : "登录系统";
  }
}

// 使用标签页会话：同一浏览器可同时打开教师和学生，互不覆盖。
function saveSession() {
  sessionStorage.setItem("aether-session", JSON.stringify({ user: app.user, token: app.token }));
}
function clearSession() {
  sessionStorage.removeItem("aether-session");
  app.stream?.close();
  app.stream = null;
  stopAutoMonitor();
  stopCamera();
  stopScreenViewer();
  stopScreenShare({ notifyServer: false }).catch(() => {});
  app.user = null;
  app.token = null;
  app.dashboard = null;
  app.selectedReview = null;
  showPage("login");
}
async function restoreSession() {
  const cached = sessionStorage.getItem("aether-session");
  if (!cached) return;
  try {
    const saved = JSON.parse(cached);
    app.user = saved.user;
    app.token = saved.token;
    const data = await request("/api/session");
    app.user = data.user;
    app.role = data.user.role;
    renderDashboard(data.state);
    saveSession();
    const joined = data.state.students.some(student => student.id === app.user.id);
    showPage(app.role === "student" && joined && data.state.meeting.status === "live" ? "studentClass" : app.role === "teacher" ? "teacherHome" : "studentJoin");
    connectStream();
  } catch {
    clearSession();
    els.loginMessage.textContent = "会话已过期，请重新登录。";
  }
}
async function logout() {
  try {
    if (app.screenShare.stream) await stopScreenShare();
    await request("/api/logout", { method: "POST", body: "{}" });
  } catch (error) { showError(error); }
  finally { clearSession(); setRole("teacher"); }
}

function connectStream() {
  if (app.stream) app.stream.close();
  setStreamStatus("连接中", false);
  app.stream = new EventSource("/api/stream?token=" + encodeURIComponent(app.token || ""));
  app.stream.addEventListener("open", () => {
    setStreamStatus("实时连接", true);
  });
  app.stream.addEventListener("state", (event) => {
    try { renderDashboard(JSON.parse(event.data)); } catch (error) { showError(error); }
  });
  app.stream.addEventListener("error", () => {
    setStreamStatus("重连中", false);
  });
}

async function reconnectStream() {
  setStreamStatus("重连中", false);
  try {
    const data = await request("/api/state");
    renderDashboard(data);
    connectStream();
  } catch {
    setStreamStatus("连接失败", false);
  }
}

function setStreamStatus(text, online) {
  [els.teacherStreamStatus, els.studentStreamStatus].forEach((node) => {
    node.textContent = text;
    node.className = online ? "live-pill online" : "live-pill";
    node.setAttribute("aria-pressed", online ? "true" : "false");
  });
}

async function startClassroom() {
  if (!app.user || app.user.role !== "teacher") return;
  els.startClassButton.disabled = true;
  els.startClassButton.textContent = "开课中";
  try {
    const data = await request("/api/classroom/start", {
      method: "POST",
      body: JSON.stringify({
        teacherId: app.user.id,
        teacherName: app.user.name,
        mode: byId("classModeSelect").value,
        campusRoomId: byId("campusRoomSelect").value || null,
        title: els.classTitleInput.value.trim(),
        topic: els.classTopicInput.value.trim(),
        roomId: els.classRoomSelect.value,
      }),
    });
    app.teacherRoomFilter = data.meeting.roomId;
    els.teacherSensorRoomSelect.value = data.meeting.roomId;
    renderDashboard(data.state);
    app.selectedReview = null;
    showPage("teacherClass");
    connectStream();
  } finally {
    els.startClassButton.disabled = app.dashboard?.meeting.status === "live";
    els.startClassButton.textContent = "开设课堂";
  }
}

async function joinClassroom() {
  if (!app.user || app.user.role !== "student") return;
  els.joinClassButton.disabled = true;
  els.joinClassButton.textContent = "加入中";
  els.joinMessage.textContent = "";
  try {
    const data = await request("/api/classroom/join", {
      method: "POST",
      body: JSON.stringify({
        studentId: app.user.id,
        name: app.user.name,
        roomId: els.joinRoomSelect.value,
        code: els.joinCodeInput.value.trim(),
      }),
    });
    app.user = data.user;
    saveSession();
    renderDashboard(data.state);
    showPage("studentClass");
    connectStream();
  } catch (error) {
    els.joinMessage.textContent = error.message;
  } finally {
    els.joinClassButton.disabled = false;
    els.joinClassButton.textContent = "加入课堂";
  }
}

function renderDashboard(dashboard) {
  const previousMeetingId = app.dashboard?.meeting?.id;
  app.dashboard = dashboard;
  const me = dashboard.students.find(student => student.id === app.user?.id);
  if (app.user?.role === "student" && app.page === "studentClass" && (!me || dashboard.meeting.status !== "live" || (previousMeetingId && previousMeetingId !== dashboard.meeting.id))) {
    showPage("studentJoin");
    notifyUser(dashboard.meeting.status === "ended" ? "本节课堂已结束，感谢参与。" : "课堂已更新，请使用新的课堂码加入。");
  }
  renderMeetingHeader(dashboard);
  renderClassPreviews(dashboard);
  renderTeacher(dashboard);
  renderStudent(dashboard);
  renderPoll(dashboard.poll);
  syncScreenShare(dashboard.screenShare);
  if (dashboard.latestReview && !app.selectedReview) renderReview(dashboard.latestReview);
  renderWorkflows(dashboard);
  renderClassroomTools(dashboard);
  renderCampus(dashboard);
}

function renderMeetingHeader(dashboard) {
  els.teacherMeetingTitle.textContent = dashboard.meeting.title;
  els.studentMeetingTitle.textContent = dashboard.meeting.title;
  els.meetingCode.textContent = dashboard.meeting.code ? `课堂码 ${dashboard.meeting.code}` : "等待开课";
}

function renderClassPreviews(dashboard) {
  const meeting = dashboard.meeting;
  const classCode = meeting.code || (meeting.status === "live" ? "输入课堂码加入" : "待开课");
  const statusText = meeting.status === "live" ? `进行中 · ${formatTime(meeting.startedAt)}` : meeting.status === "ended" ? "本节已结束 · 复盘已归档" : "尚未开课";
  if (els.teacherSensorRoomSelect && !app.teacherRoomFilter) {
    app.teacherRoomFilter = meeting.roomId || els.teacherSensorRoomSelect.value || "A101";
  }
  const teacherPreview = `
    <div class="class-code">${escapeHtml(classCode)}</div>
    <p>${escapeHtml(meeting.title)}</p>
    <small>${escapeHtml(meeting.topic)} · ${statusText}</small>
  `;
  els.teacherClassPreview.innerHTML = teacherPreview;
  els.studentClassPreview.innerHTML = teacherPreview;
  // 实时推送仅更新展示，保留用户正在输入的课堂码、标题和主题。
}

function classroomViewMetrics(room, students) {
  const totalStudents = students.filter(student => Number.isFinite(student.attention)).length;
  const activeStudents = students.filter((student) => student.status !== "away").length;
  const focusedStudents = students.filter((student) => student.status === "focused").length;
  const lowEngagement = students.filter((student) => ["confused", "tired", "away"].includes(student.status)).length;
  return {
    present: Math.max(Number(room?.sensorCount || 0), activeStudents),
    focusRate: totalStudents ? Math.round((focusedStudents / totalStudents) * 100) : 0,
    riskScore: totalStudents ? Math.min(100, Math.round((lowEngagement / totalStudents) * 72 + Number(room?.anomaly || 0) * 10)) : Math.min(100, Number(room?.anomaly || 0) * 18),
  };
}

function renderTeacher(dashboard) {
  const { metrics } = dashboard;
  const selectedRoomId = app.teacherRoomFilter || els.teacherSensorRoomSelect.value || dashboard.meeting.roomId || "A101";
  const selectedRoom = dashboard.rooms.find((room) => room.id === selectedRoomId) || dashboard.rooms[0] || {};
  const roomStudents = dashboard.students.filter((student) => student.roomId === selectedRoom.id);
  const sensorAttendees = (dashboard.sensorAttendees || []).filter((attendee) => attendee.roomId === selectedRoom.id);
  const roomViewMetrics = classroomViewMetrics(selectedRoom, roomStudents);
  els.teacherActiveStudents.textContent = roomViewMetrics.present;
  els.teacherFocusRate.textContent = roomStudents.some(student => Number.isFinite(student.attention)) ? `${roomViewMetrics.focusRate}%` : "—";
  els.teacherRiskScore.textContent = roomStudents.some(student => Number.isFinite(student.attention)) ? roomViewMetrics.riskScore : "—";

  const studentTiles = roomStudents
        .map(
          (student) => `
            <article class="video-tile ${statusClass(student.status)}${student.sleeping ? " sleeping" : ""}">
              <div class="video-face">${escapeHtml(student.name.slice(0, 1))}</div>
              <div class="tile-meta">
                <strong>${escapeHtml(student.name)}</strong>
                <span>${statusText(student.status)} · 参与参考 ${student.attention ?? "—"}</span>
              </div>
              ${student.handRaised ? '<b class="hand-badge">举手</b>' : ""}
              ${student.sleeping ? '<b class="sleep-badge">持续闭眼</b>' : ""}
            </article>
          `
        )
        .join("");
  const sensorTiles = sensorAttendees
    .map(
      (attendee) => `
        <article class="video-tile sensor-only">
          <div class="video-face">门</div>
          <div class="tile-meta">
            <strong>${escapeHtml(attendee.name)}</strong>
            <span>${escapeHtml(attendee.roomId)} · 传感器进入 · 未接入摄像头</span>
          </div>
        </article>
      `
    )
    .join("");
  els.teacherVideoGrid.innerHTML = studentTiles || sensorTiles
    ? `${studentTiles}${sensorTiles}`
    : emptyState("当前教室暂无学生", "切换教室后，画面墙只显示该教室的学生和传感器占位。");

  els.teacherRoomGrid.innerHTML = dashboard.rooms
    .map(
      (room) => `
        <article role="button" tabindex="0" data-room-id="${escapeHtml(room.id)}" aria-label="查看 ${escapeHtml(room.name)}" class="room-card ${room.id === selectedRoom.id ? "selected" : ""} ${room.anomaly >= 2 ? "anomaly" : ""}">
          <div>
            <strong>${escapeHtml(room.name)}</strong>
            <span>${room.occupancyRate}% 满座率</span>
          </div>
          <div class="room-meter"><i style="width:${Math.min(room.occupancyRate, 100)}%"></i></div>
          <p>摄像头 ${room.cameraCount} · 传感器 ${room.sensorCount} · 现场占位 ${room.sensorOnlyCount} · 均值 ${room.averageAttention ?? "—"}</p>
        </article>
      `
    )
    .join("");

  const autoStudents = roomStudents.filter((student) => student.telemetry);
  const cameraStudents = autoStudents.filter((student) => student.telemetry?.cameraEnabled);
  const mediaPipeStudents = autoStudents.filter((student) => student.telemetry?.faceEngine === "MediaPipe Face Detector");
  const abnormalSignals = autoStudents.filter(
    (student) => student.telemetry?.pageVisible === false || student.telemetry?.windowFocused === false || student.status !== "focused"
  );
  els.teacherSignalSummary.innerHTML = `
    <div class="signal-summary-row">
      <span>自动上报</span>
      <strong>${autoStudents.length}/${roomStudents.length}</strong>
    </div>
    <div class="signal-summary-row">
      <span>摄像头接入</span>
      <strong>${cameraStudents.length}</strong>
    </div>
    <div class="signal-summary-row">
      <span>MediaPipe</span>
      <strong>${mediaPipeStudents.length}</strong>
    </div>
    <div class="signal-summary-row warn">
      <span>异常信号</span>
      <strong>${abnormalSignals.length}</strong>
    </div>
  `;

  const needAttention = roomStudents.filter(student => ["confused", "tired", "away"].includes(student.status) || student.handRaised || student.selfReport?.status === "confused");
  els.teacherStudentList.innerHTML = needAttention.length
    ? needAttention
        .slice(0, 6)
        .map(
          (student) => `
            <div class="list-item">
              <span class="dot ${statusClass(student.status)}"></span>
              <div>
                <strong>${escapeHtml(student.name)}</strong>
                <small>${escapeHtml(student.roomId)} · ${statusText(student.status)} · 监测依据：${escapeHtml(
                  (student.selfReport?.status === "confused" ? ["学生主动表示疑惑，待确认理解情况"] : student.telemetry?.reasons || [student.cameraSignal || "手动反馈"]).join("、")
                )}</small>
              </div>
              <b>${student.attention}</b>
            </div>
          `
        )
        .join("")
    : emptyState("暂时没有需要关注的学生", "疑惑、疲劳、暂离与举手反馈将显示在这里。");

  els.teacherEventList.innerHTML = dashboard.events.length
    ? dashboard.events
        .map(
          (event) => `
            <div class="event-item">
              <span>${formatTime(event.createdAt)}</span>
              <strong>${escapeHtml(event.title || event.type)}</strong>
              <p>${escapeHtml(event.detail || "")}</p>
            </div>
          `
        )
        .join("")
    : emptyState("暂无课堂事件", "开课、学生加入、反馈和传感器变化会实时出现在这里。");

  if (dashboard.latestReport) renderReport(dashboard.latestReport);
  else els.teacherReportBox.innerHTML = emptyState("分析课堂信号", "学生加入并产生反馈后，生成教学建议并发起跟进。");
}

function renderStudent(dashboard) {
  if (!app.user) return;
  const me = dashboard.students.find((student) => student.id === app.user.id);
  if (me) {
    els.studentAttention.textContent = me.attention ?? "—";
    els.studentStatusText.textContent = `${statusText(me.status)} · ${me.emotion}`;
    els.studentMonitorEvidence.textContent = `依据：${(me.telemetry?.reasons || [me.cameraSignal || "课堂反馈"]).join("、")}`;
    els.studentSignalGrid.innerHTML = renderSignalGrid(me);
  } else {
    els.studentAttention.textContent = "--";
    els.studentStatusText.textContent = "尚未加入课堂";
    els.studentMonitorEvidence.textContent = "输入课堂码加入后才会开始统计。";
    els.studentSignalGrid.innerHTML = "";
  }
  const peers = dashboard.students.filter((student) => student.id !== app.user.id && student.roomId === app.user.roomId).slice(0, 6);
  els.studentPeerGrid.innerHTML = peers.length
    ? peers
        .map(
          (student) => `
            <div class="peer-tile ${statusClass(student.status)}">
              <span>${escapeHtml(student.name.slice(0, 1))}</span>
              <strong>${escapeHtml(student.name)}</strong>
              <small>${statusText(student.status)}</small>
            </div>
          `
        )
        .join("")
    : emptyState(`课堂已加入 ${dashboard.metrics.totalStudents || 0} 人`, "个人监测记录仅本人和教师可见。");
}

function renderPoll(poll) {
  if (!poll) {
    els.teacherPollPanel.classList.add("hidden");
    els.studentPollPanel.classList.add("hidden");
    return;
  }

  const total = Math.max(1, Number(poll.totalAnswers || 0));
  const results = poll.options
    .map((option) => {
      const count = Number(poll.counts?.[option] || 0);
      const width = Math.round((count / total) * 100);
      return `
        <div class="poll-result">
          <span>${escapeHtml(option)} · ${count} 票</span>
          <i><b style="width:${width}%"></b></i>
        </div>
      `;
    })
    .join("");

  els.teacherPollPanel.classList.remove("hidden");
  els.teacherPollPanel.innerHTML = `
    <div class="poll-heading">
      <div><small>课堂投票</small><strong>${escapeHtml(poll.question)}</strong></div>
      ${poll.status === "active" ? '<button id="closePollButton" class="ghost-button" type="button">结束投票</button>' : "<span>已结束</span>"}
    </div>
    ${results}
  `;
  document.querySelector("#closePollButton")?.addEventListener("click", closePoll);

  if (!app.user || app.user.role !== "student") {
    els.studentPollPanel.classList.add("hidden");
    return;
  }
  const answer = poll.answers?.[app.user.id] || "";
  els.studentPollPanel.classList.remove("hidden");
  els.studentPollPanel.innerHTML = `
    <div class="poll-heading">
      <div><small>教师提问</small><strong>${escapeHtml(poll.question)}</strong></div>
      <span>${poll.status === "active" ? (answer ? `已选择：${escapeHtml(answer)}` : "请选择") : "投票已结束"}</span>
    </div>
    <div class="poll-options">
      ${poll.options
        .map(
          (option) =>
            `<button type="button" data-poll-option="${escapeHtml(option)}" ${poll.status !== "active" ? "disabled" : ""} class="${answer === option ? "selected" : ""}">${escapeHtml(option)}</button>`
        )
        .join("")}
    </div>
    ${poll.status === "closed" ? results : ""}
  `;
  els.studentPollPanel.querySelectorAll("[data-poll-option]").forEach((button) => {
    button.addEventListener("click", () => votePoll(button.dataset.pollOption));
  });
}

async function startPoll() {
  const question = await textDialog("发起理解度投票", "投票题目", "本节内容理解了吗？");
  if (question === null) return;
  await postMeetingControl("startPoll", { question });
}

async function votePoll(option) {
  if (!app.user || app.user.role !== "student") return;
  const data = await request("/api/poll/vote", {
    method: "POST",
    body: JSON.stringify({ studentId: app.user.id, option }),
  });
  renderPoll(data.poll);
}

async function closePoll() {
  if (!app.user || app.user.role !== "teacher") return;
  const data = await request("/api/poll/close", {
    method: "POST",
    body: JSON.stringify({ teacherId: app.user.id, teacherName: app.user.name }),
  });
  renderPoll(data.poll);
}

function stopScreenViewer() {
  if (app.screenShare.viewerTimer) {
    window.clearInterval(app.screenShare.viewerTimer);
    app.screenShare.viewerTimer = null;
  }
  app.screenShare.lastVersion = 0;
  els.studentScreenImage.removeAttribute("src");
}

async function refreshSharedScreen() {
  if (!app.user || app.user.role !== "student") return;
  try {
    const data = await request(`/api/screen/latest?t=${Date.now()}`);
    if (!data.active) {
      els.studentScreenPanel.classList.add("hidden");
      stopScreenViewer();
      return;
    }
    if (data.frame && data.version !== app.screenShare.lastVersion) {
      els.studentScreenImage.src = data.frame;
      app.screenShare.lastVersion = data.version;
      els.studentShareStatus.textContent = `实时画面 · ${formatTime(data.updatedAt)}`;
    } else if (!data.frame) {
      els.studentShareStatus.textContent = "等待教师画面";
    }
  } catch {
    els.studentShareStatus.textContent = "画面重连中";
  }
}

function startScreenViewer() {
  if (app.screenShare.viewerTimer) return;
  refreshSharedScreen();
  app.screenShare.viewerTimer = window.setInterval(refreshSharedScreen, 800);
}

function syncScreenShare(share = {}) {
  const active = Boolean(share.active);
  if (app.user?.role === "student") {
    els.studentScreenPanel.classList.toggle("hidden", !active);
    if (active) {
      els.studentShareTitle.textContent = `${share.presenterName || "教师"}正在共享屏幕`;
      startScreenViewer();
    } else {
      stopScreenViewer();
    }
  }
  if (app.user?.role === "teacher") {
    els.screenShareButton.textContent = app.screenShare.stream ? "停止共享" : active ? "共享进行中" : "共享屏幕";
    els.teacherShareStatus.textContent = app.screenShare.stream ? "正在向学生广播" : active ? `${share.presenterName || "教师"}正在共享` : "尚未共享";
  }
}

async function uploadScreenFrame() {
  if (!app.screenShare.stream || app.screenShare.uploading || !els.teacherScreenPreview.videoWidth) return;
  const sourceWidth = els.teacherScreenPreview.videoWidth;
  const sourceHeight = els.teacherScreenPreview.videoHeight;
  const width = Math.min(960, sourceWidth);
  const height = Math.max(1, Math.round((sourceHeight / sourceWidth) * width));
  const canvas = els.teacherScreenCanvas;
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d").drawImage(els.teacherScreenPreview, 0, 0, width, height);
  const frame = canvas.toDataURL("image/jpeg", 0.62);
  app.screenShare.uploading = true;
  try {
    await request("/api/screen/frame", {
      method: "POST",
      body: JSON.stringify({ teacherId: app.user.id, frame }),
    });
    els.teacherShareStatus.textContent = `正在广播 · ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`;
  } catch (error) {
    els.teacherShareStatus.textContent = `广播失败：${error.message}`;
  } finally {
    app.screenShare.uploading = false;
  }
}

async function startScreenShare() {
  if (app.screenShare.stream) {
    await stopScreenShare();
    return;
  }
  if (!navigator.mediaDevices?.getDisplayMedia) {
    window.alert("当前浏览器不支持屏幕共享。请使用最新版 Chrome 或 Edge；非本机访问还需要 HTTPS。");
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 5 }, audio: false });
    app.screenShare.stream = stream;
    els.teacherScreenPreview.srcObject = stream;
    els.teacherSharePanel.classList.remove("hidden");
    els.screenShareButton.textContent = "停止共享";
    stream.getVideoTracks()[0].onended = () => stopScreenShare().catch(() => {});
    await request("/api/screen/start", {
      method: "POST",
      body: JSON.stringify({ teacherId: app.user.id, teacherName: app.user.name }),
    });
    await els.teacherScreenPreview.play();
    await uploadScreenFrame();
    app.screenShare.captureTimer = window.setInterval(uploadScreenFrame, 800);
  } catch (error) {
    await stopScreenShare({ notifyServer: false });
    els.teacherShareStatus.textContent = `无法共享：${error.message}`;
    window.alert(`屏幕共享未启动：${error.message}`);
  }
}

async function stopScreenShare({ notifyServer = true } = {}) {
  const teacherId = app.user?.id || "";
  if (app.screenShare.captureTimer) {
    window.clearInterval(app.screenShare.captureTimer);
    app.screenShare.captureTimer = null;
  }
  if (app.screenShare.stream) {
    app.screenShare.stream.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
    app.screenShare.stream = null;
  }
  els.teacherScreenPreview.srcObject = null;
  els.teacherSharePanel.classList.add("hidden");
  els.screenShareButton.textContent = "共享屏幕";
  if (notifyServer && teacherId) {
    await request("/api/screen/stop", {
      method: "POST",
      body: JSON.stringify({ teacherId }),
    });
  }
}

function renderReport(report) {
  els.teacherReportBox.innerHTML = `
    <div class="report-score"><span>风险分</span><strong>${report.riskScore}</strong></div>
    <p>${escapeHtml(report.summary)}</p>
    <ul>${report.suggestions.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
    <small>分析方式：可解释规则 · ${formatTime(report.createdAt)}</small>
  `;
}

function renderChartList(items, options = {}) {
  const maxValue = Math.max(
    1,
    ...items.flatMap((item) => [Number(item.value || item.cameraCount || 0), Number(item.sensorCount || 0)])
  );
  return items
    .map((item) => {
      const value = Number(item.value ?? item.cameraCount ?? 0);
      const secondValue = item.sensorCount;
      const width = Math.round((value / maxValue) * 100);
      const secondWidth = secondValue === undefined ? 0 : Math.round((Number(secondValue) / maxValue) * 100);
      return `
        <div class="chart-row">
          <div class="chart-label">
            <strong>${escapeHtml(item.label)}</strong>
            <span>${escapeHtml(options.format ? options.format(item) : value)}</span>
          </div>
          <div class="bar-track">
            <i style="width:${width}%; background:${escapeHtml(item.color || "#0f766e")}"></i>
            ${
              secondValue === undefined
                ? ""
                : `<b style="width:${secondWidth}%"></b>`
            }
          </div>
        </div>
      `;
    })
    .join("");
}

function renderReview(review) {
  els.reviewTitle.textContent = `${review.meeting.title} 课堂复盘`;
  els.reviewSummaryCards.innerHTML = `
    <div><span>时长（分钟）</span><strong>${review.meeting.durationMinutes}</strong></div>
    <div><span>过程样本均值</span><strong>${review.metrics.averageAttention ?? "—"}</strong></div>
    <div><span>风险分</span><strong>${review.metrics.riskScore}</strong></div>
    <div><span>自动遥测</span><strong>${review.metrics.autoTelemetryStudents}</strong></div>
  `;
  els.reviewHighlights.innerHTML = review.highlights.map((item) => `<p>${escapeHtml(item)}</p>`).join("");
  els.statusChart.innerHTML = renderChartList(review.charts.status);
  els.roomChart.innerHTML = renderChartList(review.charts.rooms, {
    format: (room) => `摄像头 ${room.cameraCount} / 传感器 ${room.sensorCount}`,
  });
  const eventNames = { "auto-telemetry": "自动信号采样", "classroom-start": "教师开课", "student-join": "学生加入", "camera-status": "学生主动反馈", feedback: "课堂反馈", intervention: "教学回应", "intervention-response": "学生确认", "intervention-close": "跟进完成", "classroom-end": "课堂结束", "meeting-control": "课堂互动", enter: "模拟进入", leave: "模拟离开", "ai-report": "学情报告" };
  els.eventChart.innerHTML = renderChartList(review.charts.events.length ? review.charts.events.map(item => ({ ...item, label: eventNames[item.label] || item.label })) : [{ label: "暂无事件", value: 0 }]);
  renderReviewExtras(review);
}

function classifyCameraFrame(stats) {
  if (stats.motion < 1.2 && stats.brightness < 28) return { status: "away", attention: 15, emotion: "离开" };
  if (stats.motion < 1.8) return { status: "tired", attention: 43, emotion: "疲劳" };
  if (stats.motion > 16) return { status: "confused", attention: 58, emotion: "疑惑" };
  return {
    status: "focused",
    attention: Math.max(68, Math.min(96, Math.round(82 + stats.brightness / 8 - stats.motion / 5))),
    emotion: "稳定",
  };
}

function analyzeFrame() {
  const canvas = els.cameraCanvas;
  const video = els.cameraPreview;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!video.videoWidth || !video.videoHeight) return null;

  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  let brightness = 0;
  let motion = 0;
  for (let index = 0; index < data.length; index += 16) {
    const value = (data[index] + data[index + 1] + data[index + 2]) / 3;
    brightness += value;
    if (app.camera.previousFrame) motion += Math.abs(value - app.camera.previousFrame[index / 16]);
  }
  const samples = data.length / 16;
  brightness = Math.round(brightness / samples);
  motion = app.camera.previousFrame ? Math.round((motion / samples) * 10) / 10 : 4;
  app.camera.previousFrame = [];
  for (let index = 0; index < data.length; index += 16) {
    app.camera.previousFrame.push((data[index] + data[index + 1] + data[index + 2]) / 3);
  }
  return { brightness, motion, ...classifyCameraFrame({ brightness, motion }) };
}

async function postStudentStatus(reading, signal = "manual") {
  if (!app.user || app.user.role !== "student") return;
  await request("/api/student/status", {
    method: "POST",
    body: JSON.stringify({
      studentId: app.user.id,
      name: app.user.name,
      roomId: app.user.roomId,
      status: reading.status,
      attention: reading.attention,
      emotion: reading.emotion,
      cameraSignal: signal,
      handRaised: Boolean(reading.handRaised),
    }),
  });
}

function markActivity() {
  app.monitor.lastActivityAt = Date.now();
}

async function loadMediaPipeDetector() {
  if (app.monitor.mediaPipeDetector) return app.monitor.mediaPipeDetector;
  if (app.monitor.mediaPipeLoading || app.monitor.mediaPipeUnavailable) return null;

  app.monitor.mediaPipeLoading = true;
  try {
    const vision = await import(mediaPipeFaceConfig.moduleUrl);
    const fileset = await vision.FilesetResolver.forVisionTasks(mediaPipeFaceConfig.wasmRoot);
    app.monitor.mediaPipeDetector = await vision.FaceDetector.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: mediaPipeFaceConfig.modelUrl,
      },
      runningMode: "VIDEO",
      minDetectionConfidence: 0.55,
    });
    app.monitor.mediaPipeError = "";
    return app.monitor.mediaPipeDetector;
  } catch (error) {
    app.monitor.mediaPipeUnavailable = true;
    app.monitor.mediaPipeError = error?.message || "MediaPipe 加载失败";
    return null;
  } finally {
    app.monitor.mediaPipeLoading = false;
  }
}

async function detectMediaPipeFaces() {
  if (!app.camera.stream || !els.cameraPreview.videoWidth) return null;
  const detector = await loadMediaPipeDetector();
  if (!detector) return null;
  try {
    const result = detector.detectForVideo(els.cameraPreview, nextVisionTs());
    const detections = result?.detections || [];
    const score = detections[0]?.categories?.[0]?.score ?? null;
    return {
      faceDetected: detections.length > 0,
      faceCount: detections.length,
      faceEngine: "MediaPipe Face Detector",
      faceScore: score === null ? null : Math.round(score * 100) / 100,
    };
  } catch (error) {
    app.monitor.mediaPipeUnavailable = true;
    app.monitor.mediaPipeError = error?.message || "MediaPipe 检测失败";
    return null;
  }
}

async function detectFaces() {
  if (!app.camera.stream || !els.cameraPreview.videoWidth) {
    return { faceDetected: null, faceCount: null, faceEngine: "camera-off", faceScore: null };
  }

  const mediaPipeFaces = await detectMediaPipeFaces();
  if (mediaPipeFaces) return mediaPipeFaces;

  const fallbackEngine = app.monitor.mediaPipeError ? "native-fallback" : "Browser FaceDetector";
  if (!("FaceDetector" in window)) {
    return { faceDetected: null, faceCount: null, faceEngine: "fallback-frame-signal", faceScore: null };
  }
  try {
    if (!app.monitor.faceDetector) {
      app.monitor.faceDetector = new window.FaceDetector({ fastMode: true, maxDetectedFaces: 2 });
    }
    const faces = await app.monitor.faceDetector.detect(els.cameraPreview);
    return { faceDetected: faces.length > 0, faceCount: faces.length, faceEngine: fallbackEngine, faceScore: null };
  } catch {
    return { faceDetected: null, faceCount: null, faceEngine: "fallback-frame-signal", faceScore: null };
  }
}

// 举手检测插件：复用 MediaPipe tasks-vision，按需加载 PoseLandmarker。
async function loadPoseDetector() {
  if (app.monitor.poseDetector) return app.monitor.poseDetector;
  if (app.monitor.poseLoading || app.monitor.poseUnavailable) return null;

  app.monitor.poseLoading = true;
  try {
    const vision = await import(mediaPipePoseConfig.moduleUrl);
    const fileset = await vision.FilesetResolver.forVisionTasks(mediaPipePoseConfig.wasmRoot);
    app.monitor.poseDetector = await vision.PoseLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: mediaPipePoseConfig.modelUrl,
      },
      // 用 IMAGE 模式逐帧独立检测，不依赖时间戳，避免与 face 检测器共享 wasm
      // 实例时出现 "Packet timestamp mismatch on stream free_memory" 报错。
      runningMode: "IMAGE",
      numPoses: 1,
    });
    app.monitor.poseError = "";
    return app.monitor.poseDetector;
  } catch (error) {
    app.monitor.poseUnavailable = true;
    app.monitor.poseError = error?.message || "PoseLandmarker 加载失败";
    return null;
  } finally {
    app.monitor.poseLoading = false;
  }
}

// 从姿态关键点判断是否举手：任一手腕高于对应肩部（y 越小越高）。
// 返回 handRaisedRaw 为 null 表示无法判断（摄像头未开、模型不可用或未检测到人），不覆盖手动态。
async function detectHandRaise() {
  if (!app.camera.stream || !els.cameraPreview.videoWidth) {
    return { handRaisedRaw: null, poseEngine: "camera-off", poseDetail: "摄像头未开" };
  }
  const detector = await loadPoseDetector();
  if (!detector) {
    return { handRaisedRaw: null, poseEngine: "pose-unavailable", poseDetail: app.monitor.poseError || "模型未就绪" };
  }
  try {
    // IMAGE 模式逐帧检测，无需时间戳，避免共享 wasm 实例的时间戳冲突。
    const result = detector.detect(els.cameraPreview);
    const landmarks = result?.landmarks?.[0];
    if (!landmarks || landmarks.length < 17) {
      return { handRaisedRaw: null, poseEngine: "MediaPipe Pose", poseDetail: "未检测到人体（请露出上半身和双肩）" };
    }
    // MediaPipe Pose 关键点索引：11 左肩 / 12 右肩 / 15 左手腕 / 16 右手腕。
    const leftShoulder = landmarks[11];
    const rightShoulder = landmarks[12];
    const leftWrist = landmarks[15];
    const rightWrist = landmarks[16];
        const raised = VisionMetrics.handRaised(landmarks);
    const fmt = (v) => (v === undefined ? "?" : Math.round(v * 100) / 100);
    return {
      handRaisedRaw: raised,
      poseEngine: "MediaPipe Pose",
      poseDetail: `腕L ${fmt(leftWrist?.y)}/肩L ${fmt(leftShoulder?.y)} 腕R ${fmt(rightWrist?.y)}/肩R ${fmt(rightShoulder?.y)}${raised ? " → 举手" : ""}`,
    };
  } catch (error) {
    // 检测偶发报错不永久禁用（时间戳等瞬时问题），仅记录，下次继续尝试。
    app.monitor.poseError = error?.message || "PoseLandmarker 检测失败";
    return { handRaisedRaw: null, poseEngine: "pose-error", poseDetail: app.monitor.poseError };
  }
}

// 去抖：举手判据需持续 holdMs 才置位，放下立即清除。changed 表示相对上次上报态是否翻转。
function resolveHandRaise(rawRaised) {
  if (rawRaised === null || rawRaised === undefined) {
    app.monitor.handRaiseSince = null;
    app.monitor.handRaisedActive = false;
    return { active: null, changed: false };
  }
  const previous = app.monitor.handRaisedActive;
  if (rawRaised === true) {
    if (!app.monitor.handRaiseSince) app.monitor.handRaiseSince = Date.now();
    const held = Date.now() - app.monitor.handRaiseSince >= mediaPipePoseConfig.holdMs;
    if (held) app.monitor.handRaisedActive = true;
  } else {
    app.monitor.handRaiseSince = null;
    app.monitor.handRaisedActive = false;
  }
  return { active: app.monitor.handRaisedActive, changed: app.monitor.handRaisedActive !== previous };
}

// 持续闭眼检测：用 FaceLandmarker 的 blendshapes 读取闭眼程度。
async function loadFaceLandmarker() {
  if (app.monitor.faceLandmarker) return app.monitor.faceLandmarker;
  if (app.monitor.faceLandmarkerLoading || app.monitor.faceLandmarkerUnavailable) return null;

  app.monitor.faceLandmarkerLoading = true;
  try {
    const vision = await import(mediaPipeSleepConfig.moduleUrl);
    const fileset = await vision.FilesetResolver.forVisionTasks(mediaPipeSleepConfig.wasmRoot);
    app.monitor.faceLandmarker = await vision.FaceLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: mediaPipeSleepConfig.modelUrl,
      },
      // IMAGE 模式逐帧检测，不依赖时间戳，避免与其他检测器共享 wasm 实例的时间戳冲突。
      runningMode: "IMAGE",
      numFaces: 1,
      outputFaceBlendshapes: true,
    });
    app.monitor.faceLandmarkerError = "";
    return app.monitor.faceLandmarker;
  } catch (error) {
    app.monitor.faceLandmarkerUnavailable = true;
    app.monitor.faceLandmarkerError = error?.message || "FaceLandmarker 加载失败";
    return null;
  } finally {
    app.monitor.faceLandmarkerLoading = false;
  }
}

// 从 blendshapes 读取双眼闭合程度判断是否闭眼。sleepingRaw 为 null 表示无法判断（不覆盖现状）。
async function detectSleep() {
  if (!app.camera.stream || !els.cameraPreview.videoWidth) {
    return { sleepingRaw: null, sleepEngine: "camera-off", sleepDetail: "摄像头未开" };
  }
  const detector = await loadFaceLandmarker();
  if (!detector) {
    return { sleepingRaw: null, sleepEngine: "sleep-unavailable", sleepDetail: app.monitor.faceLandmarkerError || "模型未就绪" };
  }
  try {
    const result = detector.detect(els.cameraPreview);
    const shapes = result?.faceBlendshapes?.[0]?.categories;
    if (!shapes || !shapes.length) {
      return { sleepingRaw: null, sleepEngine: "MediaPipe FaceLandmarker", sleepDetail: "未检测到人脸（可能已离开或低头遮挡）" };
    }
    const scoreOf = (name) => shapes.find((c) => c.categoryName === name)?.score ?? 0;
    const blinkLeft = scoreOf("eyeBlinkLeft");
    const blinkRight = scoreOf("eyeBlinkRight");
    // 双眼都闭合超过阈值才算闭眼，避免单眼/眯眼误判。
    const closed = VisionMetrics.eyesClosed(shapes);
    const fmt = (v) => Math.round(v * 100) / 100;
    return {
      sleepingRaw: closed,
      sleepEngine: "MediaPipe FaceLandmarker",
      sleepDetail: `闭眼L ${fmt(blinkLeft)} 闭眼R ${fmt(blinkRight)}${closed ? " → 闭眼" : ""}`,
    };
  } catch (error) {
    app.monitor.faceLandmarkerError = error?.message || "FaceLandmarker 检测失败";
    return { sleepingRaw: null, sleepEngine: "sleep-error", sleepDetail: app.monitor.faceLandmarkerError };
  }
}

// 去抖：需持续闭眼 holdMs 才发出持续闭眼提示，睁眼立即清除。changed 表示相对上次上报态是否翻转。
function resolveSleep(rawSleeping) {
  if (rawSleeping === null || rawSleeping === undefined) {
    app.monitor.sleepSince = null;
    app.monitor.sleepActive = false;
    return { active: null, changed: false };
  }
  const previous = app.monitor.sleepActive;
  if (rawSleeping === true) {
    if (!app.monitor.sleepSince) app.monitor.sleepSince = Date.now();
    const held = Date.now() - app.monitor.sleepSince >= mediaPipeSleepConfig.holdMs;
    if (held) app.monitor.sleepActive = true;
  } else {
    app.monitor.sleepSince = null;
    app.monitor.sleepActive = false;
  }
  return { active: app.monitor.sleepActive, changed: app.monitor.sleepActive !== previous };
}

// 本地视觉每 500 ms 采样；网络保持 4 秒上报，避免网络频率决定持续动作判据。
const visionSampling = { timer:null, busy:false, generation:0, latest:null, sampledAt:0, lastHand:null, lastSleep:null };
function stopVisionSampling() {
  clearTimeout(visionSampling.timer); visionSampling.timer=null;
  visionSampling.generation++; visionSampling.latest=null; visionSampling.sampledAt=0;
  visionSampling.lastHand=null; visionSampling.lastSleep=null;
}
function startVisionSampling() {
  stopVisionSampling();
  const generation=visionSampling.generation;
  const tick=async () => {
    if (generation!==visionSampling.generation || !app.camera.stream) return;
    let acquired=false;
    try {
      if (!document.hidden && !visionSampling.busy) {
        visionSampling.busy=true; acquired=true;
        const face=await detectFaces(); const hand=await detectHandRaise(); const sleep=await detectSleep();
        if (generation!==visionSampling.generation) return;
        // 后台节流或模型停顿后重新累计持续时间，不能把未观察间隔当成持续动作。
        if (Date.now()-visionSampling.sampledAt>2000) { app.monitor.handRaiseSince=null; app.monitor.sleepSince=null; }
        const handState=resolveHandRaise(hand.handRaisedRaw), sleepState=resolveSleep(sleep.sleepingRaw);
        app.monitor.lastPoseDetail=hand.poseDetail || ""; app.monitor.lastSleepDetail=sleep.sleepDetail || "";
        visionSampling.latest={face,hand,sleep,handState,sleepState}; visionSampling.sampledAt=Date.now();
      }
    } catch(error) { els.cameraReading.textContent="视觉采样暂不可用："+error.message; }
    finally { if (acquired) visionSampling.busy=false; if (generation===visionSampling.generation && app.camera.stream) visionSampling.timer=setTimeout(tick,500); }
  };
  tick();
}
async function collectTelemetry() {
  if (!app.user || app.user.role !== "student") return null;
  const reading=app.camera.stream ? analyzeFrame() : null;
  const current=app.camera.stream && !document.hidden && Date.now()-visionSampling.sampledAt<2000 ? visionSampling.latest : null;
  const unavailable=app.camera.stream ? "waiting-frame" : "camera-off";
  const face=current?.face || {faceDetected:null,faceCount:null,faceEngine:unavailable,faceScore:null};
  const hand=current?.hand || {poseEngine:unavailable};
  const sleep=current?.sleep || {sleepEngine:unavailable};
  const handState={active:current?.handState.active ?? null,changed:false};
  const sleepState={active:current?.sleepState.active ?? null,changed:false};
  handState.changed=handState.active!==null && handState.active!==visionSampling.lastHand;
  sleepState.changed=sleepState.active!==null && sleepState.active!==visionSampling.lastSleep;
  // 初次检测到正常状态无需制造一次“放下手 / 睁眼”反馈。
  if (visionSampling.lastHand===null && handState.active===false) handState.changed=false;
  if (visionSampling.lastSleep===null && sleepState.active===false) sleepState.changed=false;
  return {
    studentId: app.user.id,
    name: app.user.name,
    roomId: app.user.roomId,
    pageVisible: document.visibilityState === "visible",
    windowFocused: document.hasFocus(),
    idleSeconds: Math.round((Date.now() - app.monitor.lastActivityAt) / 1000),
    cameraEnabled: Boolean(app.camera.stream),
    brightness: reading?.brightness ?? null,
    motion: reading?.motion ?? null,
    faceDetected: face.faceDetected,
    faceCount: face.faceCount,
    faceEngine: face.faceEngine,
    faceScore: face.faceScore,
    // 仅摄像头开启时由自动检测接管 handRaised/sleeping；关闭时发 null，
    // 让后端保留现有值，避免覆盖学生手动点的"举手"等状态。
    handRaised: app.camera.stream ? handState.active : null,
    handRaiseChanged: handState.changed,
    poseEngine: hand.poseEngine,
    sleeping: app.camera.stream ? sleepState.active : null,
    sleepChanged: sleepState.changed,
    sleepEngine: sleep.sleepEngine,
  };
}

async function postTelemetry() {
  if (!app.user || app.user.role !== "student" || app.page !== "studentClass" || app.dashboard?.meeting.status !== "live" || app.monitor.posting) return;
  app.monitor.posting = true;
  const generation = app.monitor.generation;
  try {
  const telemetry = await collectTelemetry();
  if (generation !== app.monitor.generation) return;
  if (!telemetry) return;
  const result = await request("/api/student/telemetry", {
    method: "POST",
    body: JSON.stringify(telemetry),
  });
  visionSampling.lastHand = telemetry.handRaised;
  visionSampling.lastSleep = telemetry.sleeping;
  // 举手态翻转时补一条反馈事件，让教师端事件流可见自动举手/落下。
  if (telemetry.handRaiseChanged) {
    postFeedback(telemetry.handRaised ? "举手" : "放下手", telemetry.handRaised ? "摄像头自动识别到举手" : "摄像头识别到手已放下").catch(() => {});
  }
  // 持续闭眼状态翻转时补一条反馈事件。
  if (telemetry.sleepChanged) {
    postFeedback(telemetry.sleeping ? "持续闭眼" : "闭眼信号解除", telemetry.sleeping ? "摄像头识别到持续闭眼信号" : "摄像头识别到已睁眼").catch(() => {});
  }
  const reasons = result.inferred?.reasons || [];
  const engine = telemetry.faceEngine && telemetry.faceEngine !== "camera-off" ? ` · ${telemetry.faceEngine}` : "";
  const handHint = telemetry.handRaised ? " · ✋ 已自动举手" : "";
  const sleepHint = telemetry.sleeping ? " · 😴 持续闭眼" : "";
  els.cameraReading.textContent = `自动监测：${statusText(result.inferred.status)} · 注意力 ${
    result.inferred.attention
  }${engine}${handHint}${sleepHint} · ${reasons.join("、")}`;
  // 举手检测诊断行：显示姿态引擎状态与手腕/肩部坐标，便于排查未检测到的原因。
  if (app.camera.stream && els.handRaiseDebug) {
    els.handRaiseDebug.textContent = `举手检测：${telemetry.poseEngine || "?"} · ${app.monitor.lastPoseDetail || "…"}`;
  }
  // 持续闭眼诊断行：显示闭眼程度。
  if (app.camera.stream && els.sleepDebug) {
    els.sleepDebug.textContent = `闭眼信号：${telemetry.sleepEngine || "?"} · ${app.monitor.lastSleepDetail || "…"}`;
  }
  } finally { app.monitor.posting = false; }
}

function startAutoMonitor() {
  if (!app.user || app.user.role !== "student" || app.dashboard?.meeting.status !== "live") return;
  if (app.monitor.timer) window.clearInterval(app.monitor.timer);
  markActivity();
  app.monitor.timer = window.setInterval(() => {
    postTelemetry().catch(error => { els.cameraReading.textContent = error.message; });
  }, 4000);
  postTelemetry().catch(() => {});
}

async function postFeedback(mood, message) {
  if (!app.user) return;
  await request("/api/feedback", {
    method: "POST",
    body: JSON.stringify({
      studentId: app.user.id,
      roomId: app.user.roomId,
      mood,
      message,
    }),
  });
}

async function startCamera() {
  if (app.camera.stream) {
    stopCamera();
    await postTelemetry();
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    els.cameraReading.textContent = "摄像头需要支持该能力的浏览器与安全连接。仍可正常提交课堂反馈。";
    return;
  }
  els.cameraButton.disabled = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    if (app.page !== "studentClass" || app.dashboard?.meeting.status !== "live") { stream.getTracks().forEach(track => track.stop()); return; }
    app.camera.stream = stream;
    els.cameraPreview.srcObject = stream;
    els.cameraPreview.closest(".camera-panel")?.classList.add("camera-active");
    await els.cameraPreview.play();
    els.cameraButton.textContent = "关闭摄像头";
    startVisionSampling();
    stream.getVideoTracks()[0].onended = () => { stopCamera(); postTelemetry().catch(showError); };
    await postTelemetry();
  } catch (error) {
    stopCamera();
    els.cameraReading.textContent = "摄像头未启动：" + error.message;
  } finally { els.cameraButton.disabled = false; }
}

async function askKnowledge() {
  const question = els.studentQuestionInput.value.trim();
  if (!question) return;
  if (els.studentAskButton.disabled) return;
  els.studentAskButton.disabled = true;
  els.studentAnswerBox.textContent = "学习助手正在整理回答...";
  try {
  const data = await request("/api/ask", {
    method: "POST",
    body: JSON.stringify({ userId: app.user?.id, question }),
  });
  els.studentAnswerBox.innerHTML = `
    <strong>回答</strong>
    <p>${escapeHtml(data.answer)}</p>
    <small>${data.engine === "local-fallback" ? "课程资料检索" : data.engine === "external-error-local-fallback" ? "在线助手暂不可用 · 已使用课程资料检索" : "在线学习助手"} · 回答已保存</small>
    <div class="source-list">${data.sources.map((source) => `<details><summary>${escapeHtml(source.title)}</summary><p>${escapeHtml(source.content || source.snippet || "")}</p></details>`).join("")}</div>
  `;
  } catch (error) { els.studentAnswerBox.textContent = error.message; }
  finally { els.studentAskButton.disabled = false; }
}

async function generateReport() {
  els.teacherReportButton.disabled = true;
  els.teacherReportBox.textContent = "AI 正在生成课堂诊断...";
  try {
    const report = await request("/api/ai/analyze", { method: "POST", body: JSON.stringify({}) });
    renderReport(report);
  } finally {
    els.teacherReportButton.disabled = false;
  }
}

async function postSensor(type) {
  const data = await request("/api/sensor/event", {
    method: "POST",
    body: JSON.stringify({
      roomId: els.teacherSensorRoomSelect.value || "A101",
      type,
      confidence: 0.96,
    }),
  });
  renderDashboard(data.state);
}

async function postMeetingControl(action, extra = {}) {
  await request("/api/meeting/control", {
    method: "POST",
    body: JSON.stringify({
      action,
      operator: app.user?.name || "教师",
      ...extra,
    }),
  });
}

async function endClassroom() {
  if (!app.user || app.user.role !== "teacher") return;
  els.endClassButton.disabled = true;
  els.endClassButton.textContent = "生成复盘中";
  try {
    if (app.screenShare.stream) await stopScreenShare();
    const data = await request("/api/classroom/end", {
      method: "POST",
      body: JSON.stringify({
        teacherId: app.user.id,
        teacherName: app.user.name,
      }),
    });
    renderDashboard(data.state);
    app.selectedReview = data.review;
    renderReview(data.review);
    showPage("review");
  } finally {
    els.endClassButton.disabled = app.dashboard?.meeting.status !== "live";
    els.endClassButton.textContent = "结束课堂";
  }
}

async function exportReport() {
  const meetingId = app.page === "review" ? app.selectedReview?.meeting?.id || app.selectedReview?.meetingId || app.dashboard?.latestReview?.meeting?.id : null;
  const data = await request("/api/report/export" + (meetingId ? "?meetingId=" + encodeURIComponent(meetingId) : ""));
  const blob = new Blob([data.content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = data.filename;
  link.click();
  URL.revokeObjectURL(url);
}

els.teacherRoleButton.addEventListener("click", () => setRole("teacher"));
els.studentRoleButton.addEventListener("click", () => setRole("student"));
els.loginButton.addEventListener("click", login);
els.logoutButtons.forEach((button) => button.addEventListener("click", logout));
els.startClassButton.addEventListener("click", startClassroom);
els.joinClassButton.addEventListener("click", joinClassroom);
els.teacherStreamStatus.addEventListener("click", reconnectStream);
els.studentStreamStatus.addEventListener("click", reconnectStream);
els.cameraButton.addEventListener("click", startCamera);
els.focusedButton.addEventListener("click", async () => {
  await postStudentStatus({ status: "focused", attention: 88, emotion: "稳定", handRaised: false }, "student-feedback");
  await postFeedback("听懂", "当前内容可以跟上");
});
els.confusedButton.addEventListener("click", async () => {
  await postStudentStatus({ status: "confused", attention: 52, emotion: "疑惑", handRaised: false }, "student-feedback");
  await postFeedback("有疑问", "当前知识点需要再讲一遍");
});
els.tooFastButton.addEventListener("click", async () => {
  await postStudentStatus({ status: "confused", attention: 48, emotion: "吃力", handRaised: false }, "pace-feedback");
  await postFeedback("讲太快了", "希望老师放慢节奏");
});
els.raiseHandButton.addEventListener("click", async () => {
  await postStudentStatus({ status: "confused", attention: 60, emotion: "疑惑", handRaised: true }, "raise-hand");
  await postFeedback("举手", "我想提问");
});
els.awayButton.addEventListener("click", () =>
  postStudentStatus({ status: "away", attention: 10, emotion: "离开", handRaised: false }, "student-away")
);
els.backButton.addEventListener("click", () =>
  postStudentStatus({ status: "focused", attention: 76, emotion: "稳定", handRaised: false }, "student-back")
);
els.studentAskButton.addEventListener("click", askKnowledge);
els.teacherReportButton.addEventListener("click", generateReport);
els.endClassButton.addEventListener("click", endClassroom);
els.exportReportButton.addEventListener("click", exportReport);
els.reviewExportButton.addEventListener("click", exportReport);
els.backToTeacherButton.addEventListener("click", () => showPage("teacherHome"));
els.muteAllButton.addEventListener("click", () => postMeetingControl("muteAll"));
els.pollButton.addEventListener("click", startPoll);
els.screenShareButton.addEventListener("click", startScreenShare);
els.shareMaterialButton.addEventListener("click", () => postMeetingControl("shareMaterial"));
els.teacherSensorRoomSelect.addEventListener("change", () => {
  app.teacherRoomFilter = els.teacherSensorRoomSelect.value;
  if (app.dashboard) renderDashboard(app.dashboard);
});
els.teacherSensorEnterButton.addEventListener("click", () => postSensor("enter"));
els.teacherSensorLeaveButton.addEventListener("click", () => postSensor("leave"));
["mousemove", "keydown", "click", "touchstart"].forEach((eventName) => {
  window.addEventListener(eventName, markActivity, { passive: true });
});
document.addEventListener("visibilitychange", () => postTelemetry().catch(() => {}));
window.addEventListener("focus", () => postTelemetry().catch(() => {}));
window.addEventListener("blur", () => postTelemetry().catch(() => {}));

setupClassroomTools();
setupCampus();
setupWorkflows();
setRole("teacher");
restoreSession();
