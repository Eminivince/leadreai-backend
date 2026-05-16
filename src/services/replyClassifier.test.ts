import { describe, it, expect, beforeAll } from 'vitest';

beforeAll(() => {
  process.env['NODE_ENV'] = 'test';
  process.env['JWT_SECRET'] = 'a'.repeat(32);
  process.env['JWT_REFRESH_SECRET'] = 'b'.repeat(32);
  process.env['MONGODB_URI'] = 'mongodb://localhost:27017/test';
  process.env['MONGODB_DB_NAME'] = 'leadreai_test';
  process.env['REDIS_URL'] = 'redis://localhost:6379';
  process.env['UNSUBSCRIBE_TOKEN_SECRET'] = 'c'.repeat(16);
});

describe('classifyReply', () => {
  it('classifies a mailer-daemon bounce', async () => {
    const { classifyReply } = await import('./replyClassifier.js');
    expect(classifyReply({
      from: 'MAILER-DAEMON@example.com',
      subject: 'Delivery Status Notification (Failure)',
      bodyText: '550 user unknown',
    })).toBe('bounce');
  });

  it('classifies an OOO subject', async () => {
    const { classifyReply } = await import('./replyClassifier.js');
    expect(classifyReply({
      from: 'jane@example.com',
      subject: 'Auto-Reply: Out of Office',
      bodyText: "I'm currently away and will respond on Monday.",
    })).toBe('ooo');
  });

  it('classifies via Auto-Submitted header', async () => {
    const { classifyReply } = await import('./replyClassifier.js');
    expect(classifyReply({
      from: 'jane@example.com',
      subject: 'Re: your message',
      bodyText: 'Thanks - back next week.',
      headers: { 'auto-submitted': 'auto-replied' },
    })).toBe('ooo');
  });

  it('classifies a positive interest reply', async () => {
    const { classifyReply } = await import('./replyClassifier.js');
    expect(classifyReply({
      from: 'cto@example.com',
      subject: 'Re: your pitch',
      bodyText: "Sounds interesting - let's schedule a call next week.",
    })).toBe('positive');
  });

  it('does NOT classify a not-interested reply as positive', async () => {
    const { classifyReply } = await import('./replyClassifier.js');
    expect(classifyReply({
      from: 'cto@example.com',
      subject: 'Re: your pitch',
      bodyText: 'Not interested - please remove me from your list.',
    })).toBe('unknown');
  });

  it('returns unknown when no signals match', async () => {
    const { classifyReply } = await import('./replyClassifier.js');
    expect(classifyReply({
      from: 'someone@example.com',
      subject: 'Re: hi',
      bodyText: 'Got it.',
    })).toBe('unknown');
  });
});
