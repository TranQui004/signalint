const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");

const pidPath = process.argv[2];
if (pidPath === undefined) {
  throw new Error("Expected a PID output path.");
}

const child = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], {
  stdio: "ignore",
  windowsHide: true,
});
writeFileSync(pidPath, JSON.stringify({ parent: process.pid, child: child.pid }), "utf8");
setInterval(() => undefined, 1000);
