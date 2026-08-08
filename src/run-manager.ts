import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomInt } from "node:crypto";

const MAX_LOG_TAIL = 20000;

const SHELL_META = /[&|;<>()$`\\{}*?[\]!~\n]/;
const COMMAND_SPACE = /^\s*(\S+)\s+\S/;

type Client = ReturnType<typeof import("@opencode-ai/sdk").createOpencodeClient>;

type RunStatus = "running" | "complete" | "cancelled" | "error" | "timeout";

export type Run = {
    id: string;
    sessionID: string;
    rootID: string;
    agent?: string;
    script: string;
    child?: ChildProcess;
    status: RunStatus;
    exitCode: number | null;
    signal: string | null;
    startedAt: Date;
    finishedAt?: Date;
    logFile: string;
    timeout?: NodeJS.Timeout;
    tail?: string;
    error?: string;
};

const ADJECTIVES = ["calm", "clever", "brisk", "curious", "eager", "gentle"];
const ANIMALS = ["badger", "falcon", "fox", "lynx", "otter", "raven"];

function pick(items: string[]): string {
    return items[randomInt(items.length)];
}

function generateRunId(): string {
    return `${pick(ADJECTIVES)}-${pick(ANIMALS)}-${randomInt(1000, 9999)}`;
}

function preview(text: string, maxLength: number): string {
    const compact = text.replace(/\s+/g, " ").trim();
    return compact.length > maxLength ? `${compact.slice(0, maxLength - 3).trimEnd()}...` : compact;
}

function escapeMarkup(text: string): string {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

function formatWakeNotification(run: Run): string {
    const state = run.status === "complete"
        ? "completed"
        : run.status === "timeout"
            ? "timed out"
            : run.status === "cancelled"
                ? "was cancelled"
                : "failed";
    const exit = run.exitCode !== null ? String(run.exitCode) : "none";
    const signal = run.signal ? `signal=${escapeMarkup(run.signal)}` : "";
    const errorLine = run.error
        ? `\n<error>${escapeMarkup(run.error)}</error>`
        : "";
    const logFile = run.logFile
        ? `\nLog file: \`${escapeMarkup(run.logFile)}\`\nUse \`script_log(run_id="${escapeMarkup(run.id)}")\` to read the full output.`
        : "";
    const tail = preview(run.tail ?? "", 4000);
    return `<task-notification>
<event>script-done</event>
<run-id>${escapeMarkup(run.id)}</run-id>
<status>${run.status}</status>
<description>The background script run ${escapeMarkup(run.id)} ${state}.</description>
<exit-code>${exit}</exit-code>
${signal}${errorLine}
<output-tail>
${escapeMarkup(tail)}
</output-tail>${logFile}
</task-notification>`;
}

export class RunManager {
    private client: Client;
    private baseDir: string;
    private runs = new Map<string, Run>();

    constructor(client: Client, baseDir: string) {
        this.client = client;
        this.baseDir = baseDir;
    }

    async start(input: {
        sessionID: string;
        agent?: string;
        script: string;
        args?: string[];
        cwd?: string;
        env?: Record<string, string>;
        interpreter?: string;
        timeout?: number;
    }): Promise<Run> {
        let id = generateRunId();
        while (this.runs.has(id)) {
            id = generateRunId();
        }

        await fs.mkdir(this.baseDir, { recursive: true });
        const rootID = await this.rootSessionID(input.sessionID);

        const { bin, binArgs } = await this.resolveCommand(input);
        const logFile = path.join(this.baseDir, `${id}.log`);

        const run: Run = {
            id,
            sessionID: input.sessionID,
            rootID,
            agent: input.agent,
            script: input.script,
            status: "running",
            exitCode: null,
            signal: null,
            startedAt: new Date(),
            logFile,
        };
        this.runs.set(id, run);

        void this.debug(`start: ${id} script=${input.script} interpreter=${input.interpreter ?? "none"} args=${JSON.stringify(input.args ?? [])} cwd=${input.cwd ?? process.cwd()}`);

        const child = spawn(bin, binArgs, {
            cwd: input.cwd,
            env: input.env ? { ...process.env, ...input.env } : process.env,
            detached: true,
            stdio: ["ignore", "pipe", "pipe"],
        });
        run.child = child;

        const fail = async (message: string): Promise<void> => {
            run.error = message;
            void fs.appendFile(logFile, `${message}\n`).catch(() => undefined);
            void this.debug(`spawn-failed: ${id} ${message}`);
            await this.finish(run, "error", message);
        };
        child.on("error", async (error) => {
            await fail(`Failed to start process: ${error.message}`);
        });
        const append = (chunk: Buffer | string): void => {
            void fs.appendFile(logFile, chunk).catch(() => undefined);
        };
        child.stdout?.on("data", append);
        child.stderr?.on("data", append);
        child.on("exit", async (code, signal) => {
            run.tail = await this.readLogTail(run);
            await this.finish(run, code === 0 ? "complete" : "error", undefined, code, signal);
        });

        if (input.timeout && input.timeout > 0) {
            run.timeout = setTimeout(() => {
                void this.finish(run, "timeout", `Run timed out after ${input.timeout}ms`);
                this.killProcessTree(run);
                this.scheduleEscalation(run);
            }, input.timeout);
        }

        return run;
    }

    private async resolveCommand(input: {
        script: string;
        args?: string[];
        interpreter?: string;
    }): Promise<{ bin: string; binArgs: string[] }> {
        const script = input.script;
        let isFile = false;
        try {
            isFile = (await fs.stat(script)).isFile();
        }
        catch {
            isFile = false;
        }
        const looksInline = !isFile && (SHELL_META.test(script) || COMMAND_SPACE.test(script));

        if (input.interpreter) {
            return {
                bin: input.interpreter,
                binArgs: isFile ? [script, ...(input.args ?? [])] : ["-c", script, ...(input.args ?? [])],
            };
        }

        if (looksInline) {
            throw new Error("script= looks like an inline shell command, not a file path. " +
                `Pass a script file path, or set interpreter="bash" to run an inline command (got: "${script}").`);
        }
        return { bin: script, binArgs: input.args ?? [] };
    }

    private killProcessTree(run: Run, signal: NodeJS.Signals = "SIGTERM"): void {
        if (!run.child || !run.child.pid) {
            return;
        }
        const pid = run.child.pid;
        try {
            process.kill(-pid, signal);
            void this.debug(`killProcessTree: sent ${signal} to process group ${pid} (run ${run.id})`);
        }
        catch {
            try {
                run.child.kill(signal);
                void this.debug(`killProcessTree: sent ${signal} to leader ${pid} (run ${run.id})`);
            }
            catch {
                void this.debug(`killProcessTree: could not signal ${pid} (run ${run.id})`);
            }
        }
    }

    private scheduleEscalation(run: Run): void {
        if (!run.child?.pid) {
            return;
        }
        const pid = run.child.pid;
        setTimeout(() => {
            if (!this.runs.has(run.id)) {
                return;
            }
            let alive = false;
            try {
                process.kill(-pid, 0);
                alive = true;
            }
            catch {
                alive = false;
            }
            if (!alive) {
                void this.debug(`scheduleEscalation: group ${pid} already gone (run ${run.id})`);
                return;
            }
            let killed = false;
            try {
                process.kill(-pid, "SIGKILL");
                killed = true;
            }
            catch {
                try {
                    process.kill(pid, "SIGKILL");
                    killed = true;
                }
                catch {
                    killed = false;
                }
            }
            if (killed) {
                void this.debug(`scheduleEscalation: SIGKILL sent to process group ${pid} (run ${run.id})`);
            }
            else {
                void this.debug(`scheduleEscalation: could not SIGKILL process group ${pid} (run ${run.id}); stop manually`);
            }
        }, 2000);
    }

    private async finish(
        run: Run,
        status: Exclude<RunStatus, "running">,
        errorMessage?: string,
        code?: number | null,
        signal?: string | null,
    ): Promise<void> {
        if (run.status !== "running") {
            void this.debug(`finish: suppressed for ${run.id} (status=${run.status})`);
            return;
        }
        run.status = status;
        run.exitCode = code ?? null;
        run.signal = signal ?? null;
        run.finishedAt = new Date();
        if (run.timeout) {
            clearTimeout(run.timeout);
            run.timeout = undefined;
        }
        if (status === "error" && errorMessage) {
            run.error = errorMessage;
        }
        run.tail = await this.readLogTail(run);
        this.notify(run);
    }

    private async readLogTail(run: Run): Promise<string> {
        try {
            const content = await fs.readFile(run.logFile, "utf8");
            return content.slice(-MAX_LOG_TAIL);
        }
        catch {
            return "";
        }
    }

    notify(run: Run, extra?: string): void {
        const text = extra
            ? `${formatWakeNotification(run)}\n\n${extra}`
            : formatWakeNotification(run);
        const parts = [{ type: "text" as const, text }];
        void Promise.resolve(
            this.client.session.promptAsync({
                path: { id: run.sessionID },
                body: run.agent
                    ? { noReply: false, agent: run.agent, parts }
                    : { noReply: false, parts },
            }),
        ).catch((error) => {
            void this.debug(`notify failed: ${error instanceof Error ? error.message : "unknown error"}`);
        });
    }

    async cancel(id: string): Promise<Run | undefined> {
        const run = this.runs.get(id);
        if (!run) {
            void this.debug(`cancel: no run ${id}`);
            return undefined;
        }
        if (run.status === "running") {
            if (run.timeout) {
                clearTimeout(run.timeout);
                run.timeout = undefined;
            }
            run.status = "cancelled";
            run.signal = "SIGTERM";
            run.finishedAt = new Date();
            void this.debug(`cancel: signalling ${id} (pid ${run.child?.pid ?? "none"}, group kill)`);
            this.killProcessTree(run);
            this.scheduleEscalation(run);
        }
        else {
            void this.debug(`cancel: ${id} already ${run.status}`);
        }
        return run;
    }

    getStatus(id: string): Run | undefined {
        return this.runs.get(id);
    }

    async readLog(id: string, tail: number): Promise<string | undefined> {
        const run = this.runs.get(id);
        if (!run) {
            return undefined;
        }
        try {
            const content = await fs.readFile(run.logFile, "utf8");
            const lines = content.split("\n");
            return tail > 0 ? lines.slice(-tail).join("\n") : content;
        }
        catch {
            return "(no log captured yet)";
        }
    }

    async rootSessionID(sessionID: string): Promise<string> {
        let current = sessionID;
        for (let depth = 0; depth < 16; depth += 1) {
            try {
                const session = await this.client.session.get({ path: { id: current } });
                const parentID = session.data?.parentID;
                if (!parentID) {
                    return current;
                }
                current = parentID;
            }
            catch {
                break;
            }
        }
        return current;
    }

    listForRoot(rootID: string): Run[] {
        return [...this.runs.values()].filter((run) => run.rootID === rootID);
    }

    allRuns(): Run[] {
        return [...this.runs.values()];
    }

    private async debug(message: string): Promise<void> {
        try {
            await fs.mkdir(os.homedir(), { recursive: true });
            await fs.appendFile(path.join(os.homedir(), ".opencode-script-runner.log"), `${new Date().toISOString()}: ${message}\n`, "utf8");
        }
        catch {
            // ignore
        }
    }
}
