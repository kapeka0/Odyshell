import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type JournalResult = {
  status: "succeeded" | "failed" | "cancelled" | "timed_out" | "execution_unknown";
  exitCode: number | null;
  error?: string;
  outputTruncated: boolean;
};

export type JournalReconciliation = {
  operationId: string;
  result: JournalResult;
};

export class OperationJournal {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS operations (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        result_json TEXT,
        updated_at TEXT NOT NULL
      );
    `);
  }

  recoverInterrupted(): number {
    const result: JournalResult = {
      status: "execution_unknown",
      exitCode: null,
      error: "Client restarted before it could prove the Operation outcome",
      outputTruncated: false,
    };
    const recovery = this.db
      .prepare(
        "UPDATE operations SET state = 'completed', result_json = ?, updated_at = ? WHERE state <> 'completed'",
      )
      .run(JSON.stringify(result), new Date().toISOString());
    return Number(recovery.changes);
  }

  receive(id: string): "new" | "running" | "completed" {
    const row = this.db.prepare("SELECT state FROM operations WHERE id = ?").get(id) as
      | { state: string }
      | undefined;
    if (!row) {
      this.db
        .prepare("INSERT INTO operations (id, state, updated_at) VALUES (?, 'received', ?)")
        .run(id, new Date().toISOString());
      return "new";
    }
    if (row.state === "completed") return "completed";
    return "running";
  }

  markRunning(id: string): void {
    this.db
      .prepare("UPDATE operations SET state = 'running', updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
  }

  complete(id: string, result: JournalResult): void {
    this.db
      .prepare(
        "UPDATE operations SET state = 'completed', result_json = ?, updated_at = ? WHERE id = ?",
      )
      .run(JSON.stringify(result), new Date().toISOString(), id);
  }

  result(id: string): JournalResult | undefined {
    const row = this.db.prepare("SELECT result_json FROM operations WHERE id = ?").get(id) as
      | { result_json: string | null }
      | undefined;
    return row?.result_json ? (JSON.parse(row.result_json) as JournalResult) : undefined;
  }

  resultsForReconciliation(): JournalReconciliation[] {
    const rows = this.db
      .prepare(
        "SELECT id, result_json FROM operations WHERE state = 'completed' AND result_json IS NOT NULL ORDER BY rowid",
      )
      .all() as Array<{ id: string; result_json: string }>;
    return rows.map((row) => ({
      operationId: row.id,
      result: JSON.parse(row.result_json) as JournalResult,
    }));
  }

  acknowledge(id: string): void {
    this.db.prepare("DELETE FROM operations WHERE id = ? AND state = 'completed'").run(id);
  }

  close(): void {
    this.db.close();
  }
}
