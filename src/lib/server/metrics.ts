/** A small Prometheus registry: counters, gauges and histograms with a text exposition. Written
 *  instead of adding `prom-client` (a dependency with its own transitive tree and default collectors
 *  we would mostly switch off) because MIRA needs three metric types and about thirty series.
 *  No `$app` or `$env` imports.
 *
 *  Metrics are **per process**: every web pod has its own registry and its own counters, which reset
 *  when the pod restarts. Aggregate over pods in Prometheus (`sum by`, or `max by` for values every
 *  pod reads from the database). The ETL worker serves no HTTP port and exposes nothing.
 *
 *  Label cardinality is a hard rule. Labels are declared per metric, values come from small fixed
 *  sets (route patterns from SvelteKit's `route.id`, a status class, an outcome name) and never from
 *  a request: no raw path, repo slug, user id, ARC id, token id or client address. As a backstop a
 *  metric stops creating series at `MAX_SERIES` and counts what it refused in
 *  `mira_metrics_dropped_series_total`, so a mistake costs a counter instead of the Prometheus server. */

export type Labels = Record<string, string>;

const MAX_SERIES = 1000;

function escapeLabel(value: string): string {
	return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function format(value: number): string {
	if (Number.isNaN(value)) return 'NaN';
	if (value === Infinity) return '+Inf';
	if (value === -Infinity) return '-Inf';
	return String(value);
}

abstract class Metric {
	constructor(
		readonly name: string,
		readonly help: string,
		readonly labelNames: readonly string[] = []
	) {}
	abstract readonly type: 'counter' | 'gauge' | 'histogram';
	abstract lines(): string[];

	protected key(labels: Labels): string {
		return this.labelNames.map((n) => labels[n] ?? '').join('\u0000');
	}

	protected render(labels: Labels, extra?: Labels): string {
		const all = { ...labels, ...extra };
		const names = [...this.labelNames, ...Object.keys(extra ?? {})];
		if (names.length === 0) return '';
		return `{${names.map((n) => `${n}="${escapeLabel(all[n] ?? '')}"`).join(',')}}`;
	}

	header(): string[] {
		return [
			`# HELP ${this.name} ${this.help.replace(/\n/g, ' ')}`,
			`# TYPE ${this.name} ${this.type}`
		];
	}
}

/** True when a new series may be created; otherwise counts the refusal. */
function admit(size: number): boolean {
	if (size < MAX_SERIES) return true;
	droppedSeries.inc(); // defined below; only reached once a metric is full, long after load
	return false;
}

export class Counter extends Metric {
	readonly type = 'counter';
	private series = new Map<string, { labels: Labels; value: number }>();

	constructor(name: string, help: string, labelNames: readonly string[] = []) {
		super(name, help, labelNames);
		// a counter without labels exists from the start, so `rate()` and alerts see 0, not a gap
		if (labelNames.length === 0) this.series.set('', { labels: {}, value: 0 });
	}

	inc(labels: Labels = {}, by = 1): void {
		const key = this.key(labels);
		const s = this.series.get(key);
		if (s) s.value += by;
		else if (admit(this.series.size)) this.series.set(key, { labels: { ...labels }, value: by });
	}

	/** Sets the running total, for a counter whose truth lives elsewhere (the database) and is read at
	 *  scrape time. */
	set(labels: Labels, value: number): void {
		const key = this.key(labels);
		const s = this.series.get(key);
		if (s) s.value = value;
		else if (admit(this.series.size)) this.series.set(key, { labels: { ...labels }, value });
	}

	/** For tests. */
	value(labels: Labels = {}): number {
		return this.series.get(this.key(labels))?.value ?? 0;
	}

	lines(): string[] {
		return [...this.series.values()].map(
			(s) => `${this.name}${this.render(s.labels)} ${format(s.value)}`
		);
	}
}

export class Gauge extends Metric {
	readonly type = 'gauge';
	private series = new Map<string, { labels: Labels; value: number }>();

	set(labels: Labels, value: number): void;
	set(value: number): void;
	set(a: Labels | number, b?: number): void {
		const labels = typeof a === 'number' ? {} : a;
		const value = typeof a === 'number' ? a : (b as number);
		const key = this.key(labels);
		const s = this.series.get(key);
		if (s) s.value = value;
		else if (admit(this.series.size)) this.series.set(key, { labels: { ...labels }, value });
	}

	/** Forgets every series, so a state that no longer exists does not linger at its last value. */
	clear(): void {
		this.series.clear();
	}

	lines(): string[] {
		return [...this.series.values()].map(
			(s) => `${this.name}${this.render(s.labels)} ${format(s.value)}`
		);
	}
}

export const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

export class Histogram extends Metric {
	readonly type = 'histogram';
	private series = new Map<
		string,
		{ labels: Labels; counts: number[]; sum: number; count: number }
	>();

	constructor(
		name: string,
		help: string,
		labelNames: readonly string[] = [],
		readonly buckets: readonly number[] = DEFAULT_BUCKETS
	) {
		super(name, help, labelNames);
	}

	observe(labels: Labels, value: number): void {
		const key = this.key(labels);
		let s = this.series.get(key);
		if (!s) {
			if (!admit(this.series.size)) return;
			s = { labels: { ...labels }, counts: this.buckets.map(() => 0), sum: 0, count: 0 };
			this.series.set(key, s);
		}
		this.buckets.forEach((le, i) => {
			if (value <= le) s.counts[i]++;
		});
		s.sum += value;
		s.count++;
	}

	/** For tests. */
	count(labels: Labels): number {
		return this.series.get(this.key(labels))?.count ?? 0;
	}

	lines(): string[] {
		const out: string[] = [];
		for (const s of this.series.values()) {
			this.buckets.forEach((le, i) =>
				out.push(`${this.name}_bucket${this.render(s.labels, { le: String(le) })} ${s.counts[i]}`)
			);
			out.push(`${this.name}_bucket${this.render(s.labels, { le: '+Inf' })} ${s.count}`);
			out.push(`${this.name}_sum${this.render(s.labels)} ${format(s.sum)}`);
			out.push(`${this.name}_count${this.render(s.labels)} ${s.count}`);
		}
		return out;
	}
}

type Collector = () => void | Promise<void>;

export class Registry {
	private metrics: Metric[] = [];
	private collectors = new Map<string, Collector>();

	register<T extends Metric>(metric: T): T {
		this.metrics.push(metric);
		return metric;
	}

	/** Runs just before every scrape to set values that are only known then (a queue length, a count
	 *  in the database). A collector that throws is counted and skipped; it never fails the scrape. */
	collect(name: string, fn: Collector): void {
		this.collectors.set(name, fn);
	}

	async render(): Promise<string> {
		for (const [name, fn] of this.collectors) {
			try {
				await fn();
			} catch {
				collectorErrors.inc({ collector: name });
			}
		}
		const out: string[] = [];
		for (const m of this.metrics) {
			const lines = m.lines();
			if (lines.length === 0) continue;
			out.push(...m.header(), ...lines);
		}
		return `${out.join('\n')}\n`;
	}
}

export const registry = new Registry();

const counter = (name: string, help: string, labels: string[] = []) =>
	registry.register(new Counter(name, help, labels));
const gauge = (name: string, help: string, labels: string[] = []) =>
	registry.register(new Gauge(name, help, labels));

export const droppedSeries = counter(
	'mira_metrics_dropped_series_total',
	'Series refused because a metric reached its series limit (a label cardinality bug).'
);
const collectorErrors = counter(
	'mira_metrics_collector_errors_total',
	'Scrape-time collectors that failed (the metrics they set are missing from that scrape).',
	['collector']
);

// --- HTTP ---------------------------------------------------------------------------------------
export const httpRequests = counter(
	'mira_http_requests_total',
	'HTTP requests served, by method, route pattern and status class. Probes and /metrics excluded.',
	['method', 'route', 'status_class']
);
export const httpDuration = registry.register(
	new Histogram(
		'mira_http_request_duration_seconds',
		'HTTP request duration in seconds, by method, route pattern and status class.',
		['method', 'route', 'status_class']
	)
);
export const brapiAuthFailures = counter(
	'mira_brapi_auth_failures_total',
	'BrAPI requests refused with 401, by reason.',
	['reason']
);
export const tokenRateLimitHits = counter(
	'mira_token_rate_limit_hits_total',
	'BrAPI requests refused with 429 because an API token used up its per-minute budget.'
);

export const authRateLimitHits = counter(
	'mira_auth_rate_limit_hits_total',
	'Requests to /api/auth/* refused with 429 by the sign-in rate limiter (per client address and path).'
);
export const cspViolations = counter(
	'mira_csp_violations_total',
	'Content-Security-Policy violation reports browsers sent, by directive and whether the policy blocked (enforce) or only reported.',
	['directive', 'disposition']
);

// --- ARC access check (arc-access.ts) -----------------------------------------------------------
export const arcAccessOutcomes = counter(
	'mira_arc_access_total',
	'Answers of the ARC access check, from the cache or from PLANTdataHUB.',
	['outcome']
);
export const arcAccessCache = counter(
	'mira_arc_access_cache_total',
	'ARC access check lookups: hit (answered from memory), miss (asked PLANTdataHUB), shared (joined a call already running).',
	['result']
);
export const gitlabRequests = counter(
	'mira_gitlab_project_requests_total',
	'GET /projects/:id calls made by the ARC access check, by whose credentials and the answer.',
	['credentials', 'status_class']
);

// --- request_logs queue (db/request-logs.ts) ----------------------------------------------------
export const requestLogsFlushed = counter(
	'mira_request_logs_flushed_total',
	'request_logs rows written.'
);
export const requestLogsFlushFailures = counter(
	'mira_request_logs_flush_failures_total',
	'Failed batch inserts into request_logs (the batch is retried).'
);
export const requestLogsDropped = counter(
	'mira_request_logs_dropped_total',
	'request_logs rows dropped because the queue was full or at shutdown.'
);
export const requestLogsQueueLength = gauge(
	'mira_request_logs_queue_length',
	'request_logs rows waiting to be written.'
);

// --- Database and ETL queue (metrics-collectors.ts) ---------------------------------------------
export const dbPoolMax = gauge('mira_db_pool_max_connections', 'DB_POOL_MAX of this pod.');
export const dbPoolOpen = gauge(
	'mira_db_pool_open_connections',
	'Connections this pod holds open, from pg_stat_activity by application_name.'
);
export const dbPing = gauge(
	'mira_db_ping_seconds',
	'Time `select 1` took at scrape time, including the wait for a free pooled connection.'
);
export const etlJobsInState = gauge(
	'mira_etl_jobs',
	'Import jobs waiting or running, read from etl_job. Every web pod reports the same value: use max.',
	['state']
);
export const etlOldestQueued = gauge(
	'mira_etl_oldest_queued_age_seconds',
	'Age of the oldest queued job that is due to run (0: none). Every web pod reports the same value.'
);
export const etlJobsFinished = counter(
	'mira_etl_jobs_finished_total',
	'Import jobs that ended, by final state, read from etl_job. Every web pod reports the same value.',
	['state']
);
export const etlJobSeconds = counter(
	'mira_etl_job_seconds_total',
	'Sum of the running time of the jobs counted in mira_etl_jobs_finished_total.',
	['state']
);

// --- Process ------------------------------------------------------------------------------------
const processStart = gauge(
	'process_start_time_seconds',
	'Start time of the process since the unix epoch.'
);
processStart.set(Math.round(Date.now() / 1000 - process.uptime()));
const cpu = counter('process_cpu_seconds_total', 'User and system CPU time of the process.');
const rss = gauge('process_resident_memory_bytes', 'Resident memory of the process.');
const heap = gauge('nodejs_heap_used_bytes', 'V8 heap in use.');
registry.collect('process', () => {
	const usage = process.cpuUsage();
	cpu.set({}, (usage.user + usage.system) / 1e6);
	rss.set(process.memoryUsage.rss());
	heap.set(process.memoryUsage().heapUsed);
});
