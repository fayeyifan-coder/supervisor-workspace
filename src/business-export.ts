import { createHash, randomUUID } from "node:crypto";
import { freemem } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { validateProtection } from "./offline-protection";
import { WorkspaceFault } from "./workspace-fault";
import { columnLabels, exportTablesFor, type ExportRole } from "./business-export-schema";
import { studentRecordDefinitions, studentRecordFields, type StudentRecordKind } from "./student-records";

export type ExportValue = string | number | null | { sqliteInteger: string };
export interface ExportTableSummary {
 store: string; table: string; sheet: string; role: ExportRole; sourceColumns: string[]; columns: string[];
 sourceRows: number; exportedRows: number; entities: number; entityKey: string; historicalRows: number; excludedColumns: string[]; reason: string;
}
export interface BusinessExportPreview {
 token: string; snapshotId: string; capturedAt: string; expiresAt: string; students: number; rows: number;
 includeSourceText: boolean; tables: ExportTableSummary[];
}
export interface BusinessExportResult {
 location: string; snapshotId: string; capturedAt: string; rows: number; longTextCells: number;
 files: { name: string; bytes: number; sha256: string }[];
}
export interface BusinessExportDocument {
 format: "sw-business-data-v1"; snapshotId: string; capturedAt: string; applicationVersion: string;
 m1Version: 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15; includeSourceText: boolean; sourceImages: { file: string; sha256: string }[];
 tables: (ExportTableSummary & { rows: Record<string, ExportValue>[] })[];
}
const maxJsonBytes = 32 * 1024 * 1024;
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function invalid(message: string): never { throw new WorkspaceFault("invalid", message); }

export function businessExportDocument(bytes: Buffer, includeSourceText: boolean): BusinessExportDocument {
 const checked = validateProtection(bytes);
 const m1Version = checked.summary.m1Version;
 if (checked.summary.formatVersion !== 2 || m1Version < 6) invalid("业务导出需要五库 v6 或更新档案。请继续使用完整备份。");
 if (checked.summary.unfinishedImports) throw new WorkspaceFault("recovery", "存在未完成导入，请先核对处理，再生成业务导出。");
 const tables: BusinessExportDocument["tables"] = [];
 for (let index = 0; index < checked.images.length; index++) {
  const store = checked.manifest.databases[index].file.replace(/\.sqlite3$/, "");
  const db = new DatabaseSync(":memory:", { allowExtension: false });
  try {
   db.deserialize(Buffer.from(checked.images[index])); db.exec("PRAGMA trusted_schema=OFF; PRAGMA query_only=ON");
   const names = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
   const mappings = exportTablesFor(m1Version).filter(row => row.store === store);
   if (JSON.stringify(names) !== JSON.stringify(mappings.map(row => row.name).sort())) invalid("数据库表清单尚未适配，未生成不完整导出。");
   for (const mapping of mappings) {
    const actual = db.prepare(`PRAGMA table_info(${mapping.name})`).all().map(row => row.name);
    if (JSON.stringify(actual) !== JSON.stringify(mapping.columns)) invalid("数据库字段清单尚未适配，未生成不完整导出。");
    const count = Number(db.prepare(`SELECT count(*) AS n FROM ${mapping.name}`).get()!.n);
    const excludedColumns = mapping.name === "study_plan_sources" ? ["document_bytes", ...(!includeSourceText ? ["cells_json"] : [])]
      : mapping.name === "intake_jobs" && !includeSourceText ? ["source_json"] : [];
    const columns = mapping.columns.filter(name => !excludedColumns.includes(name));
    const rows: Record<string, ExportValue>[] = [];
    if (mapping.role !== "internal") {
     const query = db.prepare(`SELECT ${columns.join(",")} FROM ${mapping.name} ORDER BY ${columns.join(",")}`);
     query.setReadBigInts(true);
     for (const source of query.iterate()) {
      const row: Record<string, ExportValue> = {};
      for (const column of columns) {
       const value = source[column];
       if (typeof value === "bigint") row[column] = value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(value) : { sqliteInteger: value.toString() };
       else if (value === null || typeof value === "string" || typeof value === "number" && Number.isFinite(value)) row[column] = value;
       else invalid("存在未适配的数据类型，未生成不完整导出。");
      }
      rows.push(row);
     }
    }
    const entityKey = mapping.name === "work_changes" ? "item_id" : mapping.name === "parent_followups" ? "concern_id" : columns.includes("entity_id") ? "entity_id" : columns.includes("id") ? "id" : columns.includes("student_id") ? "student_id" : columns[0];
    const entities = new Set(rows.map(row => String(row[entityKey]))).size;
    tables.push({store, table: mapping.name, sheet: mapping.sheet, role: mapping.role, sourceColumns: [...mapping.columns], columns,
     sourceRows: count, exportedRows: rows.length, entities, entityKey, historicalRows: mapping.role === "history" ? rows.length : mapping.columns.includes("entity_id") ? rows.length - entities : 0,
     excludedColumns, reason: mapping.name === "study_plan_sources" ? "本次 XLSX/JSON 保留原件身份和摘要，Word 原件字节仅纳入 SWBACK2；原文位置及文本按导出选项处理。" : mapping.name === "student_lifecycle" ? "按学生及修订保留全部状态历史。无状态历史的学生默认为正常跟进（active）。" : mapping.role === "internal" ? "内部未决/幂等安全状态不作为业务记录导出；完整恢复请用 SWBACK2。" :
      excludedColumns.length ? "默认不包含导入原文 source_json；其余已确认业务和来源身份完整保留。" : "全部原始业务行及历史修订，未使用界面分页或最新版本查询。", rows});
   }
  } finally { db.close(); }
 }
 const result: BusinessExportDocument = {format: "sw-business-data-v1", snapshotId: hash(bytes), capturedAt: checked.summary.createdAt,
  applicationVersion: checked.summary.applicationVersion, m1Version: m1Version as BusinessExportDocument["m1Version"], includeSourceText,
  sourceImages: checked.manifest.databases.map(row => ({file: row.file, sha256: row.sha256})), tables};
 const size = Buffer.byteLength(JSON.stringify(result));
 if (size > maxJsonBytes || Math.min(freemem(), process.availableMemory()) < size * 16 + 128 * 1024 * 1024) {
  throw new WorkspaceFault("failed", "本次导出超过当前内存或 32 MiB 原始 JSON 上限，未截断任何记录。请保留完整备份。");
 }
 return result;
}

// One immutable, short-lived plan per window/profile. No business contents go to the renderer.
export class BusinessExportPlans {
 private plan?: {token: string; context: string; expires: number; document: BusinessExportDocument};
 private timer?: ReturnType<typeof setTimeout>;
 clear(): void { if (this.timer) clearTimeout(this.timer); this.timer = undefined; this.plan = undefined; }
 prepare(context: string, bytes: Buffer, includeSourceText: boolean, now = Date.now()): BusinessExportPreview {
  this.clear(); const document = businessExportDocument(bytes, includeSourceText); const token = randomUUID(); const expires = now + 15 * 60 * 1000;
  this.plan = {token, context, expires, document}; this.timer = setTimeout(() => this.clear(), 15 * 60 * 1000); this.timer.unref();
  return {token, snapshotId: document.snapshotId, capturedAt: document.capturedAt, expiresAt: new Date(expires).toISOString(),
   students: document.tables.find(row => row.table === "students")!.exportedRows,
   rows: document.tables.reduce((sum, row) => sum + row.exportedRows, 0), includeSourceText,
   tables: document.tables.map(({rows: _rows, ...summary}) => summary)};
 }
 peek(token: string, context: string, now = Date.now()): BusinessExportDocument {
  if (!this.plan || this.plan.token !== token || this.plan.context !== context || now >= this.plan.expires) {
   if (this.plan && now >= this.plan.expires) this.clear();
   throw new WorkspaceFault("conflict", "导出预览已失效或所属档案已变化，请重新预览。");
  }
  return this.plan.document;
 }
 take(token: string, context: string): BusinessExportDocument { const document = this.peek(token, context); this.clear(); return document; }
 cancel(token: string, context: string): void { this.peek(token, context); this.clear(); }
}

type LongText = {ref: string; table: string; record: number; column: string; part: number; total: number; fragment: string};
export async function businessExportPayload(document: BusinessExportDocument, sheetRowLimit = 1_048_575) {
 if (!Number.isSafeInteger(sheetRowLimit) || sheetRowLimit < 1 || sheetRowLimit > 1_048_575) invalid("Excel 分表范围无效。");
 // Official self-contained ExcelJS distribution, copied from the pinned package during build.
 const Excel = require("./exceljs.runtime.js") as typeof import("exceljs");
 const workbook = new Excel.Workbook(); workbook.creator = "Supervisor Workspace"; workbook.created = new Date(document.capturedAt);
 const longText: LongText[] = []; let longTextCells = 0;
 const workbookSheets: {sheet: string; table: string; sourceStart: number; sourceEnd: number; columns: string[]}[] = [];
 function sheet(name: string, headings: string[]) {
  const result = workbook.addWorksheet(name, {views: [{state: "frozen", ySplit: 1}]});
  result.columns = headings.map((header, i) => ({header, key: String(i), width: Math.min(55, Math.max(18, header.length + 6))}));
  result.getRow(1).font = {bold: true, color: {argb: "FFFFFFFF"}};
  result.getRow(1).fill = {type: "pattern", pattern: "solid", fgColor: {argb: "FF17664D"}};
  result.getRow(1).height = 26; result.autoFilter = {from: {row: 1, column: 1}, to: {row: 1, column: headings.length}};
  return result;
 }
 function text(value: ExportValue): string { return value === null ? "⟪NULL⟫" : typeof value === "object" ? value.sqliteInteger : String(value); }
 function cellValue(value: string, table: string, record: number, column: string) {
  if (value.length <= 30000 && (value.match(/\n/g)?.length ?? 0) <= 250 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/.test(value) && Buffer.from(value, "utf8").toString("utf8") === value) return value;
  const ref = "LT" + String(++longTextCells).padStart(6, "0"); const encoded = JSON.stringify(value); const fragments: string[] = [];
  for (let start = 0; start < encoded.length;) { let end = Math.min(start + 16000, encoded.length); if (end < encoded.length && /[\uD800-\uDBFF]/.test(encoded[end - 1])) end--; fragments.push(encoded.slice(start, end)); start = end; }
  fragments.forEach((fragment, index) => longText.push({ref, table, record, column, part: index + 1, total: fragments.length, fragment}));
  return `[长文本 ${ref}：见长文本分片表及配套 JSON，原值未截断]`;
 }
 function add(target: ReturnType<typeof sheet>, values: string[]) {
  const row = target.addRow(values); row.alignment = {vertical: "top", wrapText: true}; row.height = 34;
  row.eachCell(cell => {cell.numFmt = "@";}); // Strings only: never formula/hyperlink objects or automatic numeric/date coercion.
 }
 const cover = sheet("导出说明", ["项目", "内容"]);
 for (const row of [["范围", `当前五库 v${document.m1Version} 的全部已提交业务及历史修订。完整恢复请使用 SWBACK2。`], ["数据截至", document.capturedAt],
  ["快照身份", document.snapshotId], ["原始数据", "business-data.json 是保真原值；本 XLSX 全部业务单元格按文本写入，公式不执行。"],
  ["空值", "SQL NULL 显示为 ⟪NULL⟫；空字符串为空白。超过安全整数范围的整数在 JSON 中用 sqliteInteger 十进制标签保留。"],
  ["长文本", "超长、过多换行或 Excel 不支持的字符使用分片表；按同一引用拼接 fragment 后 JSON.parse 可还原完整字符串。"],
  ["来源原文", document.includeSourceText ? "用户明确包含导入原文；请本机核对机构自由文本，不对外上传。" : "默认排除 intake_jobs.source_json；范围/记录数见表清单。"],
  ["内部状态", "未决编辑、成长幂等回执及教务幂等回执不输出业务正文；表清单明确记录数量。完整恢复请用 SWBACK2。"],
  ["附件", "本次仅覆盖五库已存内容，不含数据库外原始 Word/Excel、浏览器 Profile、日志或未来附件。"],
  ["完成标记", "只有 export.complete 存在且与 export-manifest.json 摘要一致才表示导出完成。"]]) add(cover, row);
 const inventory = sheet("表清单", ["库", "原表", "Excel表", "角色", "源行数", "导出行数", "实体数", "实体键", "历史行数", "排除字段", "范围说明"]);
 const fields = sheet("字段映射", ["库", "原表", "源字段", "XLSX列", "说明"]);
 for (const table of document.tables) {
  add(inventory, [table.store, table.table, table.role === "internal" ? "不导出正文" : table.sheet, table.role, String(table.sourceRows), String(table.exportedRows), String(table.entities), table.entityKey, String(table.historicalRows), table.excludedColumns.join(","), table.reason]);
  for (const column of table.sourceColumns) add(fields, [table.store, table.table, column, table.role === "internal" || !table.columns.includes(column) ? "排除" : (columnLabels[column] ?? column) + " [" + column + "]", table.reason]);
  if (table.role === "internal") continue;
  // Payload keeps its original JSON column AND decoded fields for human reading.
  const kind = (Object.keys(studentRecordDefinitions) as StudentRecordKind[]).find(key => studentRecordDefinitions[key].table === table.table);
  const payloadFields = table.columns.includes("payload") && kind ? studentRecordFields(kind, document.m1Version) : [];
  const decoded = payloadFields.map(row => row.key);
  const payloadLabel = (key: string) => payloadFields.find(row => row.key === key)?.label ?? key;
  for (const key of decoded) add(fields, [table.store, table.table, "payload." + key, payloadLabel(key) + " [payload." + key + "]", "从同一原始 payload 解码；完整原文列及 JSON 均保留。"]);
  const metadata = new Set(["id","entity_id","student_id","request_id","revision","created_at","updated_at","saved_at","changed_at","recorded_at","digest"]);
  const displayColumns = [...table.columns].sort((a,b) => Number(metadata.has(a)) - Number(metadata.has(b)));
  for (let start = 0, part = 1; start < Math.max(table.rows.length, 1); start += sheetRowLimit, part++) {
   const name = table.sheet + (part > 1 ? "-" + part : ""); const headings = [...decoded.map(key => payloadLabel(key) + " [payload." + key + "]"), ...displayColumns.map(column => (columnLabels[column] ?? column) + " [" + column + "]")];
   const target = sheet(name, headings); workbookSheets.push({sheet: name, table: table.table, sourceStart: start, sourceEnd: Math.min(start + sheetRowLimit, table.rows.length), columns: [...decoded.map(key => "payload." + key), ...displayColumns]});
   for (const [offset, row] of table.rows.slice(start, start + sheetRowLimit).entries()) {
    const rawPayload = decoded.length ? JSON.parse(String(row.payload)) : {};
    const payload: Record<string, ExportValue> = kind === "score" && rawPayload.version === 2 ? rawPayload.fields : rawPayload;
    add(target, [...decoded.map(key => cellValue(payload[key] === undefined ? "" : text(payload[key]), table.table, start + offset + 1, "payload." + key)), ...displayColumns.map(column => cellValue(text(row[column]), table.table, start + offset + 1, column))]);
   }
   if (part % 2 === 0) await new Promise<void>(resolve => setImmediate(resolve));
  }
 }
 for (let start = 0, part = 1; start < longText.length; start += sheetRowLimit, part++) {
  const target = sheet("长文本分片" + (part > 1 ? "-" + part : ""), ["引用", "原表", "源记录序号", "原字段", "分片序号", "总片数", "JSON字符串分片"]);
  for (const row of longText.slice(start, start + sheetRowLimit)) add(target, [row.ref,row.table,String(row.record),row.column,String(row.part),String(row.total),row.fragment]);
 }
 const xlsx = Buffer.from(await workbook.xlsx.writeBuffer({useStyles: true, useSharedStrings: true}));
 const json = Buffer.from(JSON.stringify(document, null, 2));
 const dataFiles = [{name: "business-data.xlsx", bytes: xlsx}, {name: "business-data.json", bytes: json}];
 const manifest = {format: "sw-business-export-v1", snapshotId: document.snapshotId, capturedAt: document.capturedAt,
  rows: document.tables.reduce((sum, row) => sum + row.exportedRows, 0), longTextCells, includeSourceText: document.includeSourceText,
  tables: document.tables.map(({rows: _rows, ...summary}) => summary), workbookSheets,
  files: dataFiles.map(file => ({name: file.name, bytes: file.bytes.length, sha256: hash(file.bytes)}))};
 return {manifest, files: [...dataFiles, {name: "export-manifest.json", bytes: Buffer.from(JSON.stringify(manifest, null, 2))}]};
}
