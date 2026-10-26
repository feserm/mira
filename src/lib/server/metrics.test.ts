import { describe, expect, it } from 'vitest';
import { Counter, Gauge, Histogram, Registry, droppedSeries } from './metrics';

describe('registry text format', () => {
	it('renders HELP, TYPE and escaped labels for counters, gauges and histograms', async () => {
		const r = new Registry();
		const c = r.register(new Counter('t_total', 'A counter.', ['route']));
		const g = r.register(new Gauge('t_gauge', 'A gauge.'));
		const h = r.register(new Histogram('t_seconds', 'A histogram.', ['route'], [0.1, 1]));
		c.inc({ route: 'a"b\\c' }, 2);
		g.set(3);
		h.observe({ route: '/x' }, 0.05);
		h.observe({ route: '/x' }, 0.5);
		h.observe({ route: '/x' }, 5);

		const text = await r.render();
		expect(text).toContain('# HELP t_total A counter.\n# TYPE t_total counter\n');
		expect(text).toContain('t_total{route="a\\"b\\\\c"} 2');
		expect(text).toContain('t_gauge 3');
		expect(text).toContain('t_seconds_bucket{route="/x",le="0.1"} 1');
		expect(text).toContain('t_seconds_bucket{route="/x",le="1"} 2');
		expect(text).toContain('t_seconds_bucket{route="/x",le="+Inf"} 3');
		expect(text).toContain('t_seconds_sum{route="/x"} 5.55');
		expect(text).toContain('t_seconds_count{route="/x"} 3');
		expect(text.endsWith('\n')).toBe(true);
	});

	it('a collector that throws is counted and skipped, the scrape still works', async () => {
		const r = new Registry();
		r.collect('broken', () => {
			throw new Error('db down');
		});
		await expect(r.render()).resolves.toBeTypeOf('string');
	});
});

describe('series limit', () => {
	it('stops creating series at the limit and counts what it refused', () => {
		const c = new Counter('limit_total', 'x', ['id']);
		const before = droppedSeries.value();
		for (let i = 0; i < 1100; i++) c.inc({ id: String(i) });
		expect(c.lines()).toHaveLength(1000);
		expect(droppedSeries.value() - before).toBe(100);
		// an existing series still counts
		c.inc({ id: '0' });
		expect(c.value({ id: '0' })).toBe(2);
	});
});
