import mongoose from 'mongoose';
import DataSourceCredential, { type IDataSourceCredentialDoc } from '../../models/DataSourceCredential.js';
import { encryptScoped, decryptScoped } from '../../utils/encrypt.js';
import { getDataSource } from './registry.js';
import { ApiError } from '../../utils/ApiError.js';
import { logger } from '../../utils/logger.js';

/**
 * Credential lifecycle helpers — create, resolve-default, test, decrypt.
 *
 * Writes are validated against the target DataSource's `auth.fields`
 * schema (we check keys match; field-level validation is up to the test
 * probe, not structural).
 *
 * Decryption is an operation, not a property — credentials come off the
 * DB encrypted and are decrypted on-demand by the executor, never cached
 * to memory longer than a single invocation.
 */

export interface DecryptedCredential {
  credentialId: string;
  dataSourceId: string;
  fields: Record<string, string>;
}

/**
 * Create a credential. Validates that provided field keys match the
 * DataSource's auth.fields schema; does NOT validate field values (that's
 * what `testCredential` is for).
 */
export async function createCredential(params: {
  workspaceId: string;
  dataSourceId: string;
  fields: Record<string, string>;
  label?: string;
  isDefault?: boolean;
}): Promise<IDataSourceCredentialDoc> {
  const { workspaceId, dataSourceId, fields, label, isDefault } = params;
  const ds = getDataSource(dataSourceId);
  if (!ds) throw ApiError.badRequest(`Unknown data source: ${dataSourceId}`);

  if (ds.auth.type === 'none' || ds.auth.type === 'platform') {
    throw ApiError.badRequest(`Data source ${dataSourceId} does not accept credentials`);
  }

  const expectedKeys = (ds.auth.fields ?? []).map((f) => f.key);
  const providedKeys = Object.keys(fields);
  const missing = expectedKeys.filter((k) => !providedKeys.includes(k));
  if (missing.length > 0) {
    throw ApiError.badRequest(`Missing required credential fields: ${missing.join(', ')}`);
  }
  const unknown = providedKeys.filter((k) => !expectedKeys.includes(k));
  if (unknown.length > 0) {
    throw ApiError.badRequest(`Unknown credential fields: ${unknown.join(', ')}`);
  }

  const encryptedBlob = encryptScoped(JSON.stringify(fields), 'dataSource');

  // If setting as default, unset any existing default for this (workspace, source).
  if (isDefault) {
    await DataSourceCredential.updateMany(
      { workspaceId: new mongoose.Types.ObjectId(workspaceId), dataSourceId, isDefault: true },
      { $set: { isDefault: false } },
    );
  }

  return await DataSourceCredential.create({
    workspaceId: new mongoose.Types.ObjectId(workspaceId),
    dataSourceId,
    label,
    encryptedBlob,
    isDefault: isDefault ?? true,    // first cred for a source auto-defaults
  });
}

export async function resolveDefaultCredential(
  workspaceId: string,
  dataSourceId: string,
): Promise<DecryptedCredential | null> {
  const cred = await DataSourceCredential
    .findOne({
      workspaceId: new mongoose.Types.ObjectId(workspaceId),
      dataSourceId,
      isDefault: true,
    })
    .select('+encryptedBlob')
    .lean();
  if (!cred) return null;
  return {
    credentialId: String(cred._id),
    dataSourceId,
    fields: JSON.parse(decryptScoped(cred.encryptedBlob, 'dataSource')),
  };
}

export async function resolveCredentialById(
  workspaceId: string,
  credentialId: string,
): Promise<DecryptedCredential | null> {
  if (!mongoose.Types.ObjectId.isValid(credentialId)) return null;
  const cred = await DataSourceCredential
    .findOne({
      _id: new mongoose.Types.ObjectId(credentialId),
      workspaceId: new mongoose.Types.ObjectId(workspaceId),
    })
    .select('+encryptedBlob')
    .lean();
  if (!cred) return null;
  return {
    credentialId: String(cred._id),
    dataSourceId: cred.dataSourceId,
    fields: JSON.parse(decryptScoped(cred.encryptedBlob, 'dataSource')),
  };
}

/**
 * Live test. Calls the source's `testFn` if defined; otherwise returns
 * `{ok: true, message: 'no-op (source has no test probe)'}` so the UX
 * still shows "credentials accepted" rather than suggesting failure.
 */
export async function testCredential(
  dataSourceId: string,
  fields: Record<string, string>,
): Promise<{ ok: boolean; message?: string }> {
  const ds = getDataSource(dataSourceId);
  if (!ds) return { ok: false, message: `Unknown data source: ${dataSourceId}` };
  if (!ds.auth.testFn) return { ok: true, message: 'No live test probe — credential stored but not verified.' };
  try {
    return await ds.auth.testFn(fields);
  } catch (err) {
    logger.warn('[dataSources] test probe failed', {
      dataSourceId,
      err: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export async function markCredentialUsed(credentialId: string): Promise<void> {
  await DataSourceCredential.updateOne(
    { _id: new mongoose.Types.ObjectId(credentialId) },
    { $set: { lastUsedAt: new Date() } },
  ).catch(() => { /* non-fatal — telemetry */ });
}

export async function markCredentialError(credentialId: string, message: string): Promise<void> {
  await DataSourceCredential.updateOne(
    { _id: new mongoose.Types.ObjectId(credentialId) },
    { $set: { lastErrorAt: new Date(), lastErrorMessage: message.slice(0, 500) } },
  ).catch(() => { /* non-fatal */ });
}
