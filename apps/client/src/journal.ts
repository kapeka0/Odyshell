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

function truncatedResult(result: JournalResult): JournalResult {
  return result.outputTruncated
    ? result
    : {
        ...result,
        error: result.error ?? "Operation output is incomplete",
        outputTruncated: true,
      };
}

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
        output_truncated INTEGER NOT NULL DEFAULT 0,
        output_unconfirmed INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
    `);
    const columns = this.db
      .prepare("PRAGMA table_info(operations)")
      .all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "output_truncated")) {
      this.db.exec(
        "ALTER TABLE operations ADD COLUMN output_truncated INTEGER NOT NULL DEFAULT 0",
      );
    }
    if (!columns.some((column) => column.name === "output_unconfirmed")) {
      this.db.exec(
        "ALTER TABLE operations ADD COLUMN output_unconfirmed INTEGER NOT NULL DEFAULT 0",
      );
    }
  }

  recoverInterrupted(): number {
    type RecoveryRow = {
      id: string;
      state: string;
      result_json: string | null;
      output_truncated: number;
      output_unconfirmed: number;
    };
    const update = this.db.prepare(
      "UPDATE operations SET state = 'completed', result_json = ?, output_truncated = ?, output_unconfirmed = 0, updated_at = ? WHERE id = ?",
    );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const recoverable = this.db
        .prepare(
          "SELECT id, state, result_json, output_truncated, output_unconfirmed FROM operations WHERE state <> 'completed' OR output_unconfirmed = 1 ORDER BY rowid",
        )
        .all() as RecoveryRow[];
      let interrupted = 0;
      for (const row of recoverable) {
        const incompleteOutput =
          row.output_truncated === 1 || row.output_unconfirmed === 1;
        const result: JournalResult = row.state === "completed" && row.result_json
          ? incompleteOutput
            ? truncatedResult(JSON.parse(row.result_json) as JournalResult)
            : JSON.parse(row.result_json) as JournalResult
          : {
              status: "execution_unknown",
              exitCode: null,
              error: "Client restarted before it could prove the Operation outcome",
              outputTruncated: incompleteOutput,
            };
        if (row.state !== "completed") interrupted += 1;
        update.run(
          JSON.stringify(result),
          result.outputTruncated ? 1 : 0,
          new Date().toISOString(),
          row.id,
        );
      }
      this.db.exec("COMMIT");
      return interrupted;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
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

  markOutputUnconfirmed(id: string): void {
    this.db
      .prepare(
        "UPDATE operations SET output_unconfirmed = 1, updated_at = ? WHERE id = ? AND output_truncated = 0",
      )
      .run(new Date().toISOString(), id);
  }

  complete(id: string, result: JournalResult): void {
    const row = this.db
      .prepare("SELECT output_truncated FROM operations WHERE id = ?")
      .get(id) as { output_truncated: number } | undefined;
    const durableResult = row?.output_truncated === 1
      ? truncatedResult(result)
      : result;
    this.db
      .prepare(
        "UPDATE operations SET state = 'completed', result_json = ?, output_truncated = ?, updated_at = ? WHERE id = ?",
      )
      .run(
        JSON.stringify(durableResult),
        durableResult.outputTruncated ? 1 : 0,
        new Date().toISOString(),
        id,
      );
  }

  markOutputTruncated(id: string): void {
    const row = this.db
      .prepare("SELECT result_json FROM operations WHERE id = ?")
      .get(id) as { result_json: string | null } | undefined;
    if (!row) return;
    const result = row.result_json
      ? truncatedResult(JSON.parse(row.result_json) as JournalResult)
      : undefined;
    this.db
      .prepare(
        "UPDATE operations SET result_json = ?, output_truncated = 1, output_unconfirmed = 0, updated_at = ? WHERE id = ?",
      )
      .run(
        result ? JSON.stringify(result) : null,
        new Date().toISOString(),
        id,
      );
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
