import type { WorklogDatabase } from "../db";
import type { ScanStats } from "../types";
import type { HistoryAdapter } from "./common";
import { fileVersion, readJsonLines } from "./common";

export type ProgressCallback = (stats: ScanStats, currentFile?: string) => void;

export async function scanHistories(db: WorklogDatabase, adapters: HistoryAdapter[], progress?: ProgressCallback): Promise<ScanStats> {
  const stats: ScanStats = {
    filesDiscovered: 0,
    filesScanned: 0,
    filesSkipped: 0,
    sessionsUpserted: 0,
    eventsUpserted: 0,
    eventsFiltered: 0,
    errors: 0,
    startedAt: new Date().toISOString(),
  };

  for (const adapter of adapters) {
    const discoveredPaths: string[] = [];
    for await (const path of adapter.discover()) {
      discoveredPaths.push(path);
      stats.filesDiscovered += 1;
      progress?.(stats, path);
      try {
        const version = await fileVersion(path);
        let cursor = db.getFileCursor(path);
        if (cursor && version.size < cursor.last_offset) {
          db.resetFile(path);
          cursor = null;
        }
        if (cursor && cursor.size === version.size && cursor.mtime_ms === version.mtimeMs) {
          stats.filesSkipped += 1;
          continue;
        }

        const pathSeed = adapter.seedFromPath(path);
        const state = {
          session: cursor
            ? db.getSessionSeed(adapter.source, path, pathSeed.externalId) ?? pathSeed
            : pathSeed,
        };
        db.upsertSession(state.session);
        stats.sessionsUpserted += 1;
        let offset = cursor?.last_offset ?? 0;
        let line = cursor?.last_line ?? 0;
        for await (const row of readJsonLines(path, offset, line)) {
          try {
            const records = adapter.parse(row.raw, row.line, path, state);
            if (records.length === 0) stats.eventsFiltered += 1;
            for (const record of records) {
              if (record.session) {
                db.upsertSession(record.session);
                stats.sessionsUpserted += 1;
              }
              if (record.title) db.updateSessionTitle(record.title.source, record.title.sessionExternalId, record.title.title);
              if (record.event && db.upsertEvent(record.event)) stats.eventsUpserted += 1;
            }
            offset = row.endOffset;
            line = row.line;
          } catch (error) {
            stats.errors += 1;
            console.warn(`Skipping malformed ${adapter.source} record ${path}:${row.line}: ${String(error)}`);
            offset = row.endOffset;
            line = row.line;
          }
        }
        db.updateFileCursor(adapter.source, path, { ...version, offset, line, status: "complete" });
        stats.filesScanned += 1;
      } catch (error) {
        stats.errors += 1;
        const version = await fileVersion(path).catch(() => ({ size: 0, mtimeMs: 0 }));
        db.updateFileCursor(adapter.source, path, { ...version, offset: 0, line: 0, status: "error", error: String(error) });
      }
    }
    db.pruneSourceFileRows(adapter.source, discoveredPaths);
  }
  db.resolveParentSessions();
  stats.finishedAt = new Date().toISOString();
  progress?.(stats);
  return stats;
}
