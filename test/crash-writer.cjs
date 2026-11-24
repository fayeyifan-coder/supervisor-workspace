const { DatabaseSync } = require("node:sqlite");

const db = new DatabaseSync(process.argv[2]);
const now = Date.now();
db.exec("PRAGMA synchronous = FULL; BEGIN IMMEDIATE");
db.prepare("INSERT INTO sample_record VALUES (1, ?, 1, ?, ?)").run("虚构已提交值", now, now);
db.exec("COMMIT; BEGIN IMMEDIATE");
db.prepare("UPDATE sample_record SET content = ?, revision = 2 WHERE id = 1").run("虚构未提交值");
process.stdout.write("committed-and-open\n");
setInterval(() => {}, 1000);
