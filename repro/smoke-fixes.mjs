import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import * as fsm from "node:fs/promises";
import { RunManager } from "../dist/run-manager.js";

const tmp = path.join(os.tmpdir(), `script-runner-fixes-${process.pid}`);
fs.mkdirSync(tmp, { recursive: true });

let failures = 0;
function check(name, cond, detail = "") {
    if (cond) {
        console.log(`PASS: ${name}`);
    }
    else {
        failures += 1;
        console.error(`FAIL: ${name}${detail ? ` (${detail})` : ""}`);
    }
}

const notifications = [];
const client = {
    get: async () => ({}),
    synthetic: async (input) => {
        notifications.push({ text: input.text, resume: input.resume });
        return {};
    },
};

const baseDir = path.join(tmp, "runs");
const manager = new RunManager(client, baseDir);

async function waitFor(run, ms = 8000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        const s = manager.getStatus(run.id);
        if (s && s.status !== "running") return s;
        await new Promise((r) => setTimeout(r, 50));
    }
    return manager.getStatus(run.id);
}

// --- Test 1: inline command WITHOUT interpreter is rejected up front (#1) ---
console.log("== Test 1: inline command w/o interpreter rejected ==");
let rejected = null;
try {
    await manager.start({
        sessionID: "sess-1",
        script: "cd /tmp && ./verify.sh && echo VERIFY_OK",
    });
}
catch (e) {
    rejected = e.message;
}
check("inline command rejected synchronously", !!rejected && /interpreter/.test(rejected), rejected ?? "no reject");
check("reject message says interpreter=\"bash\"", /interpreter="bash"/.test(rejected ?? ""));
console.log("  ->", rejected);

// --- Test 1b: rejected command leaves NO phantom running run (#7) ---
console.log("== Test 1b: no phantom run after rejection ==");
const list1 = manager.allRuns();
check("no lingering running run after reject", list1.every((r) => r.status !== "running"), `count=${list1.length}`);
check("rejected start did not create a log file", fs.readdirSync(baseDir).filter((f) => f.endsWith(".log")).length === 0, fs.readdirSync(baseDir).join(","));

// --- Test 2: inline command WITH interpreter runs (#1,#4,#3) ---
console.log("== Test 2: inline command with interpreter runs ==");
fs.writeFileSync(path.join(tmp, "verify.sh"), `#!/bin/bash\necho "GREET from verify"\nexit 0\n`);
try { fs.chmodSync(path.join(tmp, "verify.sh"), 0o755); } catch {}
const okRun = await manager.start({
    sessionID: "sess-1",
    script: `cd ${tmp} && ./verify.sh && echo "DONE_MARKER"`,
    interpreter: "bash",
    timeout: 10000,
});
check("run assigned an id", !!okRun.id);
const okFinal = await waitFor(okRun);
check("interpreter run completes", okFinal?.status === "complete", `status=${okFinal?.status} exit=${okFinal?.exitCode} err=${okFinal?.error}`);
const okLog = fs.readFileSync(path.join(baseDir, `${okRun.id}.log`), "utf8");
check("log captured stdout (file materialized by append)", /DONE_MARKER/.test(okLog));
check("log file exists on disk (#4)", fs.existsSync(path.join(baseDir, `${okRun.id}.log`)));

// --- Test 3: un-spawnable path surfaces error in log + notification (#2,#5) ---
console.log("== Test 3: spawn failure surfaces error ==");
const badRun = await manager.start({
    sessionID: "sess-1",
    script: path.join(tmp, "does-not-exist-binary"),
});
check("bad run assigned an id", !!badRun.id);
const badFinal = await waitFor(badRun);
check("bad run status = error", badFinal?.status === "error", `status=${badFinal?.status}`);
check("bad run error message set", !!badFinal?.error && /Failed to start|ENOENT/.test(badFinal?.error), badFinal?.error);
const badLog = fs.readFileSync(path.join(baseDir, `${badRun.id}.log`), "utf8");
check("bad run log exists and has error text", fs.existsSync(path.join(baseDir, `${badRun.id}.log`)) && /Failed to start/.test(badLog));
await new Promise((r) => setTimeout(r, 300));
const notif = notifications[notifications.length - 1]?.text ?? "";
check("notification has <error> line", /<error>/.test(notif), notif);
check("notification status error", /<status>error<\/status>/.test(notif));
check("notification exit-code none", /<exit-code>none<\/exit-code>/.test(notif));
check("notification resumes the session", notifications[notifications.length - 1]?.resume === true);

// --- Test 4: script_status surfaces error (#5) ---
console.log("== Test 4: status includes error ==");
const st = manager.getStatus(badRun.id);
check("status carries error text", !!st?.error && /Failed to start/.test(st.error), st?.error);

// --- Test 5: debug log records start + spawn-failure (#3) ---
console.log("== Test 5: debug log audit trail ==");
const dbg = fs.readFileSync(path.join(os.homedir(), ".opencode-script-runner.log"), "utf8");
check("debug logged start", new RegExp(`start: ${okRun.id}`).test(dbg));
check("debug logged spawn-failed", new RegExp(`spawn-failed: ${badRun.id}`).test(dbg));

// --- Test 6: regular script file + interpreter still runs as file (regression) ---
console.log("== Test 6: file path with interpreter runs as file ==");
const fileRun = await manager.start({
    sessionID: "sess-1",
    script: path.join(tmp, "verify.sh"),
    interpreter: "bash",
    timeout: 10000,
});
const fileFinal = await waitFor(fileRun);
check("file path w/ interpreter completes", fileFinal?.status === "complete", `status=${fileFinal?.status} err=${fileFinal?.error}`);

// --- Test 7: inline python w/ python3 interpreter runs (uses -c) ---
console.log("== Test 7: inline python with interpreter runs ==");
const pyRun = await manager.start({
    sessionID: "sess-1",
    script: "print('PY_OK')",
    interpreter: "python3",
    timeout: 10000,
});
const pyFinal = await waitFor(pyRun);
const pyLog = fs.readFileSync(path.join(baseDir, `${pyRun.id}.log`), "utf8");
check("inline python completes with interpreter", pyFinal?.status === "complete" && /PY_OK/.test(pyLog), `status=${pyFinal?.status} err=${pyFinal?.error}`);

try { await fsm.rm(tmp, { recursive: true, force: true }); } catch {}

process.exitCode = failures === 0 ? 0 : 1;
if (failures === 0) {
    console.log("");
    console.log("ALL FIXES PASS");
}
else {
    console.error(`FAILED: ${failures} check(s)`);
}
