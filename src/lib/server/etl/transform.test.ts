import { describe, expect, it } from 'vitest';
import { getCrosswalk } from './transform';

describe('getCrosswalk', () => {
	it('loads a non-empty ISA <-> BrAPI crosswalk from the bundled sssom.tsv', () => {
		const entries = getCrosswalk();
		expect(entries.length).toBeGreaterThan(0);
		for (const e of entries) {
			expect(e.isaId).toMatch(/^isa_/);
			expect(e.brapiId).toMatch(/^brapi_/);
		}
	});
});
