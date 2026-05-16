import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { ToolDef } from './index.js';
import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';

const execFileAsync = promisify(execFile);

const MAX_OUTPUT_CHARS = 10_000;

/* ─────────────────────────────────────────────────────────────────
 * run_code — sandboxed Python executor.
 *
 * Isolation: --network none, --read-only rootfs, --tmpfs /tmp,
 * bounded RAM + swap, 0.5 CPU, hard timeout via execFile timeout.
 *
 * Script is written to a host temp file and volume-mounted read-only
 * into the container — avoids shell injection via -c flags.
 *
 * Input data: written to a second temp file (input.json) and mounted
 * read-only at /sandbox/input.json — avoids the ~128 KB per-variable
 * OS limit that -e would impose on large scraped payloads.
 * Output: stdout, capped at MAX_OUTPUT_CHARS.
 * ───────────────────────────────────────────────────────────────── */

export const runCodeTool: ToolDef = {
  name: 'run_code',
  description:
    `Execute a Python 3 script in an isolated sandbox (no network, ${env.SANDBOX_MEMORY_MB} MB RAM, ` +
    `${Math.round(env.SANDBOX_TIMEOUT_MS / 1000)} s timeout). ` +
    'Libraries available: beautifulsoup4, lxml, pandas, requests (parsing only — no outbound calls). ' +
    'Pass data in via `input` (string or JSON-serialisable value); read it with: ' +
    '  import json; data = json.load(open("/sandbox/input.json")). ' +
    'Everything printed to stdout is returned (max 10 000 chars). ' +
    'Use for: parsing HTML tables, fuzzy-matching company lists, structuring scraped text.',
  parametersSchema: '{"code": string, "input"?: string}',
  handler: async (args, _ctx) => {
    if (!env.SANDBOX_ENABLED) {
      return {
        ok: false,
        output:
          'Code sandbox is disabled. Set SANDBOX_ENABLED=true and build the image: ' +
          'docker build -t leadreai-sandbox:latest workers/sandbox/',
      };
    }

    const code = String(args?.code ?? '').trim();
    if (!code) return { ok: false, output: 'code is required' };

    const runId = randomUUID();
    const containerName = `leadreai-sandbox-${runId}`;
    const tmpDir = join(tmpdir(), `sandbox-${runId}`);
    const scriptPath = join(tmpDir, 'script.py');
    const inputPath = join(tmpDir, 'input.json');

    // Write input as a file rather than via -e to avoid the ~128 KB per-variable
    // OS limit that would silently truncate or fail on large scraped payloads.
    const inputJson: string = JSON.stringify(
      args?.input == null ? null : args.input,
    );

    try {
      await mkdir(tmpDir, { recursive: true });
      await writeFile(scriptPath, code, 'utf-8');
      await writeFile(inputPath, inputJson, 'utf-8');

      const dockerArgs = [
        'run', '--rm',
        '--name', containerName,
        '--network', 'none',
        '--memory', `${env.SANDBOX_MEMORY_MB}m`,
        '--memory-swap', `${env.SANDBOX_MEMORY_MB}m`, // disable swap
        '--cpus', '0.5',
        '--pids-limit', '64',               // prevent fork-bomb
        '--cap-drop', 'ALL',                // drop all Linux capabilities
        '--security-opt', 'no-new-privileges',
        '--stop-signal', 'SIGKILL',         // instant stop on timeout; no grace period
        '--user', '1001:1001',              // belt-and-suspenders with Dockerfile USER
        '--read-only',
        '--tmpfs', '/tmp:size=64m,mode=1777',
        '-v', `${scriptPath}:/sandbox/script.py:ro`,
        '-v', `${inputPath}:/sandbox/input.json:ro`,
        env.SANDBOX_IMAGE,
        'python', '-u', '/sandbox/script.py',
      ];

      const startMs = Date.now();
      const result = await execFileAsync('docker', dockerArgs, {
        timeout: env.SANDBOX_TIMEOUT_MS,
        maxBuffer: (MAX_OUTPUT_CHARS + 4096) * 4,
      });
      const durationMs = Date.now() - startMs;

      const stdout = result.stdout.slice(0, MAX_OUTPUT_CHARS);
      const truncated = result.stdout.length > MAX_OUTPUT_CHARS;

      logger.info('[runCode] complete', { durationMs, truncated });

      return {
        ok: true,
        output: truncated ? `${stdout}\n[output truncated at ${MAX_OUTPUT_CHARS} characters]` : stdout,
        meta: { durationMs, truncated },
      };
    } catch (err: unknown) {
      const e = err as {
        killed?: boolean;
        stdout?: string;
        stderr?: string;
        message?: string;
      };

      if (e.killed) {
        return {
          ok: false,
          output: `Sandbox timed out after ${env.SANDBOX_TIMEOUT_MS} ms.`,
        };
      }

      // Docker exits non-zero on Python exceptions — stderr has the traceback.
      const stderr = (e.stderr ?? '').slice(0, 2000);
      if (stderr) {
        return { ok: false, output: `Python error:\n${stderr}` };
      }

      logger.warn('[runCode] error', { err: e.message });
      return {
        ok: false,
        output: `Sandbox error: ${e.message ?? String(err)}`,
      };
    } finally {
      // Force-remove the container in case execFile timeout left it running.
      await execFileAsync('docker', ['rm', '-f', containerName]).catch(() => {});
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  },
};
