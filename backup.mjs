import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

async function keyAt(path) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try { await writeFile(path, randomBytes(32), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  await chmod(path, 0o600);
  const key = await readFile(path);
  if (key.length !== 32) throw new Error('Invalid backup encryption key');
  return key;
}

export async function createBackup({ database, directory, keyPath }) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const key = await keyAt(keyPath);
  const temporary = join(directory, `.backup-${randomBytes(12).toString('hex')}.sqlite`);
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    await backup(db, temporary);
    await chmod(temporary, 0o600);
    if ((await stat(temporary)).size > 256 * 1024 * 1024) throw new Error('Backup exceeds the supported size');
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
    const encrypted = Buffer.concat([cipher.update(await readFile(temporary)), cipher.final()]);
    const file = join(directory, `hours-${new Date().toISOString().replaceAll(':', '-')}-${randomBytes(4).toString('hex')}.enc`);
    await writeFile(file, Buffer.concat([Buffer.from('PHB1'), nonce, cipher.getAuthTag(), encrypted]), { flag: 'wx', mode: 0o600 });
    const snapshots = (await readdir(directory)).filter(name => /^hours-.*\.enc$/.test(name)).sort();
    for (const name of snapshots.slice(0, -7)) await rm(join(directory, name));
    return file;
  } finally {
    db.close();
    await rm(temporary, { force: true });
    await rm(`${temporary}-wal`, { force: true });
    await rm(`${temporary}-shm`, { force: true });
  }
}

export async function restoreBackup({ file, keyPath, directory }) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await readdir(directory)).length) throw new Error('Restore requires a new, empty directory');
  const key = await readFile(keyPath), encrypted = await readFile(file);
  if (key.length !== 32 || encrypted.length < 32 || encrypted.subarray(0, 4).toString() !== 'PHB1') throw new Error('Invalid encrypted backup');
  const decipher = createDecipheriv('aes-256-gcm', key, encrypted.subarray(4, 16));
  decipher.setAuthTag(encrypted.subarray(16, 32));
  const plaintext = Buffer.concat([decipher.update(encrypted.subarray(32)), decipher.final()]);
  const path = join(directory, 'hours.sqlite');
  if (plaintext.subarray(0, 16).toString() !== 'SQLite format 3\0') throw new Error('Invalid SQLite backup');
  await writeFile(path, plaintext, { mode: 0o600, flag: 'wx' });
  try {
    const db = new DatabaseSync(path, { readOnly: true });
    try { if (db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') throw new Error('Restored database failed its integrity check'); }
    finally { db.close(); }
    return path;
  } catch (error) { await rm(path, { force: true }); throw error; }
}

export function startHoursBackups() {
  const state = join(process.env.OPENCLAW_STATE_DIR ?? '/var/lib/plow', 'plow-hours');
  const run = () => createBackup({ database: join(state, 'hours.sqlite'), keyPath: join(state, 'backup.key'),
    directory: process.env.PLOW_HOURS_BACKUP_DIR ?? join(state, 'backups') }).catch(() => console.error('plow-hours: backup failed; inspect the backup destination and key before relying on recovery'));
  void run();
  setInterval(run, 86_400_000).unref();
}

export async function runBackupCli(args) {
  const [action, directory, keyPath, source] = args;
  if (!directory || !keyPath || !source || !['create', 'restore'].includes(action)) throw new Error('Usage: hours-backup create DIRECTORY KEY DATABASE | hours-backup restore EMPTY_DIRECTORY KEY ENCRYPTED_FILE');
  console.log(action === 'create' ? await createBackup({ database: source, directory, keyPath }) : await restoreBackup({ file: source, keyPath, directory }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runBackupCli(process.argv.slice(2));
