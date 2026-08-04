import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import * as fsm from "node:fs/promises";
import { RunManager } from "../dist/run-manager.js";

const tmp = path.join(os.tmpdir(), `script-runner-repro-${process.pid}`);
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

const promptCalls = [];

const client = {
    session: {
        get: async () => ({ data: {} }),
        promptAsync: async () => {
            promptCalls.push(Date.now());
            return {};
        },
    },
};

const baseDir = path.join(tmp, "runs");
const manager = new RunManager(client, baseDir);

// --- Test A: deep tree whose grandchild node ignores SIGTERM while
// --- mid-spawnSync and spilling trace-like IO, exactly like the FCM
// --- mint profile (run.sh -> inner.sh -> node stubborn-grandchild).
fs.writeFileSync(path.join(tmp, "run.sh"), `#!/bin/bash\nset -u\n./inner.sh\n`);
fs.writeFileSync(path.join(tmp, "inner.sh"),
    `#!/bin/bash\n` +
    `for i in $(seq 1 5000); do echo "trace $i dog_number=12345 steps=54321 actions=abcdefghijklmnopqrstuvwxyz0123456789 ..."; done\n` +
    `cd "$(dirname "$0")" && node stubborn.mjs\n`);
fs.writeFileSync(path.join(tmp, "stubborn.mjs"),
    `import { spawnSync } from "node:child_process";\n` +
    `let term = false;\n` +
    `process.on("SIGTERM", () => { term = true; });\n` + // ignore SIGTERM briefly
    `const deadline = Date.now() + 8000;\n` +
    `let i = 0;\n` +
    `while (Date.now() < deadline) {\n` +
    `  spawnSync("true");\n` +
    `  if (i % 20 === 0) process.stdout.write("churn " + i + " " + Date.now() + " xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\\n");\n` +
    `  i += 1;\n` +
    `}\n` +
    `process.exit(term ? 0 : 1);\n`);
try { fs.chmodSync(path.join(tmp, "run.sh"), 0o755); } catch { /* ignore */ }
try { fs.chmodSync(path.join(tmp, "inner.sh"), 0o755); } catch { /* ignore */ }

console.log("== Test A: deep tree, SIGTERM-stubborn grandchild, trace IO ==");
const run = await manager.start({
    sessionID: "sess-1",
    script: path.join(tmp, "run.sh"),
    interpreter: "bash",
    cwd: tmp,
});
console.log(`run started: ${run.id} (pid ${run.child.pid})`);

await new Promise((resolve) => setTimeout(resolve, 600));

const tInvoked = Date.now();
const cancelResult = await manager.cancel(run.id);
const tResolved = Date.now();
const during = promptCalls.filter((t) => t >= tInvoked && t <= tResolved);

console.log(`cancel() in-flight window: ${tResolved - tInvoked}ms`);
check("cancel() resolves quickly (<1s)", tResolved - tInvoked < 1000, `took ${tResolved - tInvoked}ms`);
check("cancel() returns the run", cancelResult && cancelResult.status === "cancelled");
check("no promptAsync during cancel in-flight window", during.length === 0, `count=${during.length}`);

// escalation fires at +2s and must SIGKILL the stubborn grandchild
await new Promise((resolve) => setTimeout(resolve, 2400));
let groupAlive = false;
try {
    process.kill(-run.child.pid, 0);
    groupAlive = true;
}
catch {
    groupAlive = false;
}
check("process group is dead after escalation SIGKILL", !groupAlive);

await new Promise((resolve) => setTimeout(resolve, 400));
check("no wake notification emitted for cancelled run at all", promptCalls.length === 0, `count=${promptCalls.length}`);

// cleanup
try { process.kill(-run.child.pid, "SIGKILL"); } catch { /* ignore */ }

// --- Test B: script_cancel's reject-proof 2s race ---
console.log("");
console.log("== Test B: reject-proof cancel race (index.ts expression) ==");
{
    const failingCancel = async () => {
        throw new Error("kill boom");
    };
    const t1 = Date.now();
    let threw = false;
    let out;
    try {
        out = await Promise.race([
            Promise.resolve(failingCancel()).catch(() => undefined),
            new Promise((resolve) => setTimeout(() => resolve("timeout"), 2000)),
        ]);
    }
    catch {
        threw = true;
    }
    const dt = Date.now() - t1;
    check("race cannot reject when cancel() throws", !threw);
    check("race resolves immediately on rejection (no 2s block)", dt < 2000 && out === undefined, `dt=${dt}`);

    const never = () => new Promise(() => {});
    const t2 = Date.now();
    const out2 = await Promise.race([
        Promise.resolve(never()).catch(() => undefined),
        new Promise((resolve) => setTimeout(() => resolve("timeout"), 800)),
    ]);
    const dt2 = Date.now() - t2;
    check("race bails at timeout even if cancel never settles", out2 === "timeout" && dt2 >= 700 && dt2 < 1500, `dt2=${dt2}`);
}

try { await fsm.rm(tmp, { recursive: true, force: true }); } catch { /* ignore */ }

process.exitCode = failures === 0 ? 0 : 1;
if (failures === 0) {
    console.log("");
    console.log("ALL PASS: cancel is fail-fast and emits no competing wake notification.");
}
else {
    console.error(`FAILED: ${failures} check(s)`);
}
