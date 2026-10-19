# E2B sandbox

Run reusable Cloudroom machines in [E2B](https://e2b.dev) sandboxes. Install the
optional official plugin, connect a team API key in Settings → Plugins → E2B
sandbox, select a project, and create a machine. The project picker exposes
**New sandbox** under **New machine**.

This plugin mirrors the Modal sandbox plugin feature for feature; the sections
below note where E2B's model differs.

## Standard image

Settings lets you edit, save, or reset the Dockerfile used for future machines
across all projects. Agents can use the same saved definition through the CLI:

```sh
room-cli e2b image show > Dockerfile
room-cli e2b image set --file ./Dockerfile
room-cli e2b image show --json
room-cli e2b image reset
```

Only one `FROM` followed by `RUN`, `ENV`, `WORKDIR`, or `USER` is supported.
Comments and line breaks are preserved. There is no build context, `COPY`, `ADD`,
or multi-stage build. Invalid definitions leave the saved version unchanged.
Saving/resetting does not build or allocate compute; existing machines are
unaffected. The last saved definition applies to new launches. The override is
stored by this plugin and survives reloads; reset uses the bundled Dockerfile
from the installed plugin version.

The plugin ships a [Dockerfile](Dockerfile) with Debian, Node, Git/GitHub CLI,
build tools, Python, bubblewrap, ripgrep, jq, pnpm, Pi, Codex and Claude Code. It
contains no Cloudroom daemon, project files, enrollment state or credentials.
The Dockerfile is translated into an E2B template whose alias is derived from the
Dockerfile's SHA-256 (and the selected size preset), so it is built once per E2B
project and reused by later launches. A template is reused only when E2B reports
its build as ready; a build in progress from another launch is awaited, and a
failed build is rebuilt under the same alias. Changing the Dockerfile creates a
new template for future machines. E2B caches build layers.

E2B runs template steps and sandbox commands as its unprivileged `user` by
default. The plugin runs `RUN` steps as root until the Dockerfile's `USER`
instruction, then as that user, and runs every sandbox command (daemon
bootstrap, debug exec) as the Dockerfile's final `USER`. Images selected by
template name have no known user and run commands as E2B's default.

Machine creation reports template preparation and allocation progress. Build
failures surface on the machine launch and may be retried. Cancelling a launch
prevents subsequent sandbox allocation; a template build already submitted to
E2B can finish and remain cached. Shared standard templates are not removed with
a machine.

Core prepares enrollment before allocation. As soon as the sandbox ID is known,
the plugin awaits a durable resource checkpoint before bootstrap, so cancellation
cleanup does not need to allocate or enroll again. Core installs the matching
daemon on demand through sandbox command execution, enrolls the machine and waits
for its connection. Bootstrap credentials travel through stdin and are never
persisted in machine resources.

Core clones the selected project and runs its `.bb-env-setup.sh`. Use that hook
to install project dependencies and start services; the hook must be idempotent
because it runs again after a resume that cold-boots the sandbox. Environment
teardown uses the core `.bb-env-teardown.sh` hook.

## Settings and commands

| Setting              | Meaning                                                               |
| -------------------- | --------------------------------------------------------------------- |
| `apiKey`             | Required E2B team API key, entered in secret settings.                |
| `region`             | E2B region that issued the key: US (default), US AWS, EU, or Asia Pacific. Picks the API domain. |
| `timeoutMinutes`     | Sandbox lifetime per session, default 60; E2B pauses when it elapses. |
| `idleMinutes`        | Pause after idle, default 15; 0 disables idle pausing.                |
| Sandbox size presets | Named vCPU and memory sizes, applied at template build time.          |
| Images               | Named Dockerfiles or existing E2B template names.                     |

E2B fixes CPU and memory per template, not per sandbox. A preset therefore
builds (and caches) a sized variant of a Dockerfile image. A preset selected
together with an existing-template image is logged and ignored, because that
template already carries its size.

Use `room-cli e2b account inspect --json` to validate credentials without
allocating resources. Create with `room-cli machine create --provider e2b-sandbox --json`,
or SDK `hosts.experimental_create({machineProviderId:"e2b-sandbox",key})`.
Machine creation accepts optional configured names in
`{"preset":"Large","image":"Node 22"}`. With one or zero choices, the default
applies and the composer shows no extra chip. Account inspection is also
available through the plugin's typed `e2bRpcContract` (`account.inspect`) and
`sdk.plugins.callRpc`. See the [command reference](skills/e2b-sandboxes/SKILL.md).

## Lifecycle

E2B keeps a sandbox's identity across pause and resume, so suspending a machine
pauses its sandbox in place and resuming calls `connect` on the same ID. There
is no snapshot image to track or delete. The default pause keeps the memory
image, so resume restores running processes; `.bb-env-setup.sh` is not rerun.

Idle pause defaults to 15 minutes and applies to existing machines without a
reload. Open terminals prevent idle pause. Sandboxes are created with
`lifecycle.onTimeout = pause`, so when the configured lifetime elapses E2B
pauses the sandbox instead of killing it; the once-per-minute sweep notices and
suspends the machine in core. A suspended machine whose sandbox is unexpectedly
running is reconciled through core. Tagged sandboxes without a matching machine
are reported and retained for inspection.

`room-cli e2b machine inspect HOST_ID --json` exposes vendor state, session
expiry and the template. Missing compute never silently becomes an empty
checkout. Remove explicitly with `room-cli machine remove MACHINE --yes`; this
kills the sandbox (running or paused) and retains the shared template.

Machines are pinned to the credentials that created them (a hash of domain and
key, since E2B exposes no team identifier to API keys). Different credentials
may still operate a machine when they demonstrably reach its sandbox, which
keeps key rotation from stranding machines; a lookup miss under foreign
credentials is refused rather than reported as missing.

## Prerequisites

An E2B API key for the right control plane, a project Git remote and access to
it, and a configured core server-access route reachable from the sandbox are
required. Agent authentication is needed to run agent turns. Template builds and
running sandboxes incur E2B usage; this plugin does not provision anything
merely by being installed or connected. Hobby plans cap a session at 60 minutes;
set `timeoutMinutes` accordingly.

## Logo

`e2b-logo.svg` contains the official E2B mark used in the plugin and machine
pickers.

## Debug an image

```sh
room-cli e2b image build --json
room-cli e2b sandbox run --json
room-cli e2b sandbox exec SANDBOX -- bash -lc 'node --version && which git'
room-cli e2b sandbox exec SANDBOX --json -- bash -lc 'exit 7'
room-cli e2b sandbox stop SANDBOX --json
```

Build uses the saved Dockerfile and the same project-wide template cache as
machine creation. It returns the template alias and the final 65,536 characters
of build logs; failures include captured logs and the vendor error. Run creates
a 30-minute debug sandbox from that template and returns `sandboxId`,
`template`, `expiresAt` and `logs`. Debug sandboxes contain no injected
credentials, daemon, project clone or setup hook, are killed (not paused) on
timeout, and are separate from Cloudroom machines.

Exec passes arguments after `--` literally; they are shell-quoted into E2B's
string command API. Commands have a 60-second timeout and output is capped at
128 KiB per stream with a truncation marker. Exec/stop only accept sandboxes
created by this plugin's debug workflow under the same credentials.

SDK clients use `sdk.plugins.callRpc` with `e2bRpcContract`: `image.build({})`,
`sandbox.run({})`, `sandbox.exec({sandboxId,command})`, and
`sandbox.stop({sandboxId})`.
