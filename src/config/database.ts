import mongoose from 'mongoose';
import { env } from './env.js';
import { logger } from '../utils/logger.js';

export async function connectDatabase(): Promise<void> {
  const MAX_RETRIES = 5;
  let attempt = 0;
  while (attempt < MAX_RETRIES) {
    try {
      await mongoose.connect(env.MONGODB_URI, { dbName: env.MONGODB_DB_NAME });
      logger.info('MongoDB connected');
      mongoose.connection.on('error', (err) => logger.error('MongoDB error', { err }));
      mongoose.connection.on('disconnected', () => logger.warn('MongoDB disconnected'));
      await runIndexMigrations();
      return;
    } catch (err) {
      attempt++;
      logger.error(`MongoDB connection attempt ${attempt} failed`, { err });
      if (attempt >= MAX_RETRIES) throw err;
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

/**
 * Idempotent index migrations that run on every boot.
 *
 * Mongoose auto-creates any *new* index declared on a model, but it
 * doesn't drop stale indexes whose options have changed. We handle
 * those drops explicitly here — each step is guarded so reruns no-op.
 */
async function runIndexMigrations(): Promise<void> {
  const db = mongoose.connection.db;
  if (!db) return;

  // File: the original (workspaceId, sourceJobId) index was
  // `sparse: true`, which doesn't exclude docs where only sourceJobId
  // is missing. Manual-file creation (two files in one workspace with
  // no sourceJobId) tripped a duplicate-key error. The model now uses
  // `partialFilterExpression: { sourceJobId: { $type: 'objectId' } }`
  // instead. Drop the stale sparse variant so Mongoose can recreate
  // under the new spec.
  try {
    const filesColl = db.collection('files');
    const indexes = await filesColl.indexes();
    const stale = indexes.find(
      (ix) => ix.name === 'workspaceId_1_sourceJobId_1' && ix.sparse === true,
    );
    if (stale) {
      await filesColl.dropIndex('workspaceId_1_sourceJobId_1');
      logger.info('Dropped stale sparse index files.workspaceId_1_sourceJobId_1');
    }
  } catch (err) {
    // Not fatal — if the index doesn't exist or has already been
    // migrated, boot should still proceed.
    logger.warn('Index migration (files.sourceJobId) skipped', { err: (err as Error).message });
  }
}
