/** Sample ARCs for tests, generated with the same library the app parses with (ARCtrl) and serialised
 *  as an RO-Crate. Everything here is invented: no real names, e-mail addresses or ORCIDs.
 *  See docs/testing.md for why fixtures are generated rather than committed as JSON. */
import {
	ARC,
	ArcInvestigation,
	ArcStudy,
	ArcTable,
	Comment,
	CompositeCell,
	CompositeHeader,
	IOType,
	OntologyAnnotation,
	Person,
	Publication
} from '@nfdi4plants/arctrl';

export interface PersonSpec {
	orcid?: string;
	firstName: string;
	lastName: string;
	email?: string;
	affiliation?: string;
	role?: string;
}

/** One row of the plant-growth-protocol table: a Source (the accession) grown into a Sample. */
export interface MaterialSpec {
	source: string;
	genus: string;
	species: string;
	sample: string;
	/** value of the "observation level" characteristic of the sample (default: plot) */
	observationLevel?: string;
}

export interface StudySpec {
	identifier: string;
	title: string;
	description?: string;
	/** ISA comments by name, e.g. 'Experimental site name' */
	comments?: Record<string, string>;
	contacts?: PersonSpec[];
	materials?: MaterialSpec[];
}

export interface ArcSpec {
	identifier: string;
	title?: string;
	description?: string;
	submissionDate?: string;
	publicReleaseDate?: string;
	comments?: Record<string, string>;
	publications?: { doi: string; authors: string; title: string }[];
	contacts: PersonSpec[];
	studies: StudySpec[];
}

// People. ORCID + e-mail, e-mail only, neither (identified by name + institute), no e-mail but ORCID.
export const ROE: PersonSpec = {
	orcid: '0000-0001-2345-6789',
	firstName: 'Rich',
	lastName: 'Roe',
	email: 'rich.roe@example.org',
	affiliation: 'Example Institute',
	role: 'Principal investigator'
};
export const POE: PersonSpec = {
	firstName: 'Pat',
	lastName: 'Poe',
	email: 'pat.poe@example.org',
	affiliation: 'Example Institute'
};
export const QUILL: PersonSpec = {
	firstName: 'Quinn',
	lastName: 'Quill',
	affiliation: 'Sample Station'
};
export const ORCID_ONLY: PersonSpec = {
	orcid: '0000-0002-0000-0001',
	firstName: 'Ona',
	lastName: 'Orc',
	affiliation: 'Example Institute'
};

export const GREENHOUSE_COMMENTS = {
	'Start date of study': '2024-03-01',
	'End date of study': '2024-05-30',
	'Cultural practices': 'Watered twice a week',
	'Observation unit level hierarchy': 'field > plot > plant',
	'Experimental site name': 'Site X',
	'Contact institution': 'Example Institute',
	'Geographic location (country)': 'Germany',
	'Geographic location (latitude)': '51.8',
	'Geographic location (longitude)': '11.3'
};

export function arcSpec(overrides: Partial<ArcSpec> = {}): ArcSpec {
	return {
		identifier: 'INV1',
		title: 'Drought trial',
		description: 'Barley and maize under drought',
		submissionDate: '2024-01-01',
		publicReleaseDate: '2024-06-01',
		comments: { License: 'CC-BY-4.0', 'MIAPPE version': '1.1' },
		publications: [{ doi: '10.1234/example', authors: 'Roe R, Poe P', title: 'A drought paper' }],
		contacts: [ROE, POE, QUILL],
		studies: [
			{
				identifier: 'S1',
				title: 'Greenhouse run',
				description: 'First study',
				comments: GREENHOUSE_COMMENTS,
				contacts: [ROE, ORCID_ONLY],
				materials: [
					{ source: 'Seed-A', genus: 'Zea', species: 'mays', sample: 'Plot-1' },
					{ source: 'Seed-B', genus: 'Hordeum', species: 'vulgare', sample: 'Plot-2' }
				]
			},
			{
				identifier: 'S2',
				title: 'Field run',
				// no comments, no materials: a study with only the mandatory fields
				contacts: [POE]
			}
		],
		...overrides
	};
}

function toComments(values: Record<string, string> | undefined) {
	return Object.entries(values ?? {}).map(([name, value]) => Comment.create(name, value));
}

function toPerson(p: PersonSpec) {
	return Person.create(
		p.orcid,
		p.lastName,
		p.firstName,
		undefined,
		p.email,
		undefined,
		undefined,
		undefined,
		p.affiliation,
		p.role ? [OntologyAnnotation.create(p.role)] : undefined
	);
}

const term = (name: string, ref: string, accession: string) =>
	OntologyAnnotation.create(name, ref, accession);

function growthTable(materials: MaterialSpec[]): ArcTable {
	const table = ArcTable.init('Plant growth');
	const col = <T>(f: (m: MaterialSpec) => T) => materials.map(f);
	table.AddColumn(
		CompositeHeader.input(IOType.source()),
		col((m) => CompositeCell.freeText(m.source))
	);
	table.AddColumn(
		CompositeHeader.protocolType(),
		col(() => CompositeCell.createTermFromString('plant growth protocol', 'DPBO', 'DPBO:1000164'))
	);
	table.AddColumn(
		CompositeHeader.characteristic(term('Genus', 'NCIT', 'NCIT:C45292')),
		col((m) => CompositeCell.createTermFromString(m.genus))
	);
	table.AddColumn(
		CompositeHeader.characteristic(term('Species', 'NCIT', 'NCIT:C45293')),
		col((m) => CompositeCell.createTermFromString(m.species))
	);
	table.AddColumn(
		CompositeHeader.characteristic(
			term('observation level', 'PPEO', 'ppeo:PPEO_observation_level')
		),
		col((m) => CompositeCell.createTermFromString(m.observationLevel ?? 'plot'))
	);
	table.AddColumn(
		CompositeHeader.output(IOType.sample()),
		col((m) => CompositeCell.freeText(m.sample))
	);
	return table;
}

export function buildArc(spec: ArcSpec): ARC {
	const studies = spec.studies.map((s) =>
		ArcStudy.create(
			s.identifier,
			s.title,
			s.description,
			undefined,
			undefined,
			[],
			(s.contacts ?? []).map(toPerson),
			[],
			s.materials?.length ? [growthTable(s.materials)] : [],
			undefined,
			[],
			toComments(s.comments)
		)
	);
	const investigation = ArcInvestigation.create(
		spec.identifier,
		spec.title,
		spec.description,
		spec.submissionDate,
		spec.publicReleaseDate,
		[],
		(spec.publications ?? []).map((p) => Publication.create(undefined, p.doi, p.authors, p.title)),
		spec.contacts.map(toPerson),
		[],
		studies,
		[],
		[],
		[],
		toComments(spec.comments)
	);
	return ARC.fromArcInvestigation(investigation);
}

/** The RO-Crate JSON-LD of an ARC, parsed as the Extract step stores it in `raw_ro_crate`. */
export function roCrate(spec: ArcSpec = arcSpec()): Record<string, unknown> {
	return JSON.parse(buildArc(spec).ToROCrateJsonString(0));
}
