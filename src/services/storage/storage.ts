import { promises as fs } from 'fs';
import path from 'path';
import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';

/**
 * Storage abstraction for user-uploaded documents.
 *
 * Today: local filesystem rooted at DOCUMENTS_STORAGE_PATH.
 * Later: S3 / R2 / GCS — swap the impl without changing callers.
 *
 * Paths handed back to Mongo are logical keys, e.g.
 * `docs/{workspaceId}/{documentId}_{basename}`, not absolute host
 * paths. The impl translates logical → physical when reading.
 */

export interface StorageService {
  write(logicalPath: string, data: Buffer): Promise<void>;
  read(logicalPath: string): Promise<Buffer>;
  remove(logicalPath: string): Promise<void>;
  exists(logicalPath: string): Promise<boolean>;
}

class LocalFsStorage implements StorageService {
  constructor(private readonly rootDir: string) {}

  private physical(logicalPath: string): string {
    // Defense-in-depth — reject any attempt to escape the root dir.
    const normalized = path.posix.normalize(logicalPath).replace(/^\/+/, '');
    if (normalized.includes('..')) {
      throw new Error(`illegal storage path: ${logicalPath}`);
    }
    return path.join(this.rootDir, normalized);
  }

  async write(logicalPath: string, data: Buffer): Promise<void> {
    const full = this.physical(logicalPath);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, data);
  }

  async read(logicalPath: string): Promise<Buffer> {
    return fs.readFile(this.physical(logicalPath));
  }

  async remove(logicalPath: string): Promise<void> {
    try {
      await fs.unlink(this.physical(logicalPath));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
  }

  async exists(logicalPath: string): Promise<boolean> {
    try {
      await fs.access(this.physical(logicalPath));
      return true;
    } catch {
      return false;
    }
  }
}

let _storage: StorageService | null = null;
export function getStorage(): StorageService {
  if (!_storage) {
    const rootDir = path.resolve(env.DOCUMENTS_STORAGE_PATH);
    logger.info('[storage] initialized LocalFsStorage', { rootDir });
    _storage = new LocalFsStorage(rootDir);
  }
  return _storage;
}

export function buildDocumentStoragePath(
  workspaceId: string,
  documentId: string,
  originalFilename: string,
): string {
  // Strip to a safe basename — the logical path shows only a sanitized
  // filename; the doc id keeps it unique. This prevents two uploads
  // named "report.pdf" from colliding.
  const safeName = path
    .basename(originalFilename)
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .slice(0, 100);
  return `docs/${workspaceId}/${documentId}_${safeName}`;
}
