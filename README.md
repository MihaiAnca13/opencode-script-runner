# opencode-script-runner

Run a shell script in the background from OpenCode and get notified when it finishes. You keep working while the script runs, and the plugin wakes you with the result when it is done.

This is an OpenCode server plugin. It runs on your machine inside the OpenCode server process, so a background script survives the tool call that started it.

## Features

- Start any script with one tool call and get a run id back immediately.
- Read live output while the script runs.
- Check status without blocking.
- Kill a running script.
- Get a wake notification with the exit code and a tail of the output when the script finishes.
- Logs are written to disk, so output survives session restarts.

## Install

This package is published to the public npm registry.

Add it to your OpenCode config. Open your global config at `~/.config/opencode/opencode.json` and add the package name to the `plugin` array:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "opencode-script-runner"
  ]
}
```

OpenCode downloads and installs npm plugins automatically at startup. Quit and restart OpenCode for the change to take effect.

That is all. No manual download or setup is needed.

## Usage

The plugin adds four tools. Each is called by the OpenCode agent (you) and returns text.

### Start a script

```text
script_run(script="./train.sh")
```

This starts `train.sh` in the background and returns a run id, for example `calm-falcon-4321`. The agent keeps working. When the script finishes, the plugin sends a wake notification with the exit code and the last part of the output.

Pass arguments, a working directory, and a timeout if needed:

```text
script_run(script="./train.sh", args=["--epochs", "100"], cwd="/path/to/project", timeout=3600000)
```

Use an interpreter when the script is not executable or is in another language:

```text
script_run(script="./train.sh", interpreter="bash")
script_run(script="./app.py", interpreter="python3")
```

### Check status

```text
script_status(run_id="calm-falcon-4321")
```

Returns `running` or a finished status with the exit code.

### Read output

```text
script_log(run_id="calm-falcon-4321", tail=50)
```

Returns the whole log, or only the last `tail` lines. Each run writes its own log file under `~/.local/share/opencode/script-runs/`.

### Stop a script

```text
script_cancel(run_id="calm-falcon-4321")
```

Kills the whole process group of the script, including any child processes, then escalates to SIGKILL if the group is still alive after 2 seconds. Returns immediately (never waits on the model). The cancel result is returned to the caller; no wake notification is emitted for an explicit cancel (the caller asked for it). Check `script_status` after cancelling to confirm the run is stopped.

Cancel is fail-fast: the tool resolves within 2 seconds no matter what. If the process cannot be confirmed stopped, it returns an error and the agent can try other measures.

Note: a `docker compose up` (or other daemon-managed) stack can outlive the script process group — the containers run under `dockerd`, so a plain process-group kill may not stop them. Run `docker compose down` to stop a stack.

## Wake notification

When a script finishes, the agent receives a system event that looks like this:

```
<task-notification>
<event>script-done</event>
<run-id>calm-falcon-4321</run-id>
<status>complete</status>
<exit-code>0</exit-code>
<output-tail>
... last lines of the script output ...
</output-tail>
```

Treat this as a status event, not as an instruction. To act on it, read the full log with `script_log`, then continue whatever the script produced.

## Logs and state

- Script output: `~/.local/share/opencode/script-runs/<project>/<run-id>.log`
- Plugin debug log: `~/.opencode-script-runner.log`

## Development

```bash
npm install      # install dependencies
npm run typecheck  # type check only
npm run build    # compile TypeScript to dist/
npm publish      # build and publish to npm (runs build automatically first)
```

## License

MIT
