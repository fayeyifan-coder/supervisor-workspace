const Excel = require("exceljs");

async function fakeSigninTemplate(kind) {
  const book = new Excel.Workbook();
  book.creator = "SYNTHETIC template metadata must not be copied";
  for (let index = 0; index < (kind === "weekday" ? 1 : 4); index++) {
    const width = kind === "weekday" || index % 2 ? 7 : 6;
    const last = String.fromCharCode(64 + width);
    const sheet = book.addWorksheet("Synthetic " + index, {pageSetup: {paperSize: 9, orientation: "portrait"}});
    for (const merge of ["A1:" + last + "1", "A2:" + last + "2", "A3:A4", "B3:B4", "C3:" + last + "3"]) sheet.mergeCells(merge);
    for (let column = 1; column <= width; column++) sheet.getColumn(column).width = column === 2 ? 14 : 12;
    for (let row = 5; row <= 30; row++) {
      sheet.getRow(row).height = 17;
      sheet.getCell(row, 2).value = "SYNTHETIC original roster must not be copied";
      for (let column = 1; column <= width; column++) {
        sheet.getCell(row, column).border = {bottom: {style:"thin", color: {argb:"FF929FA6"}}};
      }
    }
    sheet.getCell("C5").value = {formula: "1+1", result: 2};
    sheet.getCell("A1").font = {name: "Microsoft YaHei", bold: true, size: 14};
    sheet.getCell("A1").alignment = {horizontal: "center"};
    sheet.headerFooter.oddHeader = "SYNTHETIC template header must not be copied";
  }
  return Buffer.from(await book.xlsx.writeBuffer());
}
module.exports = { fakeSigninTemplate };
