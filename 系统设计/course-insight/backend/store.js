const fs = require("node:fs");
const path = require("node:path");

/** 同步事务只覆盖短小 JSON 读写；网络请求必须在事务外完成，再读取最新状态合并。 */
function createStore(dataDir, defaults) {
  const storePath = path.join(dataDir, "store.json");
  fs.mkdirSync(dataDir, { recursive: true });
  const clone = (value) => JSON.parse(JSON.stringify(value));
  function read() { return JSON.parse(fs.readFileSync(storePath, "utf8").replace(/^\uFEFF/, "")); }
  function write(value, backup = true) {
    const temporary = storePath + ".tmp";
    const descriptor = fs.openSync(temporary, "w");
    try {
      fs.writeFileSync(descriptor, JSON.stringify(value, null, 2), "utf8");
      fs.fsyncSync(descriptor);
    } finally { fs.closeSync(descriptor); }
    // 原子替换避免进程中断留下半份 JSON；保留上一份完整快照供恢复。
    if (backup && fs.existsSync(storePath)) fs.copyFileSync(storePath, storePath + ".bak");
    fs.renameSync(temporary, storePath);
  }
  function initialize() {
    if (!fs.existsSync(storePath)) { write(clone(defaults)); return; }
    let current;
    let recovered = false;
    try { current = read(); }
    catch (error) {
      // 损坏文件先留存，不能直接用空数据覆盖用户的课堂记录。
      fs.copyFileSync(storePath, storePath + ".corrupt-" + Date.now());
      if (!fs.existsSync(storePath + ".bak")) throw new Error("课堂数据损坏且没有备份，请恢复 store.json；原文件已保留。");
      current = JSON.parse(fs.readFileSync(storePath + ".bak", "utf8"));
      recovered = true;
    }
    const upgraded = { ...clone(defaults), ...current, schemaVersion: defaults.schemaVersion };
    for (const [key, value] of Object.entries(defaults)) {
      if (Array.isArray(value) && !Array.isArray(upgraded[key])) upgraded[key] = clone(value);
    }
    upgraded.meeting = { ...defaults.meeting, ...current.meeting };
    // 迁移保留旧版本全部业务数据，只补齐课堂归属字段。
    for (const key of ["students", "feedback", "qaHistory", "aiReports", "classroomEvents", "sensorEvents", "interventions", "pollHistory", "timeline"]) {
      upgraded[key] = upgraded[key].map((item) => ({ meetingId: upgraded.meeting.id, ...item }));
    }
    if (upgraded.poll) upgraded.poll.meetingId = upgraded.poll.meetingId || upgraded.meeting.id;
    // 即使备份已经是最新 schema，也必须把恢复内容写回主文件。
    // 恢复时保留有效备份，不能用损坏的主文件覆盖它。
    if (recovered || JSON.stringify(upgraded) !== JSON.stringify(current)) write(upgraded, !recovered);
  }
  return { read, write, initialize, storePath };
}
module.exports = { createStore };
