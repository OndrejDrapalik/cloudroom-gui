---
name: e2b-sandboxes
description: Connect E2B and create reusable cloud machines with the bundled standard image, on-demand daemon installation, and native pause/resume lifecycle.
---

# E2B machines

1. Install `builtin:environment-e2b-sandbox` and configure `apiKey` in plugin
   Settings. Do not print credentials. `region` picks the E2B deployment the
   key belongs to (US by default; EU, US AWS, or Asia Pacific) and with it the
   API domain. The plugin page defines
   named sandbox size presets and images; the initial Default image contains
   the bundled Dockerfile.
2. Run `room-cli e2b account inspect --json` to test the connection without
   allocating compute. Exit status 1 means configuration or connection failed;
   the JSON gives a secret-free message. SDK callers use the plugin's
   `e2bRpcContract` (`account.inspect`) through `sdk.plugins.callRpc`.
3. Resolve the project with `room-cli project list --json`. It needs a Git
   remote, credentials to clone it, and machine server access reachable from
   E2B.
4. Create a standalone machine with
   `room-cli machine create --provider e2b-sandbox --json`.
   SDK: `hosts.experimental_create({machineProviderId:"e2b-sandbox",key})`.
   Standalone machines remain until explicitly removed. Sandboxes created with
   a thread retire after their last live thread is archived. Use a stable
   creation key for retries. Composed thread creation accepts optional
   configured names as `{"preset":"Large","image":"Node 22"}`.

Settings edits the Default image's Dockerfile, adds named Dockerfile or E2B
template entries, and adds named vCPU/memory presets. E2B sizes are fixed per
template, so a preset builds a sized variant of a Dockerfile image and does not
apply to existing-template entries. One or zero choices use the default without
adding a composer chip; multiple choices share one chip. Agents can run
`room-cli e2b image show > Dockerfile`, edit the file, then run
`room-cli e2b image set --file ./Dockerfile`. `room-cli e2b image reset`
restores the bundled default. Append `--json` for structured output. Typed RPCs
`image.definition`, `image.set({dockerfile})`, and `image.reset` return
`{dockerfile, customized}` through `sdk.plugins.callRpc`.

Only one FROM followed by RUN, ENV, WORKDIR, and USER is supported. Comments and
line breaks are preserved; no COPY, ADD, uploaded context, or multi-stage builds.
Maximum length is 65,536 characters. Failed validation leaves the saved
definition unchanged. Save/reset is plugin-wide and affects new machines only.
The next launch builds or reuses the content-hashed template. The bundled
default supplies tools, not the Cloudroom daemon; core installs the daemon
during bootstrap, then handles enrollment, connection and checkout cloning.

Project dependencies and services belong in `.bb-env-setup.sh`. Core runs it
after creating the checkout. Configure runtime secrets through core Machine
environment settings; never bake them into the image.

Use `room-cli machine list --json` for core suspension state and
`room-cli e2b machine inspect HOST_ID --json` for E2B state (`running`,
`paused`, `missing`), session expiry and template. Idle pause defaults to 15
minutes. The sandbox lifetime (`timeoutMinutes`, default 60) is the E2B session
timeout; when it elapses E2B pauses the sandbox and the plugin's sweep suspends
the machine in core.

Manual and idle pauses drain Cloudroom work, then pause the sandbox in place.
Resume reconnects to the same sandbox ID, restoring memory and processes without
rerunning setup. Missing compute is refused rather than replaced by an empty
sandbox.

Remove with `room-cli machine remove MACHINE --yes --json`. This kills the
sandbox whether running or paused and keeps the shared template cached. Builds
and sandboxes incur E2B usage; obtain task authorization before allocating them
during testing.

## Debug an image

```sh
room-cli e2b image build --json
room-cli e2b sandbox run --json
room-cli e2b sandbox exec SANDBOX -- bash -lc 'node --version && which git'
room-cli e2b sandbox exec SANDBOX --json -- bash -lc 'exit 7'
room-cli e2b sandbox stop SANDBOX --json
```

Build returns the template alias and the final 65,536 characters of build logs.
Run creates a 30-minute debug sandbox and returns `sandboxId`, `template`,
`expiresAt` and `logs`. Debug sandboxes contain no injected credentials, daemon,
project clone or setup hook, and are killed on timeout. Exec passes arguments
after `--` literally; use `bash -lc` for shell expressions. Place `--json`
before `--`. Commands have a 60-second timeout and output is capped at 128 KiB
per stream. Exec/stop only accept debug sandboxes created under the same
credentials.

### New thread with a new sandbox

Use `room-cli thread spawn --project <id> --environment-provider e2b-sandbox --prompt "..."`.
The composed environment creates an E2B machine and uses core project-checkout
setup to clone the project. Do not pass machine selectors with this environment.

## Reconciliation

Sandboxes carry `bbProvider=e2b-sandbox` and `bbMachineKey=<key>` metadata. The
once-per-minute sweep compares every machine with E2B: an active machine whose
sandbox E2B paused is suspended through `hosts.experimental_suspend`; a suspended
machine whose sandbox is running is reconciled through
`hosts.experimental_reconcile`. Tagged sandboxes without a matching machine are
reported and retained. Cleanup of an uncertain allocation lists by key and kills
every match, failing while any remains so core retries.
