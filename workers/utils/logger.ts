import winston from 'winston';
import { env } from '../config/env.js';

function errorReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return { message: value.message, name: value.name, stack: value.stack };
  }
  return value;
}

function serializeMeta(meta: Record<string, unknown>): string {
  if (!Object.keys(meta).length) return '';
  return ` ${JSON.stringify(meta, errorReplacer)}`;
}

export const logger = winston.createLogger({
  level: env.LOG_LEVEL,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp(),
        winston.format.printf(({ level, message, timestamp, ...meta }) => {
          return `${String(timestamp)} ${level}: ${String(message)}${serializeMeta(meta as Record<string, unknown>)}`;
        })
      ),
    }),
  ],
});
