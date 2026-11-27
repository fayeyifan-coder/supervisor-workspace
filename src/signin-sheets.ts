import { createHash, randomUUID } from "node:crypto";
import { lstat, link, mkdtemp, open, realpath, rmdir, stat, unlink } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import type { Worksheet } from "exceljs";
import type { Student } from "./contracts";
import type { OperationsDatabase } from "./operations";
import { scheduleId, scheduleObject } from "./recurring-schedule";
import { shanghaiMinute, shanghaiParts } from "./schedule-calendar";
import { signinDates, signinLabels, type SigninChange, type SigninInput, type SigninPreview, type SigninResult } from "./signin-calendar";
import { requireExportDestination } from "./business-export-files";
import { WorkspaceFault } from "./workspace-fault";

function invalid(message: string): never { throw new WorkspaceFault("invalid", message); }

export function readSigninPlan(store: OperationsDatabase, students: Student[], raw: unknown, now = Date.now()): SigninPreview {
  const { kind, period, slots, studentId } = scheduleObject(raw);
  if ((kind !== "weekday" && kind !== "saturday" && kind !== "sunday") || typeof period !== "string") invalid("请选择正确的签到表周期。");
  const dates = signinDates(kind, period);
  if (!dates.length) invalid("请选择有效的机构日期。");
  if (!Array.isArray(slots) || (kind === "weekday" ? slots.length !== 0 : slots.length !== 4)) invalid("周末需要四个打印时段。");
  const periods = slots.map(raw => {
    const { start, end } = scheduleObject(raw);
    if (typeof start !== "string" || typeof end !== "string" || start >= end ||
      shanghaiMinute(dates[0], start) === null || shanghaiMinute(dates[0], end) === null) invalid("打印时段无效。");
    return { start, end };
  });
  if (periods.some((slot, index) => index > 0 && slot.start < periods[index - 1].end)) invalid("打印时段需要按时间顺序排列，且不能重叠。");
  const selected = studentId === undefined ? undefined : scheduleId(studentId);
  const names = new Map(students.filter(row => !selected || row.id === selected).map(row => [row.id, row.alias]));
  if (selected && !names.has(selected)) invalid("筛选学生已变化。");
  const input: SigninInput = { kind, period, slots: periods, studentId: selected };
  const preview: SigninPreview = { input, dates, groups: (kind === "weekday" ? ["周二至周五"] :
    periods.map(slot => slot.start + "–" + slot.end)).map(label => ({ label, members: [] })), warnings: [] };
  const { visits, conflicts } = store.plannedSigninVisits(dates[0], dates.at(-1)!, now);
  const add = (row: { studentId: string; startAt: number }, conflict: boolean) => {
    if (selected && row.studentId !== selected) return;
    const alias = names.get(row.studentId);
    if (alias === undefined) invalid("签到表发现无法关联的学生档案。");
    const { date, time } = shanghaiParts(row.startAt);
    if (!dates.includes(date)) return;
    const group = kind === "weekday" ? 0 : periods.findIndex(slot => time >= slot.start && time < slot.end);
    if (conflict || group === -1) {
      preview.warnings.push({ alias, date, time, reason: conflict ? "周期安排重叠或超出营业时段" : "开始时间未落入任一打印时段" });
    } else {
      const list = preview.groups[group].members;
      let member = list.find(item => item.studentId === row.studentId);
      if (!member) { member = {studentId: row.studentId, alias, dates: []}; list.push(member); }
      if (!member.dates.includes(date)) member.dates.push(date);
    }
  };
  visits.forEach(row => add(row, false));
  conflicts.forEach(row => add(row, true));
  sortMembers(preview);
  return preview;
}

function sortMembers(preview: SigninPreview) {
  for (const group of preview.groups) {
    for (const member of group.members) member.dates.sort();
    group.members.sort((a, b) => a.alias.localeCompare(b.alias, "zh-CN") || a.studentId.localeCompare(b.studentId));
  }
}

export function adjustSigninPlan(preview: SigninPreview, students: Student[], raw: unknown): void {
  if (!Array.isArray(raw) || raw.length > 5_000) invalid("打印名单调整超出支持范围。");
  const names = new Map(students.map(student => [student.id, student.alias]));
  for (const item of raw) {
    const { group, studentId, date, include } = scheduleObject(item) as unknown as SigninChange;
    const id = scheduleId(studentId);
    if (!Number.isInteger(group) || group < 0 || group >= preview.groups.length || !preview.dates.includes(date) ||
      !names.has(id) || typeof include !== "boolean" ||
      (preview.input.studentId && preview.input.studentId !== id)) invalid("打印名单调整与预览不匹配。");
    const list = preview.groups[group].members;
    const index = list.findIndex(member => member.studentId === id);
    if (index === -1) {
      if (include) list.push({studentId: id, alias: names.get(id)!, dates: [date]});
    } else {
      const member = list[index];
      member.dates = include ? [...new Set([...member.dates, date])] : member.dates.filter(day => day !== date);
      if (!member.dates.length) list.splice(index, 1);
    }
  }
  sortMembers(preview);
}

const maxTemplateBytes = 8 * 1024 * 1024;
function templateLayout(input: Buffer) {
  // Bound the expanded template before loading it. ExcelJS only receives supported local OOXML.
  if (input.length < 22 || input.length > maxTemplateBytes) invalid("签到模板大小无效。");
  const signature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const end = input.lastIndexOf(signature);
  if (end < 0 || end + 22 > input.length || end + 22 + input.readUInt16LE(end + 20) !== input.length) invalid("无法读取 XLSX 模板结构。");
  let offset = input.readUInt32LE(end + 16), expanded = 0;
  const count = input.readUInt16LE(end + 10);
  if (!count || count > 200 || input.readUInt16LE(end + 4) || input.readUInt16LE(end + 6) ||
    count !== input.readUInt16LE(end + 8) || offset + input.readUInt32LE(end + 12) !== end) invalid("模板压缩结构不受支持。");
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || input.readUInt32LE(offset) !== 0x02014b50) invalid("模板目录不完整。");
    const next = offset + 46 + input.readUInt16LE(offset + 28) + input.readUInt16LE(offset + 30) + input.readUInt16LE(offset + 32);
    if (next > end) invalid("模板目录不完整。");
    expanded += input.readUInt32LE(offset + 24);
    offset = next;
  }
  if (offset !== end || expanded > 32 * 1024 * 1024) invalid("模板展开内容超过支持上限。");
}

export async function signinWorkbook(template: Buffer, preview: SigninPreview): Promise<Buffer> {
  templateLayout(template);
  const Excel = require("./exceljs.runtime.js") as typeof import("exceljs");
  const original = new Excel.Workbook();
  try { await original.xlsx.load(new Uint8Array(template).buffer); }
  catch { invalid("无法打开签到表模板，请选择本地 .xlsx 原件。"); }
  if (original.worksheets.length !== preview.groups.length) invalid("模板工作表数量与所选签到表类型不一致。");
  const book = new Excel.Workbook();
  book.creator = "Supervisor Workspace";
  function applyTemplate(sheet: Worksheet, source: Worksheet, group: SigninPreview["groups"][number]) {
    const merges = (source.model as unknown as { merges?: string[] }).merges ?? [];
    const templateCol = [7, 6].find(width => {
      const last = String.fromCharCode(64 + width);
      return ["A1:" + last + "1", "A2:" + last + "2", "A3:A4", "B3:B4", "C3:" + last + "3"].every(value => merges.includes(value));
    });
    if (templateCol === undefined || source.pageSetup.orientation === "landscape" ||
      (source.pageSetup.paperSize && source.pageSetup.paperSize !== 9)) invalid("模板需采用已登记的四行表头和 A4 纵向布局。");
    const outputCol = preview.input.kind === "weekday" ? 7 : 2 + preview.dates.length;
    const last = String.fromCharCode(64 + outputCol);
    const outputRows = Math.max(source.rowCount, 4 + group.members.length, 5);
    if (outputRows > 500) invalid("纸质签到表超过 496 行，请缩小名单后重试。");
    const bounded = (value: number | undefined, fallback: number, min: number, max: number) =>
      Number.isFinite(value) && value! >= min && value! <= max ? value! : fallback;
    for (let column = 1; column <= outputCol; column++) {
      sheet.getColumn(column).width = bounded(source.getColumn(Math.min(column, templateCol)).width, column === 2 ? 16 : 14, 3, 65);
    }
    for (let row = 1; row <= outputRows; row++) {
      const sourceRow = Math.min(row, Math.max(5, source.rowCount));
      sheet.getRow(row).height = bounded(source.getRow(sourceRow).height, row <= 4 ? 22 : 24, 9, 90);
      for (let column = 1; column <= outputCol; column++) {
        const style = source.getCell(sourceRow, Math.min(column, templateCol)).style;
        // Plain styles only. Never copy cells, links, formulas, metadata or original signatures.
        sheet.getCell(row, column).style = structuredClone({
          font: style.font, alignment: style.alignment, border: style.border, fill: style.fill, numFmt: "@",
        });
      }
    }
    for (const address of ["A1:" + last + "1", "A2:" + last + "2", "C3:" + last + "3", "A3:A4", "B3:B4"]) sheet.mergeCells(address);
    sheet.getCell("A1").value = signinLabels[preview.input.kind];
    sheet.getCell("A2").value = preview.input.period + " · " + group.label + " · 预计名单";
    sheet.getCell("A3").value = "序号";
    sheet.getCell("B3").value = "学生姓名";
    sheet.getCell("C3").value = "学生签名";
    preview.dates.forEach((date, i) => { sheet.getCell(4, 3 + i).value = date.slice(5).replace("-", "/"); });
    group.members.forEach((member, index) => {
      const row = 5 + index;
      sheet.getCell(row, 1).value = index + 1;
      sheet.getCell(row, 2).value = member.alias;
      preview.dates.forEach((date, i) => {
        if (!member.dates.includes(date)) sheet.getCell(row, 3 + i).fill = {type: "pattern", pattern: "solid", fgColor: {argb: "FFE9E9E9"}};
      });
    });
    const margins = source.pageSetup.margins;
    sheet.pageSetup = { ...sheet.pageSetup, paperSize: 9, orientation: "portrait", fitToPage: true, fitToWidth: 1, fitToHeight: 0,
      printArea: "A1:" + last + outputRows, printTitlesRow: "1:4", horizontalCentered: source.pageSetup.horizontalCentered,
      ...(margins && Object.values(margins).every(value => Number.isFinite(value) && value >= 0 && value <= 1.5) ? { margins } : {}) };
  }
  preview.groups.forEach((group, index) => applyTemplate(book.addWorksheet(preview.groups.length === 1 ? "周内" : group.label.replaceAll(":", ".")),
    original.worksheets[index], group));
  return Buffer.from(await book.xlsx.writeBuffer({useStyles: true, useSharedStrings: true}));
}

export async function loadSigninTemplate(path: string): Promise<Buffer> {
  if (extname(path).toLowerCase() !== ".xlsx" || !/^[A-Za-z]:\\/.test(path)) invalid("请选择本机 XLSX 签到表原件。");
  const entry = await lstat(path);
  if (!entry.isFile() || entry.size > maxTemplateBytes || (await realpath(path)).toLowerCase() !== path.toLowerCase()) invalid("无法确认模板为本机独立文件。");
  const file = await open(path, "r");
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size !== entry.size || info.ino !== entry.ino || info.dev !== entry.dev) invalid("模板文件已变化，请重新选择。");
    const buffer = Buffer.alloc(entry.size);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== buffer.length || (await file.stat()).mtimeMs !== info.mtimeMs) invalid("模板文件已变化，请重新选择。");
    return buffer;
  } finally { await file.close(); }
}

export async function writeSigninFile(path: string, bytes: Buffer, preview: SigninPreview, forbidden: string[]): Promise<SigninResult> {
  const parent = dirname(path);
  if (extname(path).toLowerCase() !== ".xlsx" || !/^[^<>:"/\\|?*\x00-\x1f]+\.xlsx$/iu.test(basename(path))) invalid("请选择有效的 XLSX 文件名。");
  requireExportDestination(parent, forbidden);
  const staging = await mkdtemp(join(parent, ".sw-signin-" + randomUUID() + "-"));
  const temp = join(staging, "sheet.xlsx");
  try {
    const file = await open(temp, "wx");
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally { await file.close(); }
    requireExportDestination(parent, forbidden);
    if ((await stat(temp)).size !== bytes.length) throw new WorkspaceFault("failed", "签到表写入不完整。");
    await link(temp, path); // Atomic publication. Existing file (including the selected template) is never replaced.
    return { location: path, names: preview.groups.reduce((n, group) => n + group.members.length, 0),
      slots: preview.groups.reduce((n, group) => n + group.members.reduce((sum, member) => sum + member.dates.length, 0), 0) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new WorkspaceFault("conflict", "目标文件已经存在，未覆盖。请选择其他文件名。");
    throw error;
  } finally {
    await unlink(temp).catch(() => undefined);
    await rmdir(staging).catch(() => undefined);
  }
}

export function signinPlanKey(preview: SigninPreview): string {
  return createHash("sha256").update(JSON.stringify(preview)).digest("hex");
}
