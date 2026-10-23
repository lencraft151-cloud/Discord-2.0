import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL, -- leer bei Konten, die nur per Discord angemeldet werden
  color         TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);

-- Ein Server ist entweder ein lokaler Discord-2.0-Server (owner_id + invite_code)
-- oder ein über den Bot gespiegelter echter Discord-Server (discord_guild_id).
CREATE TABLE IF NOT EXISTS servers (
  id               INTEGER PRIMARY KEY,
  name             TEXT NOT NULL,
  owner_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  invite_code      TEXT UNIQUE,
  discord_guild_id TEXT UNIQUE,
  icon_url         TEXT,
  active           INTEGER NOT NULL DEFAULT 1,
  created_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (server_id, user_id)
);

-- type 'text'/'voice' gehört zu einem Server, type 'dm' ist eine Direktnachricht.
-- Eine DM mit discord_user_id ist ein Gespräch mit einem echten Discord-Nutzer.
CREATE TABLE IF NOT EXISTS channels (
  id                 INTEGER PRIMARY KEY,
  server_id          INTEGER REFERENCES servers(id) ON DELETE CASCADE,
  type               TEXT NOT NULL,
  name               TEXT NOT NULL,
  position           INTEGER NOT NULL DEFAULT 0,
  discord_channel_id TEXT UNIQUE,
  discord_user_id    TEXT,
  discord_avatar     TEXT,
  active             INTEGER NOT NULL DEFAULT 1,
  backfilled         INTEGER NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS dm_participants (
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (channel_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id                    INTEGER PRIMARY KEY,
  channel_id            INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  author_id             INTEGER REFERENCES users(id) ON DELETE SET NULL,
  discord_author_id     TEXT,
  discord_author_name   TEXT,
  discord_author_avatar TEXT,
  content               TEXT NOT NULL,
  created_at            INTEGER NOT NULL,
  edited_at             INTEGER,
  discord_message_id    TEXT UNIQUE
);
CREATE INDEX IF NOT EXISTS messages_channel ON messages(channel_id, created_at, id);

-- Merkt sich, welche Bot-DM an einen Discord-Nutzer zu welchem Gespräch gehört,
-- damit Antworten (Reply) beim richtigen Discord-2.0-Nutzer landen.
CREATE TABLE IF NOT EXISTS discord_dm_routes (
  discord_message_id TEXT PRIMARY KEY,
  channel_id         INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS discord_dm_last (
  discord_user_id TEXT PRIMARY KEY,
  channel_id      INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE
);
`;

// Spalten, die nach der ersten Version dazugekommen sind. Werden bei älteren
// Datenbanken automatisch ergänzt.
const ADDED_COLUMNS = [
  ['users', 'discord_id', 'TEXT'],
  ['users', 'avatar_url', 'TEXT'],
  ['users', 'discord_access_token', 'TEXT'],
  ['users', 'discord_refresh_token', 'TEXT'],
  ['users', 'discord_token_expires', 'INTEGER'],
];

function migrate(db) {
  for (const [table, column, type] of ADDED_COLUMNS) {
    const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
    if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_discord_id ON users(discord_id)');
}

export function openDatabase(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

// Führt fn in einer Transaktion aus (node:sqlite hat keinen eigenen Helfer dafür).
export function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
