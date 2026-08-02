# Why `script_cancel` returned "Tool execution aborted" (run calm-lynx-9250)

Date: 2026-08-02. Repo: /home/mihai/personal/opencode-script-runner (the runner that
hosts the background /tmp/fcm_remint.sh process group).

## Sequence of events

1. A mint re-run was started in background:
   `script_run /tmp/fcm_remint.sh` → run id `calm-lynx-9250`
   (`node tools/mint_corpus_golden.mjs --ids blocked_ids.txt ...`, log at
   `.tmp_verify/golden/blocked_remint.log`).
2. Mid-run I invoked `script_cancel(run_id="calm-lynx-9250")`.
3. The tool call did NOT return a structured cancel result. It returned
   `Tool execution aborted` — the harness catch-all for a tool call whose result
   never materialised / was interrupted before a normal ToolResult was produced.
4. A `script-done` notification arrived shortly after with:
   `status: cancelled, exit-code: none, signal: SIGTERM`. So the run WAS actually
   terminated — the SIGTERM was delivered to the process group and the script died.
5. Verification via `ps`/`pgrep`: no `mint_corpus_golden`, `run_js_replay`, or
   `fcm_standalone_runner` process survived.

Conclusion: the **kill worked**; the **cancel call's result channel failed**.

## Why the call failed (hypotheses, in likelihood order)

The script's steady state is a blocking synchronous child spawn:

```
node tools/mint_corpus_golden.mjs
  └─ spawnSync("node", ["tools/run_js_replay.mjs", ...])   per game
  └─ spawnSync("./build/fcm_standalone_runner", [...])     per game
```

- `script_cancel` kills the whole process group (the runner signals the group, not
  just the leader). At that instant the group leader was a transient `node` child
  (per-game replay). If the runner's cancel path waits on the group leader to exit
  before replying, and the leader died by signal (SIGTERM) rather than by its own
  exit(0), the wait can throw / short-circuit → the tool call aborts instead of
  returning a clean `cancelled` result.
- Race with notification delivery: the `script-done` event fired while my cancel
  call was still in flight. Overlapping the "kill + notify" path and the "cancel
  tool awaiting result" path is exactly the kind of interleaving that drops the
  structured result and surfaces as an abort.

## Why it didn't "give back access"

`Tool execution aborted` means the agent turn was cut off before the platform
returned the expected result/yield that a finished tool call normally produces.
The session did not get a normal resume token, so no new assistant turn was
spawned automatically; continuing required either the arriving background
notification or an explicit user message. It is a result-channel failure, not a
permission or sandbox failure.

## Mitigations (adopted)

- Cancel while the script is between child spawns, or SIGTERM the group from a
  plain shell and then confirm with `ps`/`pgrep` instead of relying on the tool
  result object.
- After any cancel, verify no survivor processes (`pgrep -af "node tools"`) before
  rebuilding/re-running, so a half-dead group can never mix old/new binary output.
