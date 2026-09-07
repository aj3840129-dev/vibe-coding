const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID, randomBytes, scrypt, timingSafeEqual, createHash } = require("node:crypto");
const { promisify } = require("node:util");
const deriveKey = promisify(scrypt);
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };

/** SQLite 是唯一在线数据源；账号独立建表，教学状态和归档都具有强制 owner_id。 */
function createDatabase(dataDir, defaults) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, "aether.sqlite"));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('teacher','student')),
      salt TEXT NOT NULL, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workspaces (
      owner_id TEXT PRIMARY KEY REFERENCES accounts(id), state_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS live_classes (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL UNIQUE REFERENCES accounts(id),
      code TEXT NOT NULL UNIQUE, title TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS classroom_archives (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES accounts(id),
      title TEXT NOT NULL, ended_at INTEGER, archive_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS archive_owner ON classroom_archives(owner_id, ended_at);
    CREATE TABLE IF NOT EXISTS active_memberships (
      student_id TEXT PRIMARY KEY REFERENCES accounts(id),
      owner_id TEXT NOT NULL REFERENCES accounts(id), class_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS legacy_imports (
      checksum TEXT PRIMARY KEY, imported_at INTEGER NOT NULL, source_json TEXT NOT NULL
    );
  `);
  // 旧演示姓名不是可证明的账号。只保全旧数据，不按相同姓名自动授予历史访问权。
  const oldFile = path.join(dataDir, "store.json");
  if (fs.existsSync(oldFile)) {
    const raw = fs.readFileSync(oldFile, "utf8");
    db.prepare("INSERT OR IGNORE INTO legacy_imports VALUES (?, ?, ?)").run(createHash("sha256").update(raw).digest("hex"), Date.now(), raw);
  }
  const publicAccount = account => ({ id: account.id, username: account.username, name: account.name, role: account.role, roomId: "A101" });

  async function register(p) {
    const username = String(p.username || "").trim().toLowerCase();
    if (!/^[a-z0-9_.-]{3,32}$/.test(username)) fail(400, "账号须为 3–32 位字母、数字、点、下划线或短横线。");
    if (typeof p.password !== "string" || p.password.length < 8 || p.password.length > 128) fail(400, "密码须为 8–128 位。");
    if (!["teacher", "student"].includes(p.role)) fail(400, "请选择账号身份。");
    const name = String(p.name || "").trim();
    if (!name || name.length > 40) fail(400, "请填写 1–40 字的姓名。");
    if (p.role === "teacher" && process.env.TEACHER_ACCESS_CODE && p.accessCode !== process.env.TEACHER_ACCESS_CODE) fail(403, "教师注册邀请码不正确。");
    if (db.prepare("SELECT id FROM accounts WHERE username = ?").get(username)) fail(409, "该账号已注册，请直接登录。");
    const salt = randomBytes(16).toString("hex");
    const hash = (await deriveKey(p.password, salt, 64)).toString("hex");
    const account = { id: randomUUID(), username, name, role: p.role };
    try {
      db.prepare("INSERT INTO accounts VALUES (?, ?, ?, ?, ?, ?, ?)").run(account.id, username, name, p.role, salt, hash, Date.now());
    } catch (error) { if (String(error.message).includes("UNIQUE")) fail(409, "该账号已注册。"); throw error; }
    if (account.role === "teacher") write(account.id, fresh(account.id));
    return publicAccount(account);
  }
  async function login(p) {
    const username = String(p.username || "").trim().toLowerCase();
    const account = db.prepare("SELECT * FROM accounts WHERE username = ?").get(username);
    if (typeof p.password !== "string" || p.password.length > 128) fail(401, "账号或密码错误。");
    const actual = await deriveKey(p.password, account?.salt || "missing-account-salt", 64);
    if (!account || !timingSafeEqual(actual, Buffer.from(account.password_hash, "hex"))) fail(401, "账号或密码错误。");
    if (p.role && p.role !== account.role) fail(403, "该账号的身份与所选入口不一致。");
    return publicAccount(account);
  }
  function fresh(ownerId) {
    const state = structuredClone(defaults);
    state.schemaVersion = 8;
    state.meeting.id = "draft-" + (ownerId || "student");
    state.meeting.teacherId = ownerId || "";
    state.users = [];
    state.knowledgeDocs = [];
    return state;
  }
  function read(ownerId) {
    if (!ownerId) return fresh(null);
    const row = db.prepare("SELECT state_json FROM workspaces WHERE owner_id = ?").get(ownerId);
    return row ? { ...fresh(ownerId), ...JSON.parse(row.state_json) } : fresh(ownerId);
  }
  function write(ownerId, state) {
    if (!ownerId) throw new Error("拒绝写入未绑定账号的课堂状态。");
    if (state.meeting.teacherId && state.meeting.teacherId !== ownerId) throw new Error("课堂所有者不匹配。");
    state.meeting.teacherId = ownerId;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("INSERT INTO workspaces VALUES (?, ?, ?) ON CONFLICT(owner_id) DO UPDATE SET state_json=excluded.state_json, updated_at=excluded.updated_at").run(ownerId, JSON.stringify(state), Date.now());
      db.prepare("DELETE FROM live_classes WHERE owner_id = ?").run(ownerId);
      if (state.meeting.status === "live") db.prepare("INSERT INTO live_classes VALUES (?, ?, ?, ?)").run(state.meeting.id, ownerId, state.meeting.code, state.meeting.title);
      for (const archive of state.archives || []) db.prepare("INSERT OR IGNORE INTO classroom_archives VALUES (?, ?, ?, ?, ?)").run(archive.meeting.id, ownerId, archive.meeting.title, archive.meeting.endedAt, JSON.stringify(archive));
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  return {
    register, login, read, write,
    ownerIds: () => db.prepare("SELECT owner_id FROM workspaces").all().map(row => row.owner_id),
    classByCode: code => db.prepare("SELECT * FROM live_classes WHERE code = ?").get(String(code || "").trim().toUpperCase()),
    membership: id => db.prepare("SELECT m.* FROM active_memberships m JOIN live_classes c ON c.id = m.class_id AND c.owner_id=m.owner_id WHERE m.student_id=?").get(id),
    bindStudent: (studentId, ownerId, classId) => db.prepare("INSERT INTO active_memberships VALUES (?, ?, ?) ON CONFLICT(student_id) DO UPDATE SET owner_id=excluded.owner_id,class_id=excluded.class_id").run(studentId, ownerId, classId),
    account: id => { const row = db.prepare("SELECT * FROM accounts WHERE id=?").get(id); return row ? publicAccount(row) : null; },
  };
}

module.exports = { createDatabase };
