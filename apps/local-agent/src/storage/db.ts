/**
 * SQLite 存储。MVP 阶段仅保存非敏感 Provider 配置元数据与本地服务设置。
 * API Key 不落库（见 security/vault.ts）。
 */
import Database from "better-sqlite3";
import type { ProviderConfig } from "@prompt-boost/shared";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { hardenPrivateDirectory, hardenPrivateFile } from "../security/private-file.js";

export interface StoredRow {
  id: string;
  type: string;
  name: string;
  base_url: string;
  model: string;
  timeout_seconds: number;
  custom_headers_json: string | null;
  disable_thinking: number;
  enabled: number;
  created_at: string | null;
  updated_at: string | null;
}

export interface SettingsRow {
  key: string;
  value: string;
}

export interface DbHandle {
  db: Database.Database;
  listProviders(): StoredRow[];
  getProvider(id: string): StoredRow | null;
  upsertProvider(config: ProviderConfig): void;
  deleteProvider(id: string): void;
  getSetting(key: string): string | null;
  setSetting(key: string, value: string): void;
  purgeSensitiveResidue?(): void;
  close(): void;
}

export function openDatabase(dbPath: string): DbHandle {
  hardenPrivateDirectory(dirname(dbPath));
  const databaseFiles = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
  const hardenDatabaseFiles = (): void => {
    for (const file of databaseFiles) {
      if (existsSync(file)) hardenPrivateFile(file);
    }
  };
  // 升级场景中，收紧父目录并不会可靠改写既有文件的继承 ACL。
  hardenDatabaseFiles();
  const db = new Database(dbPath);

  db.pragma("journal_mode = WAL");
  db.pragma("secure_delete = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      model TEXT NOT NULL,
      timeout_seconds INTEGER NOT NULL DEFAULT 30,
      custom_headers_json TEXT,
      disable_thinking INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // 老库迁移：阶段 4 新增列。
  const cols = db
    .prepare(`PRAGMA table_info(providers)`)
    .all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("enabled")) {
    db.exec(`ALTER TABLE providers ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1`);
  }
  if (!names.has("disable_thinking")) {
    db.exec(`ALTER TABLE providers ADD COLUMN disable_thinking INTEGER NOT NULL DEFAULT 0`);
  }
  if (!names.has("created_at")) {
    db.exec(`ALTER TABLE providers ADD COLUMN created_at TEXT`);
  }
  if (!names.has("updated_at")) {
    db.exec(`ALTER TABLE providers ADD COLUMN updated_at TEXT`);
  }

  const listProviders = (): StoredRow[] =>
    db
      .prepare(
        `SELECT id, type, name, base_url, model, timeout_seconds, custom_headers_json, disable_thinking, enabled, created_at, updated_at
         FROM providers ORDER BY name ASC`,
      )
      .all() as StoredRow[];

  const getProvider = (id: string): StoredRow | null =>
    (db
      .prepare(
        `SELECT id, type, name, base_url, model, timeout_seconds, custom_headers_json, disable_thinking, enabled, created_at, updated_at
         FROM providers WHERE id = ?`,
      )
      .get(id) as StoredRow | undefined) ?? null;

  const upsertProvider = (config: ProviderConfig): void => {
    db.prepare(
      `INSERT INTO providers (id, type, name, base_url, model, timeout_seconds, custom_headers_json, disable_thinking, enabled, created_at, updated_at)
       VALUES (@id, @type, @name, @baseUrl, @model, @timeoutSeconds, @customHeadersJson, @disableThinking, @enabled, @createdAt, @updatedAt)
       ON CONFLICT(id) DO UPDATE SET
         type = excluded.type,
         name = excluded.name,
         base_url = excluded.base_url,
         model = excluded.model,
         timeout_seconds = excluded.timeout_seconds,
         custom_headers_json = excluded.custom_headers_json,
         disable_thinking = excluded.disable_thinking,
         enabled = excluded.enabled,
         created_at = excluded.created_at,
         updated_at = excluded.updated_at`,
    ).run({
      ...config,
      disableThinking: config.disableThinking ? 1 : 0,
      enabled: config.enabled ? 1 : 0,
      // 时间戳可省略（调用方未提供时落 NULL），better-sqlite3 要求每个命名参数都在。
      createdAt: config.createdAt ?? null,
      updatedAt: config.updatedAt ?? null,
      customHeadersJson: config.customHeaders
        ? JSON.stringify(config.customHeaders)
        : null,
    });
  };

  const deleteProvider = (id: string): void => {
    db.prepare(`DELETE FROM providers WHERE id = ?`).run(id);
  };

  const getSetting = (key: string): string | null => {
    const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  };

  const setSetting = (key: string, value: string): void => {
    db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(key, value);
  };

  const purgeSensitiveResidue = (): void => {
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.exec("VACUUM");
    db.pragma("wal_checkpoint(TRUNCATE)");
    hardenDatabaseFiles();
  };

  hardenDatabaseFiles();

  return {
    db,
    listProviders,
    getProvider,
    upsertProvider,
    deleteProvider,
    getSetting,
    setSetting,
    purgeSensitiveResidue,
    close: () => db.close(),
  };
}
