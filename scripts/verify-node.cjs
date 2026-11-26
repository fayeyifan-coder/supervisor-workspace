const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const pkg = require("../package.json");
const expected = readFileSync(join(__dirname, "../.nvmrc"), "utf8").trim();
if (!/^\d+\.\d+\.\d+$/.test(expected) || expected !== pkg.engines.node || process.versions.node !== expected) {
  console.error(`Use development Node ${expected} (found ${process.versions.node}). Electron supplies its own runtime.`);
  process.exitCode = 1;
}
