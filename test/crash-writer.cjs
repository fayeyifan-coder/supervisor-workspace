const { DatabaseSync } = require("node:sqlite");
const { WorkspaceDatabase } = require("../build/database.js");

const [, , path, marker, payload, uncommittedId] = process.argv;
const lesson = JSON.parse(payload);
const store = WorkspaceDatabase.open(path, marker);
store.addLesson(lesson);

const writer = new DatabaseSync(path);
writer.exec("BEGIN IMMEDIATE");
writer.prepare("INSERT INTO learning_records VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
  .run(uncommittedId, lesson.studentId, lesson.date, "数学", "未提交的虚构任务", "未提交", "", "", Date.now());
process.stdout.write("committed-and-open\n");
setInterval(() => {}, 1000);
