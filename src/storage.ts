/**
 * Local filesystem storage for OpenSquid v0.1.
 *
 * Mirrors loop-engine's status-as-directory invariant (ADR-0010):
 * the directory a lesson lives in IS its canonical status.
 *
 *   ~/.opensquid/
 *   └── lessons/
 *       ├── pending/    <id>.json
 *       ├── active/
 *       ├── promoted/
 *       ├── discarded/
 *       └── superseded/
 *
 * Concurrency: v0.1 assumes single-process access (the MCP server
 * runs as one stdio session per host). Multi-process safety lands
 * when we wire to loop-engine's CAS-RMW storage layer.
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Lesson, LessonStatus } from "./types.js";

const STATUSES: LessonStatus[] = [
  "pending",
  "active",
  "promoted",
  "discarded",
  "superseded",
];

function root(): string {
  return process.env.OPENSQUID_HOME ?? join(homedir(), ".opensquid");
}

function statusDir(status: LessonStatus): string {
  return join(root(), "lessons", status);
}

function lessonPath(status: LessonStatus, id: string): string {
  return join(statusDir(status), `${id}.json`);
}

async function ensureDirs(): Promise<void> {
  for (const s of STATUSES) {
    await fs.mkdir(statusDir(s), { recursive: true });
  }
}

export async function writeLesson(lesson: Lesson): Promise<void> {
  await ensureDirs();
  const path = lessonPath(lesson.status, lesson.id);
  await fs.writeFile(path, JSON.stringify(lesson, null, 2), "utf8");
}

/** Find a lesson by id across all status dirs. Returns null if absent. */
export async function findLesson(id: string): Promise<Lesson | null> {
  await ensureDirs();
  for (const s of STATUSES) {
    try {
      const raw = await fs.readFile(lessonPath(s, id), "utf8");
      return JSON.parse(raw) as Lesson;
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") continue;
      throw e;
    }
  }
  return null;
}

/**
 * Move a lesson between status directories. Used by promote +
 * eliminate. The in-memory `lesson` arg's `status` field MUST
 * already reflect the target status; we read the OLD status from
 * the on-disk path discovery.
 */
export async function moveLesson(lesson: Lesson, fromStatus: LessonStatus): Promise<void> {
  await ensureDirs();
  const oldPath = lessonPath(fromStatus, lesson.id);
  const newPath = lessonPath(lesson.status, lesson.id);
  await fs.writeFile(newPath, JSON.stringify(lesson, null, 2), "utf8");
  if (oldPath !== newPath) {
    try {
      await fs.unlink(oldPath);
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") throw e;
    }
  }
}

/** Load all lessons across all status dirs. v0.1 is memory-resident. */
export async function listAllLessons(): Promise<Lesson[]> {
  await ensureDirs();
  const out: Lesson[] = [];
  for (const s of STATUSES) {
    let entries: string[];
    try {
      entries = await fs.readdir(statusDir(s));
    } catch {
      continue;
    }
    for (const f of entries) {
      if (!f.endsWith(".json")) continue;
      try {
        const raw = await fs.readFile(join(statusDir(s), f), "utf8");
        const lesson = JSON.parse(raw) as Lesson;
        lesson.status = s; // directory wins over frontmatter (ADR-0010)
        out.push(lesson);
      } catch {
        // skip malformed
      }
    }
  }
  return out;
}
