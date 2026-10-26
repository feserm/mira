import { afterEach, describe, expect, it } from 'vitest';
import { errorMessage, logger, setLogSink } from './log';

const lines: string[] = [];
const parsed = () => lines.map((l) => JSON.parse(l));

afterEach(() => {
	lines.length = 0;
	setLogSink(undefined);
});

describe('logger', () => {
	it('writes one JSON object per call with timestamp, level and message', () => {
		setLogSink((l) => lines.push(l));
		logger.warn('hello', { requestId: 'abc', status: 404, ok: false, none: null });
		expect(lines).toHaveLength(1);
		expect(lines[0]).not.toContain('\n');
		const [entry] = parsed();
		expect(entry).toMatchObject({
			level: 'warn',
			msg: 'hello',
			requestId: 'abc',
			status: 404,
			ok: false,
			none: null
		});
		expect(new Date(entry.ts).toISOString()).toBe(entry.ts);
	});

	it('leaves out undefined fields and cannot be made to overwrite ts, level or msg', () => {
		setLogSink((l) => lines.push(l));
		logger.info('real', { authMethod: undefined, level: 'error', msg: 'fake', ts: 'yesterday' });
		const [entry] = parsed();
		expect(entry).not.toHaveProperty('authMethod');
		expect(entry.level).toBe('info');
		expect(entry.msg).toBe('real');
		expect(entry.ts).not.toBe('yesterday');
	});

	it('drops anything that is not a primitive, so an Error or a header map cannot be logged', () => {
		setLogSink((l) => lines.push(l));
		logger.error('failed', {
			err: new Error('boom: Bearer abc.def') as never,
			headers: { authorization: 'Bearer abc.def', cookie: 'session=zzz' } as never
		});
		expect(lines[0]).not.toContain('authorization');
		expect(lines[0]).not.toContain('session=zzz');
		expect(lines[0]).not.toContain('boom');
	});

	it('scrubs API tokens and bearer credentials from messages and string fields', () => {
		setLogSink((l) => lines.push(l));
		const token = `mira_${'A1b2C3d4'.repeat(5)}`;
		logger.error(`refused ${token} and Bearer glpat-secret-value`, { note: `token=${token}` });
		expect(lines[0]).not.toContain(token);
		expect(lines[0]).not.toContain('glpat-secret-value');
		expect(lines[0]).toContain('[redacted-token]');
	});

	it('truncates very long strings and never throws when the sink does', () => {
		setLogSink((l) => lines.push(l));
		logger.info('x'.repeat(5000));
		expect(parsed()[0].msg.length).toBeLessThan(600);
		setLogSink(() => {
			throw new Error('disk full');
		});
		expect(() => logger.info('still fine')).not.toThrow();
	});

	it('errorMessage returns the message, not the error', () => {
		expect(errorMessage(new Error('boom'))).toBe('boom');
		expect(errorMessage('plain')).toBe('plain');
	});
});
