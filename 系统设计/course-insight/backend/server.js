const http = require("http");
const https = require("https");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { AsyncLocalStorage } = require("node:async_hooks");
const requestContext = new AsyncLocalStorage();
const ownerId = () => requestContext.getStore()?.ownerId || null;
const setOwner = id => { requestContext.getStore().ownerId = id; };

const baseDir = path.resolve(__dirname, "..");
const frontendDir = path.join(baseDir, "frontend");
const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, "data"));
const storePath = path.join(dataDir, "store.json");
const port = Number(process.env.PORT || 8000);
const lanMode = process.argv.includes("--lan") || process.env.LAN === "1";
const host = process.env.HOST || (lanMode ? "0.0.0.0" : "127.0.0.1");

// 屏幕帧只保存在内存中，避免把大段 base64 数据写入 store.json。
// 该方案由服务端中继，部署到公网 HTTPS 后不受 WebRTC NAT 穿透限制。
const teacherScreens = new Map();
function currentTeacherScreen() {
  const key = ownerId() || "unassigned";
  if (!teacherScreens.has(key)) teacherScreens.set(key, { active: false, version: 0, frame: null, presenterId: "", presenterName: "", updatedAt: null });
  return teacherScreens.get(key);
}
// 媒体状态与数据库使用同一请求所有者，避免教师间共享内存画面。
const liveScreenShare = new Proxy({}, { get: (_, key) => currentTeacherScreen()[key], set: (_, key, value) => { currentTeacherScreen()[key] = value; return true; } });

const knowledgeDocs = [
  {
    id: "doc-product",
    title: "智课云舱产品定位",
    content:
      "智课云舱不是普通会议系统，而是面向线上课堂的 AI 学情监测平台。系统通过学生摄像头、门口传感器、实时反馈和课程资料问答，帮助教师判断学生是否专注、是否疑惑、是否需要干预。",
  },
  {
    id: "doc-hardware",
    title: "真实硬件与终端能力",
    content:
      "硬件能力必须进入业务闭环。摄像头用于学生状态识别，门口传感器用于教室人数变化，统计结果进入后端保存，并同步到教师端驾驶舱。",
  },
  {
    id: "doc-ai",
    title: "AI 模型集成标准",
    content:
      "AI 不能只是聊天窗口。AI 结果需要影响页面或业务流程，例如生成低参与风险、课堂干预建议、学生状态解释和课后学情报告。",
  },
  {
    id: "doc-rag",
    title: "RAG 轻量知识库",
    content:
      "RAG 要求系统基于指定资料回答。简化实现包括文档切片、关键词匹配、相似度召回、展示依据片段和保存问答记录。",
  },
  {
    id: "doc-realtime",
    title: "实时数据流",
    content:
      "实时数据流要求学生端状态变化、传感器事件、反馈和 AI 报告无需刷新即可同步到教师端。当前系统使用 SSE 实现。",
  },
];

const defaultUsers = [
  { id: "teacher-001", name: "周老师", role: "teacher", roomId: "A101" },
];

const defaultStore = {
  schemaVersion: 8,
  attendance: [],
  comments: [],
  commentSettings: { enabled: true },
  interventions: [],
  archives: [],
  pollHistory: [],
  timeline: [],
  meeting: {
    id: "class-2026-system-design",
    code: "",
    title: "系统设计与实践线上课堂",
    topic: "AI Coding 与智能课堂系统设计",
    roomId: "A101",
    status: "draft",
    teacherId: "teacher-001",
    startedAt: null,
    endedAt: null,
  },
  users: defaultUsers,
  rooms: [
    { id: "A101", name: "A101 云课堂", capacity: 48, liveCount: 0, sensorCount: 0 },
    { id: "A102", name: "A102 实验室", capacity: 36, liveCount: 0, sensorCount: 0 },
    { id: "B201", name: "B201 项目教室", capacity: 60, liveCount: 0, sensorCount: 0 },
  ],
  students: [],
  sensorEvents: [],
  classroomEvents: [],
  feedback: [],
  knowledgeDocs,
  qaHistory: [],
  aiReports: [],
  classReviews: [],
  poll: null,
};

const sseClients = new Set();

let workflows;
const storage = require("./database").createDatabase(dataDir, defaultStore);
function ensureStore() {}
function readStore() { return storage.read(ownerId()); }
function writeStore(store) {
  workflows?.record(store);
  storage.write(ownerId(), store);
}

function sendJson(response, statusCode, payload) {
  if (workflows && response.session) {
    if (payload?.state) payload = { ...payload, state: workflows.project(payload.state, response.session) };
    else if (payload?.students && payload?.metrics) payload = workflows.project(payload, response.session);
    if (payload?.poll && response.session.user.role === "student") payload = { ...payload, poll: { ...payload.poll, answers: { [response.session.user.id]: payload.poll.answers?.[response.session.user.id] } } };
  }
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

function readJson(request) {
  if (request.parsedBody) return Promise.resolve(request.parsedBody);
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error("请求体过大"));
        request.destroy();
      }
    });
    request.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(Object.assign(new Error("请求体不是有效 JSON"), { status: 400 }));
      }
    });
    request.on("error", reject);
  });
}

function resetScreenShare() {
  liveScreenShare.active = false;
  liveScreenShare.frame = null;
  liveScreenShare.presenterId = "";
  liveScreenShare.presenterName = "";
  liveScreenShare.updatedAt = Date.now();
  liveScreenShare.version += 1;
}

function publicScreenShare() {
  return {
    active: liveScreenShare.active,
    version: liveScreenShare.version,
    presenterName: liveScreenShare.presenterName,
    updatedAt: liveScreenShare.updatedAt,
  };
}

function pollSummary(poll) {
  if (!poll) return null;
  const options = Array.isArray(poll.options) ? poll.options : [];
  const answers = poll.answers && typeof poll.answers === "object" ? poll.answers : {};
  const counts = Object.values(answers).reduce((result, option) => {
    if (options.includes(option)) result[option] = (result[option] || 0) + 1;
    return result;
  }, Object.fromEntries(options.map((option) => [option, 0])));
  return { ...poll, answers, counts, totalAnswers: Object.keys(answers).length };
}

function postJson(url, payload, headers = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const body = JSON.stringify(payload);
    const client = target.protocol === "http:" ? http : https;
    const request = client.request(
      {
        method: "POST",
        hostname: target.hostname,
        port: target.port || (target.protocol === "http:" ? 80 : 443),
        path: `${target.pathname}${target.search}`,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          ...headers,
        },
        timeout: 20000,
      },
      (response) => {
        let data = "";
        response.on("data", (chunk) => {
          data += chunk;
        });
        response.on("end", () => {
          try {
            const parsed = data ? JSON.parse(data) : {};
            if (response.statusCode >= 400) {
              reject(new Error(parsed.error?.message || `AI 接口返回 ${response.statusCode}`));
              return;
            }
            resolve(parsed);
          } catch {
            reject(new Error("AI 接口返回内容不是有效 JSON"));
          }
        });
      }
    );
    request.on("timeout", () => {
      request.destroy(new Error("AI 接口请求超时"));
    });
    request.on("error", reject);
    request.write(body);
    request.end();
  });
}

function statusLabel(status) {
  return {
    focused: "专注",
    confused: "疑惑",
    tired: "疲劳",
    away: "离开",
  }[status] || "未知";
}

function emotionFromStatus(status) {
  return {
    focused: "稳定",
    confused: "疑惑",
    tired: "疲劳",
    away: "离开",
  }[status] || "未知";
}

function teacherIdentities(store) {
  const teachers = (store.users || []).filter((user) => user.role === "teacher");
  return {
    ids: new Set(teachers.map((teacher) => teacher.id)),
    names: new Set(teachers.map((teacher) => teacher.name)),
  };
}

function isTeacherIdentity(store, id, name) {
  const teachers = teacherIdentities(store);
  return id ? teachers.ids.has(id) : teachers.names.has(name);
}

function visibleStudents(store) {
  const teachers = teacherIdentities(store);
  const usersById = new Map((store.users || []).map((user) => [user.id, user]));
  return (store.students || []).filter((student) => {
    const user = usersById.get(student.id);
    return (
      student.joinedAt &&
      user?.role === "student" &&
      !teachers.ids.has(student.id)
    );
  });
}

function normalizeCode(value) {
  return String(value || "").trim().toUpperCase();
}

function createClassCode(seed) {
  const letters = normalizeCode(seed || "AETHER").replace(/[^A-Z0-9]/g, "").slice(0, 6) || "AETHER";
  const suffix = String(Date.now()).slice(-4);
  return `${letters}-${suffix}`;
}

function tokenize(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function chunkDocument(doc) {
  return String(doc.content)
    .split(/[。！？\n]/)
    .map((content) => content.trim())
    .filter(Boolean)
    .map((content, index) => ({
      id: `${doc.id}-${index + 1}`,
      title: doc.title,
      content,
      tokens: tokenize(`${doc.title} ${content}`),
    }));
}

function retrieveKnowledge(question, docs, limit = 3) {
  const tokens = tokenize(question);
  return docs
    .flatMap(chunkDocument)
    .map((chunk) => {
      const tokenScore = tokens.filter((token) =>
        chunk.tokens.some((sourceToken) => sourceToken.includes(token) || token.includes(sourceToken))
      ).length;
      const charScore = [...question].filter(
        (char) => char.trim() && `${chunk.title}${chunk.content}`.includes(char)
      ).length;
      return { ...chunk, score: tokenScore * 10 + charScore };
    })
    .filter((chunk) => chunk.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}

function localAnswer(question, sources) {
  if (sources.length) {
    return `根据课程资料检索到以下相关片段：${sources
      .map((source) => source.content)
      .join("；")}。你可以展开下方来源查看依据，并向教师确认不清楚的部分。`;
  }
  return "当前课程资料中没有找到足够依据。请补充课程相关关键词，或请教师添加对应讲义后再提问。";
}

async function answerWithExternalAi(question, sources, dashboard) {
  const apiUrl = process.env.AI_API_URL || process.env.OPENAI_API_URL;
  const apiKey = process.env.AI_API_KEY || process.env.OPENAI_API_KEY;
  const model = process.env.AI_MODEL || "openrouter/auto";
  if (!apiUrl || !apiKey) return null;

  const context = sources.length
    ? sources.map((source, index) => `资料${index + 1}《${source.title}》：${source.content}`).join("\n")
    : "本题没有命中课程资料，请直接根据通用知识回答，并提醒学生可补充课程资料。";
  const payload = {
    model,
    messages: [
      {
        role: "system",
        content:
          "你是 AetherClass 智课云舱的课堂 AI 助教。回答要简洁、准确、适合课堂学生理解。可以参考资料，但不要只复述资料；如果资料不足，可以基于通用知识回答，并说明不确定性。",
      },
      {
        role: "user",
        content: [
          `学生问题：${question}`,
          "",
          "可参考课堂资料：",
          context,
          "",
          `当前课堂概况：专注率 ${dashboard.metrics.focusRate}%，风险分 ${dashboard.metrics.riskScore}，在线 ${dashboard.metrics.activeStudents}/${dashboard.metrics.totalStudents}。`,
        ].join("\n"),
      },
    ],
    temperature: Number(process.env.AI_TEMPERATURE || 0.3),
  };
  const headers = {
    Authorization: `Bearer ${apiKey}`,
  };
  if (process.env.AI_SITE_URL) headers["HTTP-Referer"] = process.env.AI_SITE_URL;
  if (process.env.AI_APP_NAME) headers["X-Title"] = process.env.AI_APP_NAME;
  const response = await postJson(apiUrl, payload, headers);
  const answer = response.choices?.[0]?.message?.content || response.output_text || "";
  if (!answer.trim()) throw new Error("AI 接口没有返回回答文本");
  return {
    answer: answer.trim(),
    engine: process.env.AI_PROVIDER_NAME || `external:${model}`,
    model,
  };
}

function predictRisk({ totals, rooms }) {
  if (!totals.total) return 0;
  const lowEngagementRatio = (totals.confused + totals.tired + totals.away) / totals.total;
  const anomalyRatio = rooms.filter((room) => room.anomaly >= 2).length / Math.max(rooms.length, 1);
  return Math.min(100, Math.round(lowEngagementRatio * 72 + anomalyRatio * 28));
}

function computeDashboard(store) {
  const students = visibleStudents(store).map(student => {
    const stale = store.meeting.status === "live" && Date.now() - Number(student.updatedAt || student.joinedAt) > 45000;
    // 没有心跳表示连接失效，不应继续显示为在线，也不应当作学习能力低。
    return stale ? { ...student, status: "away", attention: null, connection: "stale", telemetry: student.telemetry ? { ...student.telemetry, cameraEnabled: false, reasons: ["超过 45 秒未收到终端上报"] } : null } : { ...student, connection: "online" };
  });
  const rooms = store.rooms.map((room) => {
    const roomStudents = students.filter((student) => student.roomId === room.id);
    const activeCount = roomStudents.filter(student => student.status !== "away").length;
    const cameraCount = roomStudents.filter(student => student.telemetry?.cameraEnabled && student.status !== "away").length;
    const sensorCount = Number(room.sensorCount || 0);
    const sensorOnlyCount = Math.max(0, sensorCount - activeCount);
    const observed = roomStudents.filter(student => Number.isFinite(student.attention));
    const averageAttention = observed.length ? Math.round(observed.reduce((sum, student) => sum + student.attention, 0) / observed.length) : null;
    return {
      ...room,
      sensorCount,
      cameraCount,
      activeCount,
      sensorOnlyCount,
      averageAttention,
      anomaly: sensorCount ? Math.abs(sensorCount - activeCount) : 0,
      occupancyRate: Math.round((Math.max(sensorCount, activeCount) / room.capacity) * 100),
    };
  });

  const totals = students.reduce(
    (acc, student) => {
      acc.total += 1;
      acc[student.status] = (acc[student.status] || 0) + 1;
      acc.attention += Number(student.attention || 0);
      return acc;
    },
    { total: 0, focused: 0, confused: 0, tired: 0, away: 0, attention: 0 }
  );

  const riskScore = predictRisk({ totals, rooms });
  const measuredCount = students.filter(student => Number.isFinite(student.attention)).length;
  const focusRate = measuredCount ? Math.round((totals.focused / measuredCount) * 100) : 0;
  const observedStudents = students.filter(student => Number.isFinite(student.attention));
  const averageAttention = observedStudents.length ? Math.round(observedStudents.reduce((sum, student) => sum + student.attention, 0) / observedStudents.length) : 0;
  const sensorPresentStudents = rooms.reduce((sum, room) => sum + Number(room.sensorCount || 0), 0);
  const presentStudents = rooms.reduce((sum, room) => sum + Math.max(Number(room.sensorCount || 0), Number(room.activeCount || 0)), 0);
  const sensorAttendees = rooms.flatMap((room) =>
    Array.from({ length: room.sensorOnlyCount }, (_, index) => ({
      id: `${room.id}-sensor-${index + 1}`,
      name: `现场学生 ${index + 1}`,
      roomId: room.id,
      source: "door-sensor",
    }))
  );

  const dashboard = {
    project: {
      name: "AetherClass",
      title: "智课云舱：AI 驱动的线上课堂学情监测系统",
      backend: "Node.js + SQLite 独立账号与课堂存储 + SSE",
    },
    meeting: store.meeting,
    metrics: {
      totalStudents: totals.total,
      observedStudents: observedStudents.length,
      activeStudents: totals.total - totals.away,
      sensorPresentStudents,
      presentStudents,
      focusRate,
      averageAttention,
      confused: totals.confused,
      tired: totals.tired,
      away: totals.away,
      riskScore,
    },
    rooms,
    sensorAttendees,
    students: students.slice().sort((left, right) => Number(left.attention || 0) - Number(right.attention || 0)),
    events: [...store.classroomEvents, ...store.sensorEvents]
      .sort((left, right) => Number(right.createdAt || 0) - Number(left.createdAt || 0))
      .slice(0, 50),
    latestReport: store.aiReports.slice(-1)[0] || null,
    latestReview: store.classReviews.findLast(review => review.meeting?.id === store.meeting.id) || null,
    screenShare: publicScreenShare(),
    poll: pollSummary(store.poll),
  };
  return workflows ? workflows.decorate(store, dashboard) : dashboard;
}

function addClassroomEvent(store, event) {
  const item = {
    id: store.classroomEvents.length + 1,
    createdAt: Date.now(),
    ...event,
  };
  store.classroomEvents.push(item);
  return item;
}

function buildReport(store) {
  const dashboard = computeDashboard(store);
  const weakStudents = dashboard.students.slice(0, 3);
  const anomalyRooms = dashboard.rooms.filter((room) => room.anomaly >= 2);
  const summary =
    !dashboard.metrics.observedStudents ? "暂无有效学生状态样本，请先等待课堂反馈。" :
    dashboard.metrics.riskScore >= 60
      ? "课堂低参与风险较高，建议教师立刻暂停讲授并进行互动检查。"
      : dashboard.metrics.riskScore >= 35
        ? "课堂整体可控，但疑惑和疲劳信号已经出现，需要进行节奏调整。"
        : "课堂状态稳定，可以继续当前教学节奏。";

  return {
    id: store.aiReports.length + 1,
    engine: "rule-based-v1",
    promptTemplate:
      "根据学生状态、摄像头信号、门口传感器人数、课堂反馈和 RAG 问答记录，输出风险、证据和教学建议。",
    summary,
    riskScore: dashboard.metrics.riskScore,
    suggestions: [
      dashboard.metrics.confused ? "对当前知识点补充一个示例，并让学生用反馈按钮确认是否听懂。" : "继续保持当前节奏。",
      dashboard.metrics.tired ? "插入 1 分钟课堂互动或投票，观察注意力是否回升。" : "持续观察疲劳趋势。",
      anomalyRooms.length ? `核验 ${anomalyRooms.map((room) => room.name).join("、")} 的摄像头人数与传感器人数。` : "摄像头人数与传感器人数基本一致。",
    ],
    evidence: {
      focusRate: dashboard.metrics.focusRate,
      averageAttention: dashboard.metrics.averageAttention,
      weakStudents: weakStudents.map((student) => ({
        name: student.name,
        status: statusLabel(student.status),
        attention: student.attention,
      })),
    },
    createdAt: Date.now(),
  };
}

function countBy(items, getKey) {
  return items.reduce((acc, item) => {
    const key = getKey(item);
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function buildClassroomReview(store) {
  const dashboard = computeDashboard(store);
  const students = dashboard.students;
  const statusCounts = {
    focused: students.filter((student) => student.status === "focused").length,
    confused: students.filter((student) => student.status === "confused").length,
    tired: students.filter((student) => student.status === "tired").length,
    away: students.filter((student) => student.status === "away").length,
  };
  const autoStudents = students.filter((student) => student.telemetry);
  const cameraStudents = autoStudents.filter((student) => student.telemetry?.cameraEnabled);
  const eventCounts = countBy([...store.classroomEvents, ...store.sensorEvents], (event) => event.type || "other");
  const feedbackCounts = countBy(store.feedback || [], (item) => item.mood || "课堂反馈");
  const durationMinutes = Math.max(1, Math.round((Date.now() - Number(store.meeting.startedAt || Date.now())) / 60000));
  const statusChart = [
    { key: "unknown", label: "等待采样", value: students.filter(student => !Number.isFinite(student.attention)).length, color: "#94a3b8" },
    { key: "focused", label: "专注", value: statusCounts.focused, color: "#16a34a" },
    { key: "confused", label: "疑惑", value: statusCounts.confused, color: "#d97706" },
    { key: "tired", label: "疲劳", value: statusCounts.tired, color: "#dc2626" },
    { key: "away", label: "离开", value: statusCounts.away, color: "#64748b" },
  ];
  const roomChart = dashboard.rooms.map((room) => ({
    label: room.name,
    cameraCount: room.cameraCount,
    sensorCount: room.sensorCount,
    occupancyRate: room.occupancyRate,
    anomaly: room.anomaly,
  }));
  const eventChart = Object.entries(eventCounts)
    .map(([label, value]) => ({ label, value }))
    .sort((left, right) => right.value - left.value)
    .slice(0, 6);

  return {
    id: store.classReviews.length + 1,
    meeting: {
      code: store.meeting.code,
      title: store.meeting.title,
      topic: store.meeting.topic,
      startedAt: store.meeting.startedAt,
      endedAt: Date.now(),
      durationMinutes,
    },
    metrics: {
      ...dashboard.metrics,
      averageAttention: dashboard.metrics.averageAttention,
      autoTelemetryStudents: autoStudents.length,
      cameraTelemetryStudents: cameraStudents.length,
      feedbackCount: (store.feedback || []).length,
      eventCount: (store.classroomEvents || []).length + (store.sensorEvents || []).length,
    },
    charts: {
      status: statusChart,
      rooms: roomChart,
      events: eventChart,
      feedback: Object.entries(feedbackCounts).map(([label, value]) => ({ label, value })),
    },
    highlights: [
      `本节课持续 ${durationMinutes} 分钟，平均注意力 ${dashboard.metrics.averageAttention}。`,
      `自动遥测覆盖 ${autoStudents.length}/${students.length} 名学生，摄像头信号接入 ${cameraStudents.length} 名学生。`,
      dashboard.metrics.riskScore >= 60
        ? "课堂低参与风险偏高，建议复盘讲授节奏和互动设计。"
        : "课堂风险处于可控区间，可保留当前互动策略并继续优化。",
    ],
    createdAt: Date.now(),
  };
}

function inferStudentStateFromTelemetry(telemetry) {
  const pageVisible = telemetry.pageVisible !== false;
  const windowFocused = telemetry.windowFocused !== false;
  const idleSeconds = Math.max(0, Number(telemetry.idleSeconds || 0));
  const brightness = Number(telemetry.brightness ?? 80);
  const motion = Number(telemetry.motion ?? 4);
  const faceDetected = telemetry.faceDetected;
  const cameraEnabled = telemetry.cameraEnabled === true;

  let attention = 82;
  const reasons = [];

  if (!pageVisible) {
    attention -= 34;
    reasons.push("页面不可见");
  }
  if (!windowFocused) {
    attention -= 22;
    reasons.push("窗口未聚焦");
  }
  if (idleSeconds > 60) {
    attention -= 18;
    reasons.push("长时间无交互");
  } else if (idleSeconds > 25) {
    attention -= 8;
    reasons.push("交互减少");
  }
  if (cameraEnabled && faceDetected === false) {
    attention -= 28;
    reasons.push("未检测到人脸");
  }
  if (cameraEnabled && brightness < 24) {
    attention -= 12;
    reasons.push("画面过暗");
  }
  if (cameraEnabled && motion < 1.2) {
    attention -= 8;
    reasons.push("画面长时间静止");
  }
  if (cameraEnabled && motion > 20) {
    attention -= 10;
    reasons.push("画面波动过大");
  }

  attention = Math.max(0, Math.min(100, Math.round(attention)));
  let status = "focused";
  if (attention < 25 || !pageVisible) {
    status = "away";
  } else if (attention < 50) {
    status = "tired";
  } else if (attention < 68 || reasons.includes("窗口未聚焦")) {
    status = "confused";
  }

  return {
    status,
    attention,
    emotion: emotionFromStatus(status),
    reasons: reasons.length ? reasons : ["课堂状态稳定"],
  };
}

function buildExportSummary(store) {
  const dashboard = computeDashboard(store);
  const report = store.aiReports.slice(-1)[0] || buildReport(store);
  return [
    `# ${store.meeting.title} 学情报告`,
    "",
    `- 课堂码：${store.meeting.code}`,
    `- 主题：${store.meeting.topic}`,
    `- 在线学生：${dashboard.metrics.activeStudents}/${dashboard.metrics.totalStudents}`,
    `- 专注率：${dashboard.metrics.focusRate}%`,
    `- 平均注意力：${dashboard.metrics.averageAttention}`,
    `- 低参与风险：${dashboard.metrics.riskScore}`,
    "",
    "## AI 诊断",
    "",
    report.summary,
    "",
    "## 教学建议",
    "",
    ...report.suggestions.map((item) => `- ${item}`),
    "",
    "## 风险学生",
    "",
    ...dashboard.students
      .slice(0, 5)
      .map((student) => `- ${student.name}：${statusLabel(student.status)}，注意力 ${student.attention}`),
    "",
    "## 教室人数",
    "",
    ...dashboard.rooms.map(
      (room) =>
        `- ${room.name}：摄像头 ${room.cameraCount}，传感器 ${room.sensorCount}，平均注意力 ${room.averageAttention}`
    ),
  ].join("\n");
}

function localNetworkUrls() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((item) => item && item.family === "IPv4" && !item.internal)
    .map((item) => `http://${item.address}:${port}`);
}

function broadcastState() {
  if (!sseClients.size) return;
  const dashboard = computeDashboard(readStore());
  for (const client of sseClients) {
    if (client.session.ownerId !== ownerId()) continue;
    if (!workflows.sessionFor(client.session.token)) { client.end(); sseClients.delete(client); continue; }
    const payload = JSON.stringify(workflows.project(dashboard, client.session));
    client.write("event: state\n");
    client.write(`data: ${payload}\n\n`);
  }
}

function serveStatic(response, requestPath) {
  const relativePath = requestPath === "/" ? "index.html" : decodeURIComponent(requestPath.slice(1));
  const filePath = path.resolve(frontendDir, relativePath);
  if (!filePath.startsWith(frontendDir + path.sep)) {
    sendJson(response, 403, { error: "禁止访问该路径。" });
    return;
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    sendJson(response, 404, { error: "页面不存在。" });
    return;
  }
  const contentTypes = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".wasm": "application/wasm",
    ".task": "application/octet-stream",
    ".tflite": "application/octet-stream",
  };
  const body = fs.readFileSync(filePath);
  response.writeHead(200, {
    "Content-Type": contentTypes[path.extname(filePath)] || "application/octet-stream",
    "Content-Length": body.length,
  });
  response.end(body);
}

async function handleApi(request, response, requestPath) {
  if (await workflows.prepare(request, response, requestPath)) return;
  if (request.method === "GET" && requestPath === "/api/health") {
    sendJson(response, 200, {
      status: "ok",
      service: "aether-class",
      backend: "Node.js + SQLite + SSE",
      timestamp: Date.now(),
    });
    return;
  }

  if (request.method === "GET" && requestPath === "/api/state") {
    sendJson(response, 200, computeDashboard(readStore()));
    return;
  }

  if (request.method === "POST" && requestPath === "/api/classroom/start") {
    const payload = await readJson(request);
    const store = readStore();
    const teacherId = String(payload.teacherId || "");
    const teacherName = String(payload.teacherName || "教师");
    if (!isTeacherIdentity(store, teacherId, teacherName)) {
      sendJson(response, 403, { error: "只有教师身份可以开设课堂。" });
      return;
    }
    const title = String(payload.title || store.meeting.title || "线上课堂").trim();
    const topic = String(payload.topic || store.meeting.topic || "课程主题").trim();
    const roomId = String(payload.roomId || "A101");
    const room = store.rooms.find((item) => item.id === roomId) || store.rooms[0];
    store.meeting = {
      ...store.meeting,
      id: `class-${require("node:crypto").randomUUID()}`,
      notice: null,
      title,
      topic,
      roomId: room.id,
      code: require("node:crypto").randomBytes(5).toString("hex").toUpperCase(),
      status: "live",
      teacherId,
      startedAt: Date.now(),
      endedAt: null,
      teacherName,
    };
    store.students = [];
    store.attendance = [];
    store.comments = [];
    store.commentSettings = { enabled: true };
    store.qaHistory = [];
    store.interventions = [];
    store.timeline = [];
    store.pollHistory = [];
    store.feedback = [];
    store.aiReports = [];
    store.poll = null;
    store.sensorEvents = [];
    store.classroomEvents = [];
    resetScreenShare();
    store.rooms = store.rooms.map((item) => ({
      ...item,
      liveCount: 0,
      sensorCount: 0,
    }));
    addClassroomEvent(store, {
      type: "classroom-start",
      roomId: room.id,
      title: "教师开设课堂",
      detail: `${teacherName} 开设了《${title}》，课堂码 ${store.meeting.code}。`,
    });
    writeStore(store);
    broadcastState();
    sendJson(response, 201, { meeting: store.meeting, state: computeDashboard(store) });
    return;
  }

  if (request.method === "POST" && requestPath === "/api/classroom/join") {
    const payload = await readJson(request);
    const store = readStore();
    const code = normalizeCode(payload.code);
    if (store.meeting.status !== "live" || !store.meeting.code || code !== normalizeCode(store.meeting.code)) {
      sendJson(response, 404, { error: "课堂未开设，或课堂码不正确。" });
      return;
    }
    const studentId = String(payload.studentId || `stu-${Date.now()}`);
    const name = String(payload.name || "演示学生");
    if (isTeacherIdentity(store, studentId, name)) {
      sendJson(response, 403, { error: "教师身份不能加入学生端课堂。" });
      return;
    }
    const roomId = String(payload.roomId || store.meeting.roomId || "A101");
    let user = store.users.find((item) => item.id === studentId);
    if (!user) {
      user = { id: studentId, name, role: "student", roomId };
      store.users.push(user);
    }
    if (user.role !== "student") {
      sendJson(response, 403, { error: "只有学生账号可以加入课堂。" });
      return;
    }
    user.roomId = roomId;
    let student = store.students.find((item) => item.id === studentId);
    if (!student) {
      student = {
        id: studentId,
        name,
        roomId,
        status: "unknown",
        attention: null,
        emotion: "稳定",
        cameraSignal: "join-class",
        mic: "muted",
        handRaised: false,
        joinedAt: Date.now(),
        updatedAt: Date.now(),
      };
      store.students.push(student);
    }
    Object.assign(student, {
      name,
      roomId,
      cameraSignal: student.cameraSignal || "join-class",
      joinedAt: student.joinedAt || Date.now(),
      updatedAt: Date.now(),
    });
    addClassroomEvent(store, {
      type: "student-join",
      roomId,
      title: "学生加入课堂",
      detail: `${name} 通过课堂码 ${store.meeting.code} 加入课堂。`,
    });
    writeStore(store);
    broadcastState();
    sendJson(response, 201, { user, meeting: store.meeting, state: computeDashboard(store) });
    return;
  }

  if (request.method === "GET" && requestPath === "/api/stream") {
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    response.write("event: state\n");
    response.write(`data: ${JSON.stringify(workflows.project(computeDashboard(readStore()), response.session))}\n\n`);
    sseClients.add(response);
    const heartbeat = setInterval(() => {
      if (!workflows.sessionFor(response.session.token)) { response.end(); return; }
      response.write(": heartbeat\n\n");
    }, 15000);
    heartbeat.unref();
    request.on("close", () => { clearInterval(heartbeat); sseClients.delete(response); });
    return;
  }

  if (request.method === "POST" && requestPath === "/api/screen/start") {
    const payload = await readJson(request);
    const store = readStore();
    const teacherId = String(payload.teacherId || "");
    const teacherName = String(payload.teacherName || "教师");
    if (store.meeting.status !== "live") {
      sendJson(response, 409, { error: "课堂尚未开始，不能共享屏幕。" });
      return;
    }
    if (!isTeacherIdentity(store, teacherId, teacherName)) {
      sendJson(response, 403, { error: "只有教师可以共享屏幕。" });
      return;
    }
    resetScreenShare();
    liveScreenShare.active = true;
    liveScreenShare.presenterId = teacherId;
    liveScreenShare.presenterName = teacherName;
    addClassroomEvent(store, {
      type: "screen-share-start",
      roomId: "ALL",
      title: "教师共享屏幕",
      detail: `${teacherName} 开始共享屏幕，学生端将自动显示。`,
    });
    writeStore(store);
    broadcastState();
    sendJson(response, 201, { screenShare: publicScreenShare() });
    return;
  }

  if (request.method === "POST" && requestPath === "/api/screen/frame") {
    const payload = await readJson(request);
    const presenterId = String(payload.teacherId || "");
    const frame = String(payload.frame || "");
    if (!liveScreenShare.active || presenterId !== liveScreenShare.presenterId) {
      sendJson(response, 409, { error: "当前没有属于该教师的屏幕共享。" });
      return;
    }
    if (!/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(frame) || frame.length > 900000) {
      sendJson(response, 400, { error: "屏幕帧格式不正确或超过 900 KB。" });
      return;
    }
    liveScreenShare.frame = frame;
    liveScreenShare.updatedAt = Date.now();
    liveScreenShare.version += 1;
    sendJson(response, 202, { version: liveScreenShare.version, updatedAt: liveScreenShare.updatedAt });
    return;
  }

  if (request.method === "GET" && requestPath === "/api/screen/latest") {
    sendJson(response, 200, {
      ...publicScreenShare(),
      frame: liveScreenShare.active ? liveScreenShare.frame : null,
    });
    return;
  }

  if (request.method === "POST" && requestPath === "/api/screen/stop") {
    const payload = await readJson(request);
    const store = readStore();
    const teacherId = String(payload.teacherId || "");
    if (liveScreenShare.active && teacherId !== liveScreenShare.presenterId) {
      sendJson(response, 403, { error: "只能停止自己发起的屏幕共享。" });
      return;
    }
    const presenterName = liveScreenShare.presenterName || "教师";
    resetScreenShare();
    addClassroomEvent(store, {
      type: "screen-share-stop",
      roomId: "ALL",
      title: "屏幕共享结束",
      detail: `${presenterName} 停止了屏幕共享。`,
    });
    writeStore(store);
    broadcastState();
    sendJson(response, 200, { screenShare: publicScreenShare() });
    return;
  }

  if (request.method === "POST" && requestPath === "/api/student/status") {
    const payload = await readJson(request);
    const store = readStore();
    const studentId = String(payload.studentId || "stu-demo");
    const name = String(payload.name || "演示学生");
    if (isTeacherIdentity(store, studentId, name)) {
      sendJson(response, 403, { error: "教师身份不能写入学生状态。" });
      return;
    }
    const status = String(payload.status || "focused");
    const attention = Math.max(0, Math.min(100, Number(payload.attention ?? 70)));
    let student = store.students.find((item) => item.id === studentId);
    if (!student?.joinedAt) {
      sendJson(response, 409, { error: "学生尚未加入课堂，不能写入课堂状态。" });
      return;
    }
    Object.assign(student, {
      name: String(payload.name || student.name),
      roomId: String(payload.roomId || student.roomId || "A101"),
      status,
      attention,
      selfReport: { status, handRaised: Boolean(payload.handRaised), signal: payload.cameraSignal, createdAt: Date.now() },
      explicitlyAway: payload.cameraSignal === "student-away" ? true : payload.cameraSignal === "student-back" ? false : Boolean(student.explicitlyAway),
      emotion: String(payload.emotion || emotionFromStatus(status)),
      cameraSignal: String(payload.cameraSignal || "camera"),
      mic: String(payload.mic || student.mic || "muted"),
      handRaised: Boolean(payload.handRaised ?? student.handRaised),
      handRaiseSource: typeof payload.handRaised === "boolean" ? "manual" : student.handRaiseSource,
      updatedAt: Date.now(),
    });
    addClassroomEvent(store, {
      type: "camera-status",
      roomId: student.roomId,
      title: "学生状态更新",
      detail: `${student.name}：${statusLabel(status)}，注意力 ${attention}`,
    });
    writeStore(store);
    broadcastState();
    sendJson(response, 201, { student, state: computeDashboard(store) });
    return;
  }

  if (request.method === "POST" && requestPath === "/api/student/telemetry") {
    const payload = await readJson(request);
    const store = readStore();
    const studentId = String(payload.studentId || "stu-demo");
    const name = String(payload.name || "演示学生");
    if (isTeacherIdentity(store, studentId, name)) {
      sendJson(response, 403, { error: "教师身份不能写入学生遥测。" });
      return;
    }
    const inferred = inferStudentStateFromTelemetry(payload);
    let student = store.students.find((item) => item.id === studentId);
    if (!student?.joinedAt) {
      sendJson(response, 409, { error: "学生尚未加入课堂，不能写入自动遥测。" });
      return;
    }
    if (student.explicitlyAway) { inferred.status = "away"; inferred.attention = 0; inferred.emotion = "暂离"; inferred.reasons = ["学生主动暂离，等待点击回到课堂"]; }
    Object.assign(student, {
      name: String(payload.name || student.name),
      roomId: String(payload.roomId || student.roomId || "A101"),
      status: inferred.status,
      attention: inferred.attention,
      emotion: inferred.emotion,
      cameraSignal: payload.cameraEnabled ? "auto-camera-telemetry" : "auto-browser-telemetry",
      handRaised: typeof payload.handRaised === "boolean" ? payload.handRaised : student.handRaiseSource === "camera" ? null : Boolean(student.handRaised),
      handRaiseSource: typeof payload.handRaised === "boolean" ? "camera" : student.handRaiseSource,
      sleeping: typeof payload.sleeping === "boolean" ? payload.sleeping : null,
      telemetry: {
        pageVisible: payload.pageVisible !== false,
        windowFocused: payload.windowFocused !== false,
        idleSeconds: Math.max(0, Number(payload.idleSeconds || 0)),
        brightness: payload.brightness ?? null,
        motion: payload.motion ?? null,
        faceDetected: payload.faceDetected ?? null,
        faceCount: payload.faceCount ?? null,
        faceEngine: payload.faceEngine ? String(payload.faceEngine) : null,
        faceScore: payload.faceScore ?? null,
        cameraEnabled: payload.cameraEnabled === true,
        reasons: inferred.reasons,
      },
      updatedAt: Date.now(),
    });
    addClassroomEvent(store, {
      type: "auto-telemetry",
      roomId: student.roomId,
      title: "自动学情监测",
      detail: `${student.name}：${statusLabel(inferred.status)}，注意力 ${inferred.attention}；依据：${inferred.reasons.join("、")}`,
    });
    writeStore(store);
    broadcastState();
    sendJson(response, 201, { student, inferred, state: computeDashboard(store) });
    return;
  }

  if (request.method === "POST" && requestPath === "/api/sensor/event") {
    const payload = await readJson(request);
    const store = readStore();
    if (store.meeting.status !== "live") {
      sendJson(response, 409, { error: "请先开设课堂，再接收传感器进出事件。" });
      return;
    }
    const roomId = String(payload.roomId || "A101");
    const type = String(payload.type || "enter");
    const room = store.rooms.find((item) => item.id === roomId);
    if (!room) {
      sendJson(response, 404, { error: "教室不存在。" });
      return;
    }
    const delta = type === "leave" ? -1 : 1;
    room.sensorCount = Math.max(0, Number(room.sensorCount || 0) + delta);
    room.liveCount = Math.max(0, Math.min(room.capacity, Number(room.liveCount || 0) + delta));
    const event = {
      id: store.sensorEvents.length + 1,
      type,
      roomId,
      title: type === "leave" ? "门口传感器：离开" : "门口传感器：进入",
      detail: `${room.name} 传感器人数更新为 ${room.sensorCount}`,
      source: "door-sensor",
      confidence: Number(payload.confidence || 0.96),
      createdAt: Date.now(),
    };
    store.sensorEvents.push(event);
    writeStore(store);
    broadcastState();
    sendJson(response, 201, { event, room, state: computeDashboard(store) });
    return;
  }

  if (request.method === "POST" && requestPath === "/api/meeting/control") {
    const payload = await readJson(request);
    const store = readStore();
    const action = String(payload.action || "notice");
    const operator = String(payload.operator || "教师");
    const actionMap = {
      muteAll: {
        title: "课堂安静提示",
        detail: `${operator} 提醒大家保持安静，认真参与本节课堂。`,
      },
      startPoll: {
        title: "发起课堂投票",
        detail: `${operator} 发起了课堂理解度投票。`,
      },
      shareMaterial: {
        title: "共享课程资料",
        detail: `${operator} 共享了当前课程资料，学生端可结合 RAG 提问。`,
      },
      endClass: {
        title: "课堂结束",
        detail: `${operator} 结束了本次课堂，并准备导出学情报告。`,
      },
    };
    const event = actionMap[action] || {
      title: "课堂通知",
      detail: String(payload.detail || "教师发布了一条课堂通知。"),
    };
    if (["muteAll", "shareMaterial"].includes(action)) {
      store.meeting.notice = { id: Date.now(), title: event.title, message: event.detail };
    }
    if (action === "startPoll") {
      if (store.poll) store.pollHistory.push(structuredClone(store.poll));
      const question = String(payload.question || "本节内容理解了吗？").trim().slice(0, 80);
      store.poll = {
        id: `poll-${Date.now()}`,
        question: question || "本节内容理解了吗？",
        options: ["已理解", "需要再讲"],
        status: "active",
        answers: {},
        createdAt: Date.now(),
        closedAt: null,
      };
    }
    addClassroomEvent(store, {
      type: "meeting-control",
      roomId: "ALL",
      ...event,
    });
    writeStore(store);
    broadcastState();
    sendJson(response, 201, { event, state: computeDashboard(store) });
    return;
  }

  if (request.method === "POST" && requestPath === "/api/poll/vote") {
    const payload = await readJson(request);
    const store = readStore();
    const poll = store.poll;
    const studentId = String(payload.studentId || "");
    const option = String(payload.option || "");
    const student = store.students.find((item) => item.id === studentId && item.joinedAt);
    if (!student) {
      sendJson(response, 403, { error: "只有已加入课堂的学生可以投票。" });
      return;
    }
    if (!poll || poll.status !== "active") {
      sendJson(response, 409, { error: "当前没有进行中的投票。" });
      return;
    }
    if (!poll.options.includes(option)) {
      sendJson(response, 400, { error: "投票选项无效。" });
      return;
    }
    poll.answers = poll.answers || {};
    poll.answers[studentId] = option;
    writeStore(store);
    broadcastState();
    sendJson(response, 200, { poll: pollSummary(poll) });
    return;
  }

  if (request.method === "POST" && requestPath === "/api/poll/close") {
    const payload = await readJson(request);
    const store = readStore();
    const teacherId = String(payload.teacherId || "");
    const teacherName = String(payload.teacherName || "教师");
    if (!isTeacherIdentity(store, teacherId, teacherName)) {
      sendJson(response, 403, { error: "只有教师可以结束投票。" });
      return;
    }
    if (!store.poll || store.poll.status !== "active") {
      sendJson(response, 409, { error: "当前没有进行中的投票。" });
      return;
    }
    store.poll.status = "closed";
    store.poll.closedAt = Date.now();
    addClassroomEvent(store, {
      type: "poll-close",
      roomId: "ALL",
      title: "课堂投票结束",
      detail: `${teacherName} 结束了投票，共收到 ${Object.keys(store.poll.answers || {}).length} 份回答。`,
    });
    writeStore(store);
    broadcastState();
    sendJson(response, 200, { poll: pollSummary(store.poll) });
    return;
  }

  if (request.method === "POST" && requestPath === "/api/feedback") {
    const payload = await readJson(request);
    const store = readStore();
    const item = {
      id: store.feedback.length + 1,
      studentId: String(payload.studentId || ""),
      roomId: String(payload.roomId || "A101"),
      mood: String(payload.mood || "听懂"),
      message: String(payload.message || "课堂反馈"),
      createdAt: Date.now(),
    };
    store.feedback.push(item);
    addClassroomEvent(store, {
      type: "feedback",
      roomId: item.roomId,
      title: "课堂反馈",
      detail: `${item.mood}：${item.message}`,
    });
    writeStore(store);
    broadcastState();
    sendJson(response, 201, item);
    return;
  }

  if (request.method === "POST" && requestPath === "/api/ask") {
    const payload = await readJson(request);
    const question = String(payload.question || "").trim();
    if (!question) {
      sendJson(response, 400, { error: "question 不能为空。" });
      return;
    }
    const store = readStore();
    const sources = retrieveKnowledge(question, store.knowledgeDocs);
    const dashboard = computeDashboard(store);
    let engine = "local-fallback";
    let model = "none";
    let answer = "";
    try {
      const aiResult = await answerWithExternalAi(question, sources, dashboard);
      if (aiResult) {
        answer = aiResult.answer;
        engine = aiResult.engine;
        model = aiResult.model;
      } else {
        answer = localAnswer(question, sources);
      }
    } catch (error) {
      engine = "external-error-local-fallback";
      answer = `${localAnswer(question, sources)}\n\n外部 AI 暂不可用，已切换为本地资料检索。`;
    }
    // 外部模型调用期间可能发生并发上报；必须重新读取最新数据再合并。
    const current = readStore();
    if (current.meeting.id !== store.meeting.id || current.meeting.status !== "live") {
      sendJson(response, 409, { error: "课堂已结束或变化，本次回答未写入新课堂。" }); return;
    }
    const item = {
      id: current.qaHistory.length + 1,
      meetingId: store.meeting.id,
      userId: String(payload.userId || ""),
      question,
      answer,
      engine,
      model,
      sources,
      createdAt: Date.now(),
    };
    current.qaHistory.push(item);
    writeStore(current);
    broadcastState();
    sendJson(response, 201, item);
    return;
  }

  if (request.method === "POST" && requestPath === "/api/ai/analyze") {
    const store = readStore();
    const report = buildReport(store);
    store.aiReports.push(report);
    addClassroomEvent(store, {
      type: "ai-report",
      roomId: "ALL",
      title: "AI 学情报告",
      detail: `${report.summary} 风险分 ${report.riskScore}`,
    });
    writeStore(store);
    broadcastState();
    sendJson(response, 201, report);
    return;
  }

  if (request.method === "GET" && requestPath === "/api/report/export") {
    const store = readStore();
    sendJson(response, 200, {
      filename: `${store.meeting.id}-report.md`,
      content: buildExportSummary(store),
      createdAt: Date.now(),
    });
    return;
  }

  sendJson(response, 404, { error: "接口不存在。" });
}

const server = http.createServer((request, response) => requestContext.run({ ownerId: null }, async () => {
  try {
    const requestUrl = new URL(request.url, "http://localhost");
    if (requestUrl.pathname.startsWith("/api/")) {
      await handleApi(request, response, requestUrl.pathname);
      return;
    }
    serveStatic(response, requestUrl.pathname);
  } catch (error) {
    if (!response.headersSent) sendJson(response, error.status || 500, { error: error.status ? error.message : "服务暂时不可用，请重试。" });
    else response.end();
    if (!error.status) console.error(error);
  }
}));

workflows = require("./workflows").createWorkflows({
  database: storage, ownerId, setOwner,
  read: readStore, write: writeStore, readJson, send: sendJson, dashboard: computeDashboard,
  review: buildClassroomReview, event: addClassroomEvent, broadcast: broadcastState, resetScreen: resetScreenShare,
  closeSession: session => { for (const client of sseClients) if (client.session === session) { client.end(); sseClients.delete(client); } },
});
ensureStore();
const presenceTimer = setInterval(() => {
  for (const id of storage.ownerIds()) requestContext.run({ ownerId: id }, broadcastState);
}, 15000);
presenceTimer.unref();
server.listen(port, host, () => {
  console.log(`AetherClass local URL: http://127.0.0.1:${port}`);
  if (lanMode || host === "0.0.0.0") {
    const urls = localNetworkUrls();
    if (urls.length) {
      console.log("LAN classroom URLs:");
      urls.forEach((url) => console.log(`- ${url}`));
    }
  } else {
    console.log("Run `npm run start:lan` to allow classmates on the same Wi-Fi to join.");
  }
  if (process.env.PUBLIC_URL) {
    console.log(`Public classroom URL: ${process.env.PUBLIC_URL}`);
  } else {
    console.log("Different networks require a public HTTPS deployment or tunnel; 127.0.0.1 cannot be shared.");
  }
});
