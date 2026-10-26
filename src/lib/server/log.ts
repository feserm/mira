/** The one logger of the web app and the ETL worker: one JSON object per line on stdout, so a log
 *  shipper needs no parser rules. No `$app` or `$env` imports, because the worker bundle uses it too.
 *
 *  Two rules keep secrets out of the logs:
 *  - a field is a string, number, boolean or null. Anything else (an Error, a Response, a request
 *    header map, a token record) is not written at all, so a caller cannot log an object by accident.
 *    Pass `errorMessage(e)`, never `e`.
 *  - strings are scrubbed of anything that looks like an API token or a bearer credential, as a
 *    second line of defence. Callers still must not pass headers, cookies, tokens, request bodies or
 *    query strings in the first place. */

export type LogLevel = 'info' | 'warn' | 'error';
export type LogValue = string | number | boolean | null | undefined;
export type LogFields = Record<string, LogValue>;

const MAX_STRING = 500;
const RESERVED = new Set(['ts', 'level', 'msg']);

// An MIRA API token (`mira_` + 43 base64url characters, see api-token.ts) and a `Bearer <credential>`.
const SECRET_PATTERNS: [RegExp, string][] = [
	[/\bmira_[A-Za-z0-9_-]{16,}/g, '[redacted-token]'],
	[/\bBearer\s+[^\s"',;]+/gi, 'Bearer [redacted]']
];

function scrub(value: string): string {
	let out = value;
	for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
	return out.length > MAX_STRING ? `${out.slice(0, MAX_STRING)}...` : out;
}

/** The message of an error, never the error itself (it can carry a token, a URL or a response). */
export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export type LogSink = (line: string) => void;
let sink: LogSink = (line) => console.log(line);

/** Replaces where lines go. For tests; returns what to pass to restore the previous sink. */
export function setLogSink(next: LogSink | undefined): void {
	sink = next ?? ((line) => console.log(line));
}

export function formatLine(level: LogLevel, msg: string, fields: LogFields = {}): string {
	const entry: Record<string, string | number | boolean | null> = {
		ts: new Date().toISOString(),
		level,
		msg: scrub(msg)
	};
	for (const [key, value] of Object.entries(fields)) {
		if (RESERVED.has(key) || value === undefined) continue;
		if (typeof value === 'string') entry[key] = scrub(value);
		else if (typeof value === 'number') entry[key] = Number.isFinite(value) ? value : null;
		else if (typeof value === 'boolean' || value === null) entry[key] = value;
		// anything else is dropped on purpose, see the header
	}
	return JSON.stringify(entry);
}

function emit(level: LogLevel, msg: string, fields?: LogFields): void {
	try {
		sink(formatLine(level, msg, fields));
	} catch {
		// logging must never break a request or a job
	}
}

export const logger = {
	info: (msg: string, fields?: LogFields) => emit('info', msg, fields),
	warn: (msg: string, fields?: LogFields) => emit('warn', msg, fields),
	error: (msg: string, fields?: LogFields) => emit('error', msg, fields)
};
