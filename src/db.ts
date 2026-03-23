import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, DATA_DIR, STORE_DIR } from './config.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import {
  NewMessage,
  Person,
  PersonApi,
  RegisteredGroup,
  ScheduledTask,
  TaskRunLog,
  Tenant,
} from './types.js';

let db: Database.Database;

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT,
      channel TEXT,
      is_group INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      is_bot_message INTEGER DEFAULT 0,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);

    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      group_folder TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS people (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'benisrael',
      name TEXT NOT NULL,
      relation TEXT DEFAULT '',
      emoji TEXT DEFAULT '',
      color TEXT DEFAULT '#58a6ff',
      contact_tier INTEGER DEFAULT 6,
      phone TEXT DEFAULT '',
      whatsapp TEXT DEFAULT '',
      email TEXT DEFAULT '',
      telegram TEXT DEFAULT '',
      preferred_channel TEXT DEFAULT 'whatsapp',
      quiet_hours_start TEXT DEFAULT '22:00',
      quiet_hours_end TEXT DEFAULT '07:00',
      language TEXT DEFAULT 'en',
      jarvis_personality TEXT DEFAULT 'classic_butler',
      jarvis_personality_custom TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      aliases TEXT DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tenants (
      tenant_id TEXT PRIMARY KEY,
      owner TEXT NOT NULL DEFAULT 'Rotem',
      jarvis_name TEXT DEFAULT 'Jarvis',
      moneypenny_power INTEGER DEFAULT 3,
      timezone TEXT DEFAULT 'America/Los_Angeles',
      language TEXT DEFAULT 'en',
      weather_location TEXT DEFAULT 'Los Altos Hills, CA'
    );
  `);

  // Add context_mode column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`,
    );
  } catch {
    /* column already exists */
  }

  // Add is_bot_message column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE messages ADD COLUMN is_bot_message INTEGER DEFAULT 0`,
    );
    // Backfill: mark existing bot messages that used the content prefix pattern
    database
      .prepare(`UPDATE messages SET is_bot_message = 1 WHERE content LIKE ?`)
      .run(`${ASSISTANT_NAME}:%`);
  } catch {
    /* column already exists */
  }

  // Add is_main column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN is_main INTEGER DEFAULT 0`,
    );
    // Backfill: existing rows with folder = 'main' are the main group
    database.exec(
      `UPDATE registered_groups SET is_main = 1 WHERE folder = 'main'`,
    );
  } catch {
    /* column already exists */
  }

  // Add weather_location column to tenants if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE tenants ADD COLUMN weather_location TEXT DEFAULT 'Los Altos Hills, CA'`,
    );
  } catch {
    /* column already exists */
  }

  // Add aliases column to people if it doesn't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE people ADD COLUMN aliases TEXT DEFAULT '[]'`);
  } catch { /* column already exists */ }

  // Seed aliases for existing people who have none
  const aliasSeeds: Record<string, string> = {
    rotem: JSON.stringify(['husband', 'dad', 'father']),
    miko: JSON.stringify(['michal', 'dr michal', 'dr. michal', 'mom', 'mother', 'wife']),
    itay: JSON.stringify(['gandalf', 'mr gandalf']),
    danielle: JSON.stringify([]),
    noya: JSON.stringify([]),
  };
  for (const [id, aliases] of Object.entries(aliasSeeds)) {
    database
      .prepare(`UPDATE people SET aliases = ? WHERE id = ? AND (aliases IS NULL OR aliases = '[]')`)
      .run(aliases, id);
  }

  // Add channel and is_group columns if they don't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE chats ADD COLUMN channel TEXT`);
    database.exec(`ALTER TABLE chats ADD COLUMN is_group INTEGER DEFAULT 0`);
    // Backfill from JID patterns
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 1 WHERE jid LIKE '%@g.us'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 0 WHERE jid LIKE '%@s.whatsapp.net'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'discord', is_group = 1 WHERE jid LIKE 'dc:%'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'telegram', is_group = 1 WHERE jid LIKE 'tg:%'`,
    );
  } catch {
    /* columns already exist */
  }
}

function seedDefaults(): void {
  const peopleCount = (
    db.prepare('SELECT COUNT(*) AS cnt FROM people').get() as { cnt: number }
  ).cnt;

  if (peopleCount === 0) {
    const people = [
      {
        id: 'rotem', tenant_id: 'benisrael', name: 'Rotem', relation: 'Self',
        emoji: '\u{1F464}', color: '#58a6ff', contact_tier: 6,
        phone: '+19256995147', whatsapp: '+19256995147', email: 'rotemben@gmail.com',
        telegram: 'tg:1449522448', preferred_channel: 'telegram', language: 'en',
        quiet_hours_start: '23:00', quiet_hours_end: '07:00',
        jarvis_personality: 'classic_butler', jarvis_personality_custom: '',
        notes: 'Owner. Primary channel is Telegram tg:1449522448.',
        aliases: JSON.stringify(['husband', 'dad', 'father']),
      },
      {
        id: 'miko', tenant_id: 'benisrael', name: 'Miko', relation: 'Spouse',
        emoji: '\u{1F49A}', color: '#f778ba', contact_tier: 6,
        phone: '+19253214959', whatsapp: '+19253214959', email: 'dr.michal@gmail.com',
        telegram: '', preferred_channel: 'whatsapp', language: 'he',
        quiet_hours_start: '22:00', quiet_hours_end: '07:00',
        jarvis_personality: 'warm_friend', jarvis_personality_custom: '',
        notes: '',
        aliases: JSON.stringify(['michal', 'dr michal', 'dr. michal', 'mom', 'mother', 'wife']),
      },
      {
        id: 'itay', tenant_id: 'benisrael', name: 'Itay', relation: 'Son',
        emoji: '\u{1F9D9}', color: '#a371f7', contact_tier: 6,
        phone: '+19258779599', whatsapp: '+19258779599', email: '',
        telegram: '', preferred_channel: 'whatsapp', language: 'he',
        quiet_hours_start: '21:00', quiet_hours_end: '08:00',
        jarvis_personality: 'storyteller', jarvis_personality_custom: '',
        notes: 'Nickname: Mr. Gandalf. Loves stories and adventure.',
        aliases: JSON.stringify(['gandalf', 'mr gandalf']),
      },
      {
        id: 'danielle', tenant_id: 'benisrael', name: 'Danielle', relation: 'Daughter',
        emoji: '\u{2728}', color: '#f0883e', contact_tier: 6,
        phone: '+19252060778', whatsapp: '+19252060778', email: '',
        telegram: '', preferred_channel: 'whatsapp', language: 'he',
        quiet_hours_start: '22:00', quiet_hours_end: '08:00',
        jarvis_personality: 'warm_friend', jarvis_personality_custom: '',
        notes: '', aliases: JSON.stringify([]),
      },
      {
        id: 'noya', tenant_id: 'benisrael', name: 'Noya', relation: 'Daughter',
        emoji: '\u{1F6AB}', color: '#8b949e', contact_tier: 0,
        phone: '', whatsapp: '', email: '',
        telegram: '', preferred_channel: 'none', language: 'he',
        quiet_hours_start: '00:00', quiet_hours_end: '00:00',
        jarvis_personality: 'warm_friend', jarvis_personality_custom: '',
        notes: 'Does not like AI. Do not contact under any circumstances. Tier 0 enforced server-side.',
        aliases: JSON.stringify([]),
      },
    ];

    const insert = db.prepare(
      `INSERT INTO people (id, tenant_id, name, relation, emoji, color, contact_tier,
         phone, whatsapp, email, telegram, preferred_channel,
         quiet_hours_start, quiet_hours_end, language,
         jarvis_personality, jarvis_personality_custom, notes, aliases, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertAll = db.transaction((rows: typeof people) => {
      for (const p of rows) {
        insert.run(
          p.id, p.tenant_id, p.name, p.relation, p.emoji, p.color, p.contact_tier,
          p.phone, p.whatsapp, p.email, p.telegram, p.preferred_channel,
          p.quiet_hours_start, p.quiet_hours_end, p.language,
          p.jarvis_personality, p.jarvis_personality_custom, p.notes,
          p.aliases, new Date().toISOString(),
        );
      }
    });
    insertAll(people);
    logger.info({ count: people.length }, 'Seeded default family (benisrael)');
  }

  const tenantCount = (
    db.prepare('SELECT COUNT(*) AS cnt FROM tenants').get() as { cnt: number }
  ).cnt;
  if (tenantCount === 0) {
    db.prepare(
      `INSERT INTO tenants (tenant_id, owner, jarvis_name, moneypenny_power, timezone, language, weather_location)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('benisrael', 'Rotem', 'Jarvis', 3, 'America/Los_Angeles', 'en', 'Pleasanton, CA');
    logger.info({ tenantId: 'benisrael' }, 'Seeded default tenant (benisrael)');
  }
}

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  createSchema(db);
  seedDefaults();

  // Migrate from JSON files if they exist
  migrateJsonState();
}

/** Return the raw DB instance. Use sparingly for queries not covered by helpers. */
export function getDb(): Database.Database {
  return db;
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export function _initTestDatabase(): void {
  db = new Database(':memory:');
  createSchema(db);
}

/**
 * Store chat metadata only (no message content).
 * Used for all chats to enable group discovery without storing sensitive content.
 */
export function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
): void {
  const ch = channel ?? null;
  const group = isGroup === undefined ? null : isGroup ? 1 : 0;

  if (name) {
    // Update with name, preserving existing timestamp if newer
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = excluded.name,
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, name, timestamp, ch, group);
  } else {
    // Update timestamp only, preserve existing name if any
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, chatJid, timestamp, ch, group);
  }
}

/**
 * Update chat name without changing timestamp for existing chats.
 * New chats get the current time as their initial timestamp.
 * Used during group metadata sync.
 */
export function updateChatName(chatJid: string, name: string): void {
  db.prepare(
    `
    INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET name = excluded.name
  `,
  ).run(chatJid, name, new Date().toISOString());
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
  channel: string;
  is_group: number;
}

/**
 * Get all known chats, ordered by most recent activity.
 */
export function getAllChats(): ChatInfo[] {
  return db
    .prepare(
      `
    SELECT jid, name, last_message_time, channel, is_group
    FROM chats
    ORDER BY last_message_time DESC
  `,
    )
    .all() as ChatInfo[];
}

/**
 * Get timestamp of last group metadata sync.
 */
export function getLastGroupSync(): string | null {
  // Store sync time in a special chat entry
  const row = db
    .prepare(`SELECT last_message_time FROM chats WHERE jid = '__group_sync__'`)
    .get() as { last_message_time: string } | undefined;
  return row?.last_message_time || null;
}

/**
 * Record that group metadata was synced.
 */
export function setLastGroupSync(): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO chats (jid, name, last_message_time) VALUES ('__group_sync__', '__group_sync__', ?)`,
  ).run(now);
}

/**
 * Store a message with full content.
 * Only call this for registered groups where message history is needed.
 */
export function storeMessage(msg: NewMessage): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
  );
}

/**
 * Store a message directly.
 */
export function storeMessageDirect(msg: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  is_bot_message?: boolean;
}): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
  );
}

export function getNewMessages(
  jids: string[],
  lastTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): { messages: NewMessage[]; newTimestamp: string } {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  const placeholders = jids.map(() => '?').join(',');
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  // Subquery takes the N most recent, outer query re-sorts chronologically.
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me
      FROM messages
      WHERE timestamp > ? AND chat_jid IN (${placeholders})
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;

  const rows = db
    .prepare(sql)
    .all(lastTimestamp, ...jids, `${botPrefix}:%`, limit) as NewMessage[];

  let newTimestamp = lastTimestamp;
  for (const row of rows) {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
  }

  return { messages: rows, newTimestamp };
}

export function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): NewMessage[] {
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  // Subquery takes the N most recent, outer query re-sorts chronologically.
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me
      FROM messages
      WHERE chat_jid = ? AND timestamp > ?
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;
  return db
    .prepare(sql)
    .all(chatJid, sinceTimestamp, `${botPrefix}:%`, limit) as NewMessage[];
}

export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): void {
  db.prepare(
    `
    INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    task.id,
    task.group_folder,
    task.chat_jid,
    task.prompt,
    task.schedule_type,
    task.schedule_value,
    task.context_mode || 'isolated',
    task.next_run,
    task.status,
    task.created_at,
  );
}

export function getTaskById(id: string): ScheduledTask | undefined {
  return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as
    | ScheduledTask
    | undefined;
}

export function getTasksForGroup(groupFolder: string): ScheduledTask[] {
  return db
    .prepare(
      'SELECT * FROM scheduled_tasks WHERE group_folder = ? ORDER BY created_at DESC',
    )
    .all(groupFolder) as ScheduledTask[];
}

export function getAllTasks(): ScheduledTask[] {
  return db
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as ScheduledTask[];
}

export function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      'prompt' | 'schedule_type' | 'schedule_value' | 'next_run' | 'status'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(updates.prompt);
  }
  if (updates.schedule_type !== undefined) {
    fields.push('schedule_type = ?');
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push('schedule_value = ?');
    values.push(updates.schedule_value);
  }
  if (updates.next_run !== undefined) {
    fields.push('next_run = ?');
    values.push(updates.next_run);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(
    `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function deleteTask(id: string): void {
  // Delete child records first (FK constraint)
  db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}

export function getDueTasks(): ScheduledTask[] {
  const now = new Date().toISOString();
  return db
    .prepare(
      `
    SELECT * FROM scheduled_tasks
    WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
    ORDER BY next_run
  `,
    )
    .all(now) as ScheduledTask[];
}

export function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `
    UPDATE scheduled_tasks
    SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
    WHERE id = ?
  `,
  ).run(nextRun, now, lastResult, nextRun, id);
}

export function logTaskRun(log: TaskRunLog): void {
  db.prepare(
    `
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    log.task_id,
    log.run_at,
    log.duration_ms,
    log.status,
    log.result,
    log.error,
  );
}

// --- Router state accessors ---

export function getRouterState(key: string): string | undefined {
  const row = db
    .prepare('SELECT value FROM router_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setRouterState(key: string, value: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
  ).run(key, value);
}

// --- Session accessors ---

export function getSession(groupFolder: string): string | undefined {
  const row = db
    .prepare('SELECT session_id FROM sessions WHERE group_folder = ?')
    .get(groupFolder) as { session_id: string } | undefined;
  return row?.session_id;
}

export function setSession(groupFolder: string, sessionId: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO sessions (group_folder, session_id) VALUES (?, ?)',
  ).run(groupFolder, sessionId);
}

export function getAllSessions(): Record<string, string> {
  const rows = db
    .prepare('SELECT group_folder, session_id FROM sessions')
    .all() as Array<{ group_folder: string; session_id: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.group_folder] = row.session_id;
  }
  return result;
}

// --- Registered group accessors ---

export function getRegisteredGroup(
  jid: string,
): (RegisteredGroup & { jid: string }) | undefined {
  const row = db
    .prepare('SELECT * FROM registered_groups WHERE jid = ?')
    .get(jid) as
    | {
        jid: string;
        name: string;
        folder: string;
        trigger_pattern: string;
        added_at: string;
        container_config: string | null;
        requires_trigger: number | null;
        is_main: number | null;
      }
    | undefined;
  if (!row) return undefined;
  if (!isValidGroupFolder(row.folder)) {
    logger.warn(
      { jid: row.jid, folder: row.folder },
      'Skipping registered group with invalid folder',
    );
    return undefined;
  }
  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    trigger: row.trigger_pattern,
    added_at: row.added_at,
    containerConfig: row.container_config
      ? JSON.parse(row.container_config)
      : undefined,
    requiresTrigger:
      row.requires_trigger === null ? undefined : row.requires_trigger === 1,
    isMain: row.is_main === 1 ? true : undefined,
  };
}

export function setRegisteredGroup(jid: string, group: RegisteredGroup): void {
  if (!isValidGroupFolder(group.folder)) {
    throw new Error(`Invalid group folder "${group.folder}" for JID ${jid}`);
  }
  db.prepare(
    `INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jid,
    group.name,
    group.folder,
    group.trigger,
    group.added_at,
    group.containerConfig ? JSON.stringify(group.containerConfig) : null,
    group.requiresTrigger === undefined ? 1 : group.requiresTrigger ? 1 : 0,
    group.isMain ? 1 : 0,
  );
}

export function getAllRegisteredGroups(): Record<string, RegisteredGroup> {
  const rows = db.prepare('SELECT * FROM registered_groups').all() as Array<{
    jid: string;
    name: string;
    folder: string;
    trigger_pattern: string;
    added_at: string;
    container_config: string | null;
    requires_trigger: number | null;
    is_main: number | null;
  }>;
  const result: Record<string, RegisteredGroup> = {};
  for (const row of rows) {
    if (!isValidGroupFolder(row.folder)) {
      logger.warn(
        { jid: row.jid, folder: row.folder },
        'Skipping registered group with invalid folder',
      );
      continue;
    }
    result[row.jid] = {
      name: row.name,
      folder: row.folder,
      trigger: row.trigger_pattern,
      added_at: row.added_at,
      containerConfig: row.container_config
        ? JSON.parse(row.container_config)
        : undefined,
      requiresTrigger:
        row.requires_trigger === null ? undefined : row.requires_trigger === 1,
      isMain: row.is_main === 1 ? true : undefined,
    };
  }
  return result;
}

// --- People CRUD ---

function rowToPerson(row: Person): PersonApi {
  const { quiet_hours_start, quiet_hours_end, ...rest } = row;
  return {
    ...rest,
    aliases: (() => {
      try { return JSON.parse((rest.aliases as unknown as string) || '[]'); }
      catch { return []; }
    })(),
    quiet_hours: {
      start: quiet_hours_start || '22:00',
      end: quiet_hours_end || '07:00',
    },
  };
}

export function getAllPeople(tenantId?: string): PersonApi[] {
  const tid = tenantId || 'benisrael';
  const rows = db
    .prepare('SELECT * FROM people WHERE tenant_id = ? ORDER BY rowid')
    .all(tid) as Person[];
  return rows.map(rowToPerson);
}

export function getPersonById(id: string): Person | undefined {
  return db.prepare('SELECT * FROM people WHERE id = ?').get(id) as
    | Person
    | undefined;
}

export function getPersonByName(name: string): Person | undefined {
  return db
    .prepare('SELECT * FROM people WHERE LOWER(name) = LOWER(?)')
    .get(name) as Person | undefined;
}

export function createPerson(data: Record<string, unknown>): PersonApi {
  const flat = flattenQuietHours(data);
  const id =
    (flat.id as string) ||
    (flat.name as string).toLowerCase().replace(/[^a-z0-9]/g, '_');
  const tid = (flat.tenant_id as string) || 'benisrael';

  db.prepare(
    `INSERT INTO people (id, tenant_id, name, relation, emoji, color, contact_tier,
       phone, whatsapp, email, telegram, preferred_channel,
       quiet_hours_start, quiet_hours_end, language,
       jarvis_personality, jarvis_personality_custom, notes, aliases, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    tid,
    flat.name || '',
    flat.relation || '',
    flat.emoji || '',
    flat.color || '#58a6ff',
    flat.contact_tier ?? 6,
    flat.phone || '',
    flat.whatsapp || '',
    flat.email || '',
    flat.telegram || '',
    flat.preferred_channel || 'whatsapp',
    flat.quiet_hours_start || '22:00',
    flat.quiet_hours_end || '07:00',
    flat.language || 'en',
    flat.jarvis_personality || 'classic_butler',
    flat.jarvis_personality_custom || '',
    flat.notes || '',
    JSON.stringify(Array.isArray(flat.aliases) ? flat.aliases : []),
    new Date().toISOString(),
  );

  const inserted = db
    .prepare('SELECT * FROM people WHERE id = ?')
    .get(id) as Person;
  return rowToPerson(inserted);
}

export function updatePerson(
  id: string,
  updates: Record<string, unknown>,
): { person: PersonApi; changedFields: string[] } | undefined {
  const existing = getPersonById(id);
  if (!existing) return undefined;

  const flat = flattenQuietHours(updates);
  const allowedCols = [
    'name',
    'relation',
    'emoji',
    'color',
    'contact_tier',
    'phone',
    'whatsapp',
    'email',
    'telegram',
    'preferred_channel',
    'quiet_hours_start',
    'quiet_hours_end',
    'language',
    'jarvis_personality',
    'jarvis_personality_custom',
    'notes',
    'aliases',
    'tenant_id',
  ];
  const sets: string[] = [];
  const vals: unknown[] = [];
  const changedFields: string[] = [];

  for (const col of allowedCols) {
    if (flat[col] !== undefined) {
      sets.push(`${col} = ?`);
      if (col === 'aliases') {
        vals.push(JSON.stringify(Array.isArray(flat[col]) ? flat[col] : []));
      } else {
        vals.push(flat[col]);
      }
      changedFields.push(col);
    }
  }

  if (sets.length > 0) {
    vals.push(id);
    db.prepare(`UPDATE people SET ${sets.join(', ')} WHERE id = ?`).run(
      ...vals,
    );
  }

  const updated = db
    .prepare('SELECT * FROM people WHERE id = ?')
    .get(id) as Person;
  return { person: rowToPerson(updated), changedFields };
}

export function deletePerson(id: string): void {
  db.prepare('DELETE FROM people WHERE id = ?').run(id);
}

// --- Tenant CRUD ---

export function getTenant(tenantId: string): Tenant | undefined {
  return db
    .prepare('SELECT * FROM tenants WHERE tenant_id = ?')
    .get(tenantId) as Tenant | undefined;
}

export function updateTenant(
  tenantId: string,
  updates: Record<string, unknown>,
): Tenant | undefined {
  const allowed = [
    'owner',
    'jarvis_name',
    'moneypenny_power',
    'timezone',
    'language',
    'weather_location',
  ];
  const fields = Object.keys(updates).filter((k) => allowed.includes(k));
  if (fields.length === 0) return undefined;

  const setClauses = fields.map((f) => `${f} = ?`).join(', ');
  const values = fields.map((f) => updates[f]);
  db.prepare(`UPDATE tenants SET ${setClauses} WHERE tenant_id = ?`).run(
    ...values,
    tenantId,
  );

  return getTenant(tenantId);
}

// --- Session deletion (used by portal for personality reset) ---

export function deleteSession(groupFolder: string): void {
  db.prepare('DELETE FROM sessions WHERE group_folder = ?').run(groupFolder);
}

// --- Helpers ---

function flattenQuietHours(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const flat = { ...body };
  const qh = flat.quiet_hours as Record<string, string> | undefined;
  if (qh) {
    if (qh.start !== undefined) flat.quiet_hours_start = qh.start;
    if (qh.end !== undefined) flat.quiet_hours_end = qh.end;
    delete flat.quiet_hours;
  }
  return flat;
}

// --- JSON migration ---

function migrateJsonState(): void {
  const migrateFile = (filename: string) => {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      fs.renameSync(filePath, `${filePath}.migrated`);
      return data;
    } catch {
      return null;
    }
  };

  // Migrate router_state.json
  const routerState = migrateFile('router_state.json') as {
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  } | null;
  if (routerState) {
    if (routerState.last_timestamp) {
      setRouterState('last_timestamp', routerState.last_timestamp);
    }
    if (routerState.last_agent_timestamp) {
      setRouterState(
        'last_agent_timestamp',
        JSON.stringify(routerState.last_agent_timestamp),
      );
    }
  }

  // Migrate sessions.json
  const sessions = migrateFile('sessions.json') as Record<
    string,
    string
  > | null;
  if (sessions) {
    for (const [folder, sessionId] of Object.entries(sessions)) {
      setSession(folder, sessionId);
    }
  }

  // Migrate registered_groups.json
  const groups = migrateFile('registered_groups.json') as Record<
    string,
    RegisteredGroup
  > | null;
  if (groups) {
    for (const [jid, group] of Object.entries(groups)) {
      try {
        setRegisteredGroup(jid, group);
      } catch (err) {
        logger.warn(
          { jid, folder: group.folder, err },
          'Skipping migrated registered group with invalid folder',
        );
      }
    }
  }
}
