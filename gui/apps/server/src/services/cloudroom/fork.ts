import { createHash, randomUUID } from "node:crypto";
import { basename } from "node:path";
import { and, asc, eq } from "drizzle-orm";
import { events, findLastCompletedRootStoredTurn, findLastRootStoredTurnStarted, getThread, listStoredTurnCompletedRowsByTurnIds, type DbConnection } from "@cloudroom/db";
import type { Thread } from "@cloudroom/domain";
import { z } from "zod";
import { ApiError } from "../../errors.js";
import { UPLOAD_PART, type CloudroomClient, type Harness, type TeleportManifest } from "./client.js";
import { cloudroom } from "./commands.js";
import { SKIPPED } from "./project-copy.js";
import { binding } from "./store.js";
import { codexLineage, download, findNative, vm } from "./teleport-local.js";

/** A Cloud fork: a new Cloud thread, in its own sandbox, that continues another Cloud thread's conversation
 *  from a chosen turn, with that thread's code (docs/scopes/sandboxes.md). Saved in the fork's first message. */
export const cloudForkSchema = z.object({
  source_thread_id: z.string(),
  end_sequence: z.number(),
  before: z.string().optional(),
  last_turn_id: z.string().optional(),
  transfer: z.string().optional(),
});
export type CloudFork = z.infer<typeof cloudForkSchema>;
/** A thread's code: a Git bundle, or a .tgz of its files when its folder has no Git history, plus its `origin` URL.
 *  `full` packs a complete bundle, for a folder without the commits a thin bundle leaves out. */
type Code = { data: Buffer; origin: string; full?: () => Promise<Buffer> };
const isFiles = (data: Buffer) => data[0] === 0x1f && data[1] === 0x8b;
const skippedNames = () => [...SKIPPED, ".cloudroom"].map((name) => `-name ${quote(name)}`).join(" -o ");
/** `applyForkCode`'s exit code when the folder lacks history the bundle needs. */
const MISSING_HISTORY = 3;
/** Before unpacking a source's files: removes the folder's files the archive lacks, and folders it holds as files.
 *  Exact names, so any file name works. Skipped names (dependencies, build output, `.cloudroom`) stay. */
const PRUNE = `import os,shutil,sys,tarfile
root,skip=sys.argv[1],set(sys.argv[3:])
with tarfile.open(sys.argv[2]) as t: names={os.path.normpath(m.name) for m in t if not m.isdir()}
for d,dirs,files in os.walk(root):
    links=[x for x in dirs if os.path.islink(os.path.join(d,x))]
    dirs[:]=[x for x in dirs if x not in skip and x not in links]
    for f in files+links:
        p=os.path.join(d,f)
        if f not in skip and os.path.relpath(p,root) not in names: os.remove(p)
for n in names:
    p=os.path.join(root,n)
    if os.path.isdir(p) and not os.path.islink(p): shutil.rmtree(p)
`;

export const FORK_HARNESSES: readonly string[] = ["claude-code", "codex"];
export const FORK_HINT = "[Cloud fork]\nThis conversation was forked from another Cloud thread and now runs in its own new sandbox. Cloudroom is copying that thread's code (its commits and uncommitted changes) into this folder. Run `room-cli files wait` before you read or change files; it returns once the code lands. Never recreate missing files.";
// Core takes teleport uploads in 1 MB parts.
const PART = 1024 * 1024;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function cloudForkOf(input: string | undefined): CloudFork | null {
  const fork = input ? (JSON.parse(input) as { fork?: unknown }).fork : undefined;
  return fork ? cloudForkSchema.parse(fork) : null;
}

/** Keeps the turn holding `sourceSeqEnd` (or the last finished turn) and everything before it, like a Local fork. */
export function cloudForkPoint(db: DbConnection, source: Thread, sourceSeqEnd: number | undefined): CloudFork {
  const started = sourceSeqEnd === undefined ? findLastCompletedRootStoredTurn(db, { threadId: source.id }) : findLastRootStoredTurnStarted(db, { threadId: source.id, atOrBeforeSequence: sourceSeqEnd });
  const completed = started && listStoredTurnCompletedRowsByTurnIds(db, { threadId: source.id, turnIds: [started.turnId] }).at(-1);
  if (!started || !completed) throw new ApiError(400, "fork_source_session_unavailable", "Fork from a message whose turn has finished.");
  const checkpoints = db.select({ sequence: events.sequence, data: events.data }).from(events)
    .where(and(eq(events.threadId, source.id), eq(events.type, "system/operation"))).orderBy(asc(events.sequence)).all()
    .map((row) => ({ sequence: row.sequence, ...(JSON.parse(row.data) as { operation?: string; metadata?: { id?: unknown; request_id?: unknown } }) }))
    .filter((event) => event.operation === "checkpoint" && typeof event.metadata?.id === "string");
  const fork = { source_thread_id: source.id, end_sequence: completed.sequence };
  // Codex checkpoints a turn when it ends. Claude checkpoints the user message that starts the next turn;
  // with no next turn yet, the fork copies the whole conversation.
  if (source.providerId === "codex") {
    const own = checkpoints.find((event) => event.metadata?.request_id === started.turnId);
    if (!own) throw new ApiError(400, "fork_source_session_unavailable", "That turn has no saved checkpoint to fork from.");
    return { ...fork, last_turn_id: own.metadata!.id as string };
  }
  const next = checkpoints.find((event) => event.sequence > completed.sequence);
  return next ? { ...fork, before: next.metadata!.id as string } : fork;
}

/** Copies the source conversation into this thread's new sandbox and waits until its agent is ready. The code
 *  snapshot starts at the same time and is applied once the project copy lands (`landForkCode`). */
export async function startCloudFork(
  deps: Parameters<typeof cloudroom>[0], client: CloudroomClient, threadId: string, fork: CloudFork,
  start: Omit<TeleportManifest, "request_id" | "harness" | "native_id" | "files" | "handoff" | "queued" | "fork">,
  saveTransfer: (id: string) => void,
): Promise<{ sessionId: string; transfer: string; code: Promise<Code | Error | null> }> {
  const source = binding(deps.db, fork.source_thread_id);
  const harness = getThread(deps.db, fork.source_thread_id)?.providerId;
  if (!source?.sessionId || !source.nativeId || !/^[A-Za-z0-9_-]+$/.test(source.nativeId) || !harness || !FORK_HARNESSES.includes(harness))
    throw new ApiError(409, "fork_source_unavailable", "The source Cloud thread has no saved conversation to fork.");
  const from = await cloudroom(deps).threadClient(fork.source_thread_id);
  const workspace = (await from.sessionWorkspace(source.sessionId)).path;
  const snapshot = (id: string) => sourceCode(from, workspace, id).catch((error: unknown) => error instanceof Error ? error : new Error(String(error)));
  // A retry after activation keeps the started fork instead of starting a second one.
  const done = fork.transfer ? await client.teleportStatus(fork.transfer).catch(() => null) : null;
  if (fork.transfer && done?.session_id) {
    await idle(client, done.session_id);
    return { sessionId: done.session_id, transfer: fork.transfer, code: snapshot(fork.transfer) };
  }
  const transfer = `fork_${randomUUID().replaceAll("-", "")}`;
  const code = snapshot(transfer);
  const path = (await vm(from, findNative(harness as "codex" | "claude-code", source.nativeId))).toString().trim();
  if (!path) throw new ApiError(409, "fork_source_unavailable", "The source conversation file was not found in its sandbox.");
  const file = await download(from, path);
  // The source may be writing its next turn; a partial last line is not part of the fork.
  const files: { path: string; kind: "native" | "lineage"; data: Buffer }[] = [{ path, kind: "native", data: file.subarray(0, file.lastIndexOf(10) + 1) }];
  // A source that is itself a Codex fork (a rewind) needs its parent files too.
  for (const parent of harness === "codex" ? await codexLineage(from, path) : [])
    files.push({ path: parent, kind: "lineage", data: await download(from, parent) });
  if (files.length > 1 && (await client.capabilities()).teleport_lineage !== true)
    throw new ApiError(409, "fork_update", "Forking this Codex chat needs a newer cloud core. Try again after the next Cloudroom update.");
  const entries = files.map((entry) => ({ ...entry, sha256: createHash("sha256").update(entry.data).digest("hex") }));
  saveTransfer(transfer);
  await client.prepareTeleport({
    ...start, request_id: transfer, harness: harness as Harness, native_id: source.nativeId, handoff: "", queued: [], fork: true,
    files: entries.map((entry) => ({ path: basename(entry.path), size: entry.data.length, sha256: entry.sha256, kind: entry.kind, executable: false })),
  });
  for (const [index, entry] of entries.entries())
    for (let offset = 0; offset < entry.data.length; offset += PART)
      await client.uploadTeleport(transfer, index, offset, entry.sha256, entry.data.subarray(offset, offset + PART), entry.data.length);
  const sessionId = (await client.activateTeleport(transfer)).session_id;
  if (!sessionId) throw new ApiError(503, "fork_start_failed", "The fork's sandbox did not start its agent.");
  await idle(client, sessionId);
  return { sessionId, transfer, code };
}

export const CHILD_HINT = "[Cloud child]\nYou run in your own sandbox. Cloudroom is copying your parent thread's code (its commits and uncommitted changes) into this folder. Run `room-cli files wait` before you read or change files; it returns once the code lands. Never recreate missing files.";

/** A Cloud parent's code (its branch plus uncommitted changes) for a child in a sandbox of its own (ADR 0229),
 *  applied with `landForkCode` like a fork's. Null when the parent has no folder. */
export async function threadCode(deps: Parameters<typeof cloudroom>[0], threadId: string, id: string): Promise<Code | Error | null> {
  try {
    const source = binding(deps.db, threadId);
    if (!source?.sessionId) return null;
    const from = await cloudroom(deps).threadClient(threadId);
    return await sourceCode(from, (await from.sessionWorkspace(source.sessionId)).path, id);
  } catch (error) { return error instanceof Error ? error : new Error(String(error)); }
}

/** A fork's first message is a native fork (a rewind), which needs the resumed agent to be idle. */
async function idle(client: CloudroomClient, sessionId: string): Promise<void> {
  for (let tries = 0; ; tries++) {
    const session = await client.session(sessionId);
    if (session.state === "idle" || session.current_request !== null) return;
    if (["failed", "process_lost", "closed"].includes(session.state) || tries === 240)
      throw new ApiError(503, "fork_start_failed", `The fork's agent did not start (${session.state}).`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** The source's branch plus its uncommitted changes as one extra commit, packed as a Git bundle. A folder with no Git
 *  history (a project not on GitHub) goes as its files instead, without dependencies or build output. The source is untouched. */
async function sourceCode(from: CloudroomClient, workspace: string, id: string): Promise<Code | null> {
  const pack = async (thin: boolean): Promise<Code | null> => {
    const [path, origin = ""] = (await vm(from, codeScript(workspace, id, thin))).toString().trim().split("\n");
    if (!path) return null;
    try { return { data: await download(from, path, 500), origin: origin.trim() }; }
    finally { await vm(from, `rm -f ${quote(path)}`).catch(() => {}); }
  };
  const code = await pack(true);
  if (!code || isFiles(code.data)) return code;
  return {
    ...code,
    full: async () => {
      const complete = await pack(false);
      if (!complete) throw new Error("The source thread's folder is gone.");
      return complete.data;
    },
  };
}

function codeScript(workspace: string, id: string, thin: boolean): string {
  const ref = `refs/cloudroom/${id}`;
  return [
    `cd ${quote(workspace)} 2>/dev/null || exit 0`,
    `if ! git rev-parse -q --verify HEAD >/dev/null 2>&1; then f=~/.cache/cloudroom/${id}.tgz && mkdir -p ~/.cache/cloudroom || exit 1`,
    // Listed first, so a folder find can't read fails the copy instead of leaving files out. A file that changes or
    // vanishes while packing (a log) is only a warning: tar exits 1 for it.
    `  l="$f.list" && find . -mindepth 1 \\( ${skippedNames()} \\) -prune -o \\( -type f -o -type l \\) -print0 > "$l" && { tar -czf "$f" --ignore-failed-read --warning=no-file-changed --null -T "$l"; [ $? -le 1 ] && [ -s "$f" ]; } && echo "$f"; code=$?; rm -f "$l"; exit $code`,
    "fi",
    // A temporary index, so the source's own staging area stays as it was. An empty file is not a valid index.
    `index=$(mktemp) && rm -f "$index" && trap 'rm -f "$index"; git update-ref -d ${ref} 2>/dev/null' EXIT`,
    `cp "$(git rev-parse --git-path index)" "$index" 2>/dev/null`,
    `GIT_INDEX_FILE="$index" git add -A >/dev/null 2>&1 && tree=$(GIT_INDEX_FILE="$index" git write-tree) || exit 1`,
    `commit=$(git -c user.name=Cloudroom -c user.email=cloudroom@localhost commit-tree "$tree" -p HEAD -m 'Cloudroom fork: uncommitted changes') || exit 1`,
    `git update-ref ${ref} "$commit" && mkdir -p ~/.cache/cloudroom || exit 1`,
    `f=~/.cache/cloudroom/${id}.bundle`,
    thin
      ? `{ git bundle create -q "$f" ${ref} --not --remotes 2>/dev/null || git bundle create -q "$f" ${ref}; } && echo "$f" || exit 1`
      : `git bundle create -q "$f" ${ref} && echo "$f" || exit 1`,
    // A thin bundle needs the commits it leaves out, so a target folder with no Git fetches them from here.
    "git remote get-url origin 2>/dev/null; true",
  ].join("\n");
}

async function uploadCode(client: CloudroomClient, file: string, data: Buffer): Promise<void> {
  for (let offset = 0; offset < data.length; offset += UPLOAD_PART) {
    const part = new Uint8Array(data.subarray(offset, offset + UPLOAD_PART));
    const result = await client.runOnVm({ command: `mkdir -p ~/.cache/cloudroom && truncate -s ${offset} ~/${file} && cat >> ~/${file}` }, undefined, part);
    if (result.code !== 0) throw new Error(Buffer.from(result.stderr, "hex").toString().trim() || "The code upload failed.");
  }
}

/** Puts the source's code in the fork's folder once its project copy landed. Returns why it could not, or null. */
export async function landForkCode(client: CloudroomClient, started: { sessionId: string; transfer: string; code: Promise<Code | Error | null> | null }): Promise<string | null> {
  const code = await started.code;
  if (!code) return "The source thread's code was not copied, since it has no project folder.";
  try {
    if (code instanceof Error) throw code;
    await applyForkCode(client, (await client.sessionWorkspace(started.sessionId)).path, started.transfer, code);
    return null;
  } catch (error) {
    return `The source thread's code could not be copied: ${error instanceof Error ? error.message : String(error)}.`;
  }
}

/** Moves the fork's branch to the source's commit and leaves the source's uncommitted changes uncommitted, unless
 *  the folder already has changes. A folder with no Git repository gets one. Plain files replace the folder's files,
 *  so files the source deleted are gone here too; dependencies, build output and `.cloudroom` stay. */
async function applyForkCode(client: CloudroomClient, workspace: string, id: string, code: Code): Promise<void> {
  const files = isFiles(code.data);
  const file = `.cache/cloudroom/${id}.${files ? "tgz" : "bundle"}`;
  await uploadCode(client, file, code.data);
  if (files) {
    const skipped = [...SKIPPED, ".cloudroom"].map(quote).join(" ");
    await vm(client, `mkdir -p ${quote(workspace)} && cd ${quote(workspace)} && python3 -I -c ${quote(PRUNE)} . ~/${file} ${skipped} && tar -xzf ~/${file}; code=$?; rm -f ~/${file}; exit $code`);
    return;
  }
  const land = () => client.runOnVm({
    command: [
      // The child of a project not on GitHub, or whose clone failed, has no repository yet.
      // Never on the default branch, so a push can't reach the user's main; the app renames it to the thread's room/ branch.
      `cd ${quote(workspace)} && { git rev-parse --git-dir >/dev/null 2>&1 || { git init -q && git symbolic-ref HEAD refs/heads/cloudroom/${id}; }; } || { rm -f ~/${file}; exit 1; }`,
      code.origin ? `git remote get-url origin >/dev/null 2>&1 || git remote add origin ${quote(code.origin)}` : "",
      // Never reset over work the agent already did here: keep it and say why the code was not copied.
      `if git rev-parse -q --verify HEAD >/dev/null && ! git diff --quiet HEAD; then echo 'The folder already had changes, so they were kept and the code was not copied in' >&2; rm -f ~/${file}; exit 1; fi`,
      // A thin bundle leaves out commits the source's remote has: fetch them, or ask for a complete bundle.
      `git bundle verify -q ~/${file} >/dev/null 2>&1 || GIT_TERMINAL_PROMPT=0 git fetch -q origin >/dev/null 2>&1; git bundle verify -q ~/${file} >/dev/null 2>&1 || { rm -f ~/${file}; exit ${MISSING_HISTORY}; }`,
      `git fetch -q ~/${file} refs/cloudroom/${id} && git reset -q --hard FETCH_HEAD && git reset -q HEAD~1`,
      `code=$?; rm -f ~/${file}; exit $code`,
    ].join("\n"),
    stdin: "",
  });
  let result = await land();
  if (result.code === MISSING_HISTORY && code.full) {
    await uploadCode(client, file, await code.full());
    result = await land();
  }
  if (result.code !== 0 || result.truncated)
    throw new Error(Buffer.from(result.stderr, "hex").toString().trim() || (result.code === MISSING_HISTORY ? "It needs Git history this sandbox could not fetch" : `Cloud command failed (${result.code})`));
}
