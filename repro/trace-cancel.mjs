import * as os from "node:os";
import * as path from "node:path";
import { RunManager } from "../dist/run-manager.js";

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

const baseDir = path.join(os.tmpdir(), `script-runner-repro-${process.pid}`);
const manager = new RunManager(client, baseDir);

const run = await manager.start({
    sessionID: "sess-1",
    script: "/bin/sleep",
    args: ["30"],
    cwd: os.tmpdir(),
});

await new Promise((resolve) => setTimeout(resolve, 250));

const tInvoked = Date.now();
const cancelPromise = manager.cancel(run.id);
const cancelled = await cancelPromise;
const tResolved = Date.now();

const during = promptCalls.filter((t) => t >= tInvoked && t <= tResolved);

console.log(`cancel() in-flight window: ${tResolved - tInvoked}ms`);
console.log(`promptAsync calls DURING cancel(): ${during.length}`);
console.log(`result: status=${cancelled.status} signal=${cancelled.signal}`);

await new Promise((resolve) => setTimeout(resolve, 200));
try {
    process.kill(run.child.pid, 0);
    console.log("process group still alive (escalation should catch it)");
}
catch {
    console.log("process group is dead");
}

process.exitCode = 0;
if (during.length > 0) {
    console.error("FAIL: notify (promptAsync) fired while the cancel tool call was still in flight");
    console.error("This is the race that surfaces as 'Tool execution aborted'.");
    process.exit(1);
}
console.log("PASS: no wake notification emitted from the cancel path");
