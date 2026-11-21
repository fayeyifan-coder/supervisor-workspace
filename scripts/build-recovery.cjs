const { mkdirSync } = require("node:fs");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");

if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Windows x64 is required for M2-D.");
const windows = process.env.SystemRoot;
if (!windows) throw new Error("Windows system directory is unavailable.");
const compiler = join(windows, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
const root = join(__dirname, "..");
mkdirSync(join(root, "build"), { recursive: true });
const result = spawnSync(compiler, ["/nologo", "/platform:x64", "/optimize+",
  "/out:" + join(root, "build", "recovery-io.exe"), join(root, "native", "RecoveryIo.cs")], {
  cwd: root, stdio: "inherit", windowsHide: true,
});
if (result.error) throw result.error;
if (result.status !== 0) throw new Error("Windows recovery component build failed.");
