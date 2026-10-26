import type {
	NewTrial,
	NewStudy,
	NewContact,
	NewLocation,
	ObservationLevel,
	ExperimentalDesign,
	GrowthFacility
} from '$lib/types/brapi/core';
import type { GeoJSON, GeoJSONPointGeometry } from '$lib/types/brapi/common';
import type {
	NewGermplasm,
	GermplasmOrigin,
	GermplasmMcpd,
	CollectingSite,
	StorageTypeCode
} from '$lib/types/brapi/germplasm';
import type { ExternalReference } from '$lib/types/brapi/common';
import type {
	NewObservationUnit,
	NewObservation,
	NewImage,
	NewBrapiEvent,
	NewObservationVariable,
	ObservationUnitPosition
} from '$lib/types/brapi/phenotyping';
import { ARC, type OntologyAnnotation, type CompositeColumn } from '@nfdi4plants/arctrl';
import sssomRaw from './sssom.tsv?raw';
import { logger } from '$lib/server/log';

/** A study-level contact, paired with the ARC identifier of the study it belongs to
 *  (studies aren't upserted yet at transform time, so they have no database id to link by). */
export interface StudyContactLink {
	studySourceId: string;
	contact: NewContact;
}

export interface StudyLocationLink {
	studySourceId: string;
	location: NewLocation;
}

/** An observation unit, paired with the ARC identifier of the study it belongs to (studies
 *  aren't upserted yet at transform time, so observationUnit.studyId can't be set directly). */
export interface StudyObservationUnitLink {
	studySourceId: string;
	observationUnit: NewObservationUnit;
}

/** An observation unit, paired with the (object-identity-shared, see result.germplasm) Germplasm
 *  row it was sampled from -- germplasm isn't upserted yet at transform time, so
 *  observationUnit.germplasmId can't be set directly (same WeakMap-by-reference pattern load.ts
 *  already uses for study.locationId via StudyLocationLink). */
export interface ObservationUnitGermplasmLink {
	observationUnit: NewObservationUnit;
	germplasm: NewGermplasm;
}

export interface TransformResult {
	trials: NewTrial[];
	studies: NewStudy[];
	contacts: NewContact[];
	studyContacts: StudyContactLink[];
	locations: NewLocation[];
	studyLocations: StudyLocationLink[];
	germplasm: NewGermplasm[];
	observationUnits: NewObservationUnit[];
	studyObservationUnits: StudyObservationUnitLink[];
	observationUnitGermplasm: ObservationUnitGermplasmLink[];
	observationVariables: NewObservationVariable[];
	observations: NewObservation[];
	images: NewImage[];
	events: NewBrapiEvent[];
}

/* ==========================================================================================
 * SSSOM-driven MIAPPE crosswalk engine
 *
 * The ISA<->BrAPI field mapping is not hardcoded: it's read from an SSSOM mapping set (see
 * sssom.tsv, generated from the MIAPPE LinkML schema's exact_mappings/close_mappings slot
 * metadata, per the LinkML/SSSOM implementation strategy doc). MIAPPE is the pivot -- an ISA
 * field and a BrAPI field are only ever related through sharing a MIAPPE subject, never mapped
 * onto each other directly. When BrAPI, ISA, or MIAPPE revise their models, only sssom.tsv needs
 * to be regenerated; this engine and the registries below it don't change.
 *
 * Registries below are keyed by the MIAPPE subject id (e.g. `investigation:license`), not by
 * the ISA/BrAPI object id. The complete MIAPPE investigation mapping reuses generic object ids
 * across multiple distinct fields -- both `investigation:license` and `investigation:miappeVersion`
 * closeMatch onto the same `isa_investigation:comment` object id (ISA has no dedicated slot for
 * either, both are just named Comments), and similarly onto BrAPI's catch-all
 * `brapi_trial:additionalInfo`. Keying by isaId/brapiId would collapse those distinct fields
 * onto one accessor/setter; the MIAPPE subject id is the only side of the triple guaranteed to
 * be unique per field.
 * ========================================================================================== */

interface SssomRow {
	subjectId: string;
	predicateId: string;
	objectId: string;
}

/** Minimal SSSOM TSV parser: skips the `#`-prefixed YAML metadata header and reads the rest by
 *  column name, so column order/extra columns (confidence, match_type, ...) don't matter here. */
function parseSssom(tsv: string): SssomRow[] {
	const lines = tsv.split('\n').filter((line) => line.trim().length > 0 && !line.startsWith('#'));
	const [headerLine, ...rowLines] = lines;
	const columns = headerLine.split('\t');
	const subjectIdx = columns.indexOf('subject_id');
	const predicateIdx = columns.indexOf('predicate_id');
	const objectIdx = columns.indexOf('object_id');
	if (subjectIdx === -1 || predicateIdx === -1 || objectIdx === -1) {
		throw new Error(
			'sssom.tsv is missing one of the required subject_id/predicate_id/object_id columns'
		);
	}
	return rowLines.map((line) => {
		const fields = line.split('\t');
		return {
			subjectId: fields[subjectIdx],
			predicateId: fields[predicateIdx],
			objectId: fields[objectIdx]
		};
	});
}

interface CrosswalkEntry {
	miappeId: string;
	isaId: string;
	brapiId: string;
}

/** Chains the MIAPPE-ISA and MIAPPE-BrAPI mapping rows on their shared MIAPPE subject into an
 *  effective ISA-BrAPI crosswalk, instead of requiring a hand-authored ISA-BrAPI table. Both
 *  exactMatch and closeMatch rows are chained the same way -- only fields whose *structure*
 *  differs between ISA and BrAPI (not just field naming) need to bypass this direct copy, via
 *  the named-function registries further down. */
function buildCrosswalk(rows: SssomRow[]): CrosswalkEntry[] {
	const isaBySubject = new Map<string, string>();
	const brapiBySubject = new Map<string, string>();

	for (const row of rows) {
		if (row.objectId.startsWith('isa_')) {
			isaBySubject.set(row.subjectId, row.objectId);
		} else if (row.objectId.startsWith('brapi_')) {
			brapiBySubject.set(row.subjectId, row.objectId);
		}
	}

	const entries: CrosswalkEntry[] = [];
	for (const [miappeId, isaId] of isaBySubject) {
		const brapiId = brapiBySubject.get(miappeId);
		if (brapiId) {
			entries.push({ miappeId, isaId, brapiId });
		}
	}
	return entries;
}

let cachedCrosswalk: CrosswalkEntry[] | undefined;

/** Parses sssom.tsv once per process. The file is the `gen-sssom` output described in the
 *  LinkML/SSSOM strategy doc, vendored here the same way the ISA/BrAPI schema snapshots are,
 *  and inlined into the bundle via Vite's `?raw` so it needs no `src/` on disk at runtime. */
export function getCrosswalk(): CrosswalkEntry[] {
	if (!cachedCrosswalk) {
		cachedCrosswalk = buildCrosswalk(parseSssom(sssomRaw));
	}
	return cachedCrosswalk;
}

const warnedUnresolvedIds = new Set<string>();

/** Applies every crosswalk entry whose ISA/BrAPI ids fall under the given namespace prefixes
 *  (e.g. `isa_investigation:` / `brapi_trial:`), reading the value off `source` via the accessor
 *  registered for that entry's MIAPPE subject id and writing it onto `target` via the matching
 *  setter. The prefixes only scope *which* entries this call is responsible for (so an
 *  investigation-level call doesn't try to resolve a publication-level entry); the accessor/
 *  setter lookup itself is keyed by miappeId (see comment above on why). A crosswalk entry that
 *  sssom.tsv declares but that has no registered accessor or setter yet is skipped with a
 *  one-time warning rather than failing the whole transform -- the mapping table and this
 *  registry are allowed to evolve independently of each other.
 *
 *  `miappePrefix` is an optional extra scope, needed only where two calls share the same
 *  isaPrefix/brapiPrefix pair but read from different ISA sources into different accessor maps
 *  (biological_material vs material_source both feed brapi_germplasm: -- see the germplasm block
 *  in transformRoCrate). Without it, each such call would also see the *other* call's entries,
 *  fail to resolve them against its own accessor map, and emit a spurious "not registered"
 *  warning for a field that the sibling call already handles correctly. */
function applyMiappeCrosswalk<Source, Target>(
	source: Source,
	target: Target,
	isaPrefix: string,
	brapiPrefix: string,
	accessors: Map<string, (source: Source) => unknown>,
	setters: Map<string, (target: Target, value: unknown) => void>,
	miappePrefix?: string
): void {
	for (const { miappeId, isaId, brapiId } of getCrosswalk()) {
		if (!isaId.startsWith(isaPrefix) || !brapiId.startsWith(brapiPrefix)) continue;
		if (miappePrefix && !miappeId.startsWith(miappePrefix)) continue;

		const accessor = accessors.get(miappeId);
		const setter = setters.get(miappeId);
		if (!accessor || !setter) {
			if (!warnedUnresolvedIds.has(miappeId)) {
				warnedUnresolvedIds.add(miappeId);
				logger.warn(
					`[transformRoCrate] sssom.tsv maps ${miappeId} (${isaId} -> ${brapiId}) but no ${
						accessor ? 'BrAPI setter' : 'ISA accessor'
					} is registered for it yet; skipping.`
				);
			}
			continue;
		}

		const value = accessor(source);
		if (value !== undefined && value !== null && value !== '') {
			setter(target, value);
		}
	}
}

/* ------------------------------------------------------------------------------------------
 * Investigation (MIAPPE) <-> ISA Investigation / BrAPI Trial registries
 *
 * This is the "direct-copy" side of the engine: the sssom.tsv rows whose value needs no
 * reshaping beyond being read off one object and written onto the other. Fields needing real
 * transformation (string formatting, cardinality changes, ...) stay outside this registry and
 * are handled as named functions below instead, per Route A of the LinkML/SSSOM strategy doc.
 * ---------------------------------------------------------------------------------------- */

type IsaInvestigation = ReturnType<typeof ARC.fromROCrateJsonString>;
type IsaPerson = IsaInvestigation['Contacts'][number];

const ISA_INVESTIGATION_ACCESSORS = new Map<string, (investigation: IsaInvestigation) => unknown>([
	['investigation:investigationId', (investigation) => investigation.Identifier],
	['investigation:investigationTitle', (investigation) => investigation.Title],
	['investigation:investigationDescription', (investigation) => investigation.Description],
	['investigation:submissionDate', (investigation) => investigation.SubmissionDate],
	['investigation:publicReleaseDate', (investigation) => investigation.PublicReleaseDate],
	// License closeMatches onto the generic isa_investigation:comment object id (ISA has no
	// dedicated license slot on Investigation), but ARCtrl also exposes license as a structured
	// License object (Type/Content/Path) when the source RO-Crate's root Dataset carries a
	// resolvable schema:license CreativeWork -- .Content holds the actual license text/URL, so
	// that's tried first. ARCs that instead express license via a top-level Comment[License]
	// (same lookup-by-name pattern miappeVersion below and the study-level fields further down
	// use) fall through to that as a second source.
	[
		'investigation:license',
		(investigation) =>
			investigation.License?.Content ??
			investigation.Comments.find((comment) => comment.Name === 'License')?.Value
	],
	// Also closeMatches onto isa_investigation:comment -- MIAPPE version has no dedicated ISA
	// slot either, so like license it's read off a named top-level Comment.
	[
		'investigation:miappeVersion',
		(investigation) =>
			investigation.Comments.find((comment) => comment.Name === 'MIAPPE version')?.Value
	]
]);

const BRAPI_TRIAL_SETTERS = new Map<string, (trial: Partial<NewTrial>, value: unknown) => void>([
	[
		'investigation:investigationId',
		(trial, value) => {
			trial.sourceId = value as string;
		}
	],
	[
		'investigation:investigationTitle',
		(trial, value) => {
			trial.name = value as string;
		}
	],
	[
		'investigation:investigationDescription',
		(trial, value) => {
			trial.description = value as string;
		}
	],
	[
		'investigation:license',
		(trial, value) => {
			ensureDatasetAuthorship(trial).license = value as string;
		}
	],
	[
		'investigation:submissionDate',
		(trial, value) => {
			ensureDatasetAuthorship(trial).submissionDate = value as string;
		}
	],
	[
		'investigation:publicReleaseDate',
		(trial, value) => {
			ensureDatasetAuthorship(trial).publicReleaseDate = value as string;
		}
	],
	// closeMatches onto BrAPI's catch-all brapi_trial:additionalInfo -- BrAPI Trial has no
	// dedicated MIAPPE-version field, so it's folded into the additionalInfo bag under its own
	// key rather than overwriting whatever else additionalInfo may hold.
	[
		'investigation:miappeVersion',
		(trial, value) => {
			trial.additionalInfo = {
				...(trial.additionalInfo as Record<string, unknown> | undefined),
				miappeVersion: value as string
			} as NewTrial['additionalInfo'];
		}
	]
]);

type DatasetAuthorship = NonNullable<NewTrial['datasetAuthorships']>[number];

function ensureDatasetAuthorship(trial: Partial<NewTrial>): DatasetAuthorship {
	const existing = trial.datasetAuthorships as DatasetAuthorship[] | undefined;
	if (existing && existing.length > 0) {
		return existing[0];
	}
	const created: DatasetAuthorship[] = [{}];
	trial.datasetAuthorships = created as NewTrial['datasetAuthorships'];
	return created[0];
}

/* ------------------------------------------------------------------------------------------
 * Investigation (MIAPPE) <-> ISA Publication / BrAPI Trial.publications registries
 *
 * associatedPublication is the one investigation-level MIAPPE field whose ISA/BrAPI sides live
 * one level down (on a Publication, not the Investigation/Trial itself), so it can't share the
 * accessor/setter maps above -- it's applied once per investigation.Publications entry instead,
 * against its own publication-shaped source/target pair. See transformRoCrate below.
 * ---------------------------------------------------------------------------------------- */

type IsaPublication = IsaInvestigation['Publications'][number];
type TrialPublication = NonNullable<NewTrial['publications']>[number];

const ISA_PUBLICATION_ACCESSORS = new Map<string, (publication: IsaPublication) => unknown>([
	['investigation:associatedPublication', (publication) => publication.DOI]
]);

const BRAPI_PUBLICATION_SETTERS = new Map<
	string,
	(publication: Partial<TrialPublication>, value: unknown) => void
>([
	[
		'investigation:associatedPublication',
		(publication, value) => {
			publication.publicationPUI = value as string;
		}
	]
]);

/**
 * Formats "Authors. Title." per Vancouver citation style. ARC's Publication model doesn't
 * capture journal/year/volume, so author list and title are all that's available to cite.
 * Not in sssom.tsv: this is a reshaping transform (string formatting), not an exact/close
 * field copy, so it's handled directly here rather than through the crosswalk registries.
 */
function formatVancouverCitation(authors?: string, title?: string): string | undefined {
	let formattedAuthors = authors?.trim();
	if (formattedAuthors) {
		const authorList = formattedAuthors
			.split(',')
			.map((a) => a.trim())
			.filter(Boolean);
		if (authorList.length > 6) {
			formattedAuthors = `${authorList.slice(0, 6).join(', ')}, et al`;
		}
	}
	const parts = [formattedAuthors, title]
		.map((part) => part?.trim().replace(/\.+$/, ''))
		.filter((part): part is string => !!part);
	return parts.length > 0 ? `${parts.join('. ')}.` : undefined;
}

/** Not in sssom.tsv yet (no MIAPPE Person/Role crosswalk rows), so contacts are still built by
 *  reading the ISA Person shape directly, same as before -- factored out only to avoid
 *  duplicating it between investigation- and study-level contacts. */
function toBrapiContact(person: IsaPerson): NewContact {
	return {
		name: [person.FirstName, person.MidInitials, person.LastName].filter(Boolean).join(' '),
		email: person.EMail,
		orcid: person.ORCID,
		type:
			person.Roles.map((role) => role.NameText)
				.filter(Boolean)
				.join(', ') || undefined,
		instituteName: person.Affiliation
	};
}

/* ------------------------------------------------------------------------------------------
 * Study (MIAPPE) <-> ISA Study / BrAPI Study & Location registries
 *
 * Same engine, one level down: a MIAPPE study-level field can closeMatch onto a BrAPI Study
 * field (`brapi_study:`) or a BrAPI Location field (`brapi_location:`) -- MIAPPE has no separate
 * "Location" entity, so its site/geography fields (contact institution, site name, lat/long/alt,
 * country) land on Location instead of Study. Both targets share the same ISA source (the study
 * itself), so one accessor map (`ISA_STUDY_ACCESSORS`) feeds two setter maps applied via two
 * separate applyMiappeCrosswalk calls, scoped by `brapiPrefix` alone. The isaPrefix passed to
 * both calls is the loose `isa_` (rather than `isa_study:`) because study:expeDesignDesc is the
 * one outlier whose ISA side lives on the study's first StudyDesignDescriptors annotation
 * (`isa_ontology_annotation:comments`), not the study itself -- brapiPrefix alone already
 * disambiguates which entries belong to which target, so the loose isaPrefix costs nothing.
 *
 * study:expeDesignMap (MIAPPE "Map of experimental design") has no BrAPI-side row in sssom.tsv
 * at all, so buildCrosswalk never produces an entry for it and it's intentionally absent from
 * both registries below -- there's nowhere on BrAPI's Study/Location to put it yet.
 * ---------------------------------------------------------------------------------------- */

type IsaStudy = IsaInvestigation['Studies'][number];
type IsaComment = IsaInvestigation['Comments'][number];

function findComment(comments: IsaComment[], name: string): string | undefined {
	return comments.find((comment) => comment.Name === name)?.Value;
}

// Comment names below are the literal MIAPPE V1.1 DM-* checklist labels (confirmed against the
// BrAPI v2.1 spec's own field descriptions, which quote them verbatim, e.g. GrowthFacility.PUI/
// description cite "MIAPPE V1.1 (DM-26/27)"), matching the naming convention already used by the
// pre-existing 'Cultural practices'/'Description of growth facility'/'End date of study' lookups.
// The one unconfirmed set is locationLatitude/Longitude/Altitude: the BrAPI spec documents
// Location.coordinates as a single GeoJSON field with no per-axis MIAPPE label, so
// "Geographic location (latitude/longitude/altitude)" is inferred by extending the confirmed
// "Geographic location (country)" (DM-17) pattern rather than read off spec text directly.
const ISA_STUDY_ACCESSORS = new Map<string, (study: IsaStudy) => unknown>([
	['study:studyId', (study) => study.Identifier],
	['study:studyTitle', (study) => study.Title],
	['study:studyDescription', (study) => study.Description],
	['study:studyStartDate', (study) => findComment(study.Comments, 'Start date of study')],
	['study:studyEndDate', (study) => findComment(study.Comments, 'End date of study')],
	['study:culturalPractices', (study) => findComment(study.Comments, 'Cultural practices')],
	['study:obsUnitDesc', (study) => findComment(study.Comments, 'Observation unit description')],
	[
		'study:obsUnitLevelHierarchy',
		(study) => findComment(study.Comments, 'Observation unit level hierarchy')
	],
	[
		'study:growthFacilityDesc',
		(study) => findComment(study.Comments, 'Description of growth facility')
	],
	['study:growthFacilityType', (study) => findComment(study.Comments, 'Type of growth facility')],
	[
		'study:expeDesignDesc',
		(study) =>
			study.StudyDesignDescriptors[0]?.Comments.find(
				(comment) => comment.Name === 'Description of the experimental design'
			)?.Value
	],
	['study:expeDesignType', (study) => study.StudyDesignDescriptors[0]?.TermAccessionNumber],
	['study:contactInst', (study) => findComment(study.Comments, 'Contact institution')],
	['study:siteName', (study) => findComment(study.Comments, 'Experimental site name')],
	[
		'study:locationCountry',
		(study) => findComment(study.Comments, 'Geographic location (country)')
	],
	[
		'study:locationLatitude',
		(study) => findComment(study.Comments, 'Geographic location (latitude)')
	],
	[
		'study:locationLongitude',
		(study) => findComment(study.Comments, 'Geographic location (longitude)')
	],
	[
		'study:locationAltitude',
		(study) => findComment(study.Comments, 'Geographic location (altitude)')
	]
]);

function ensureGrowthFacility(study: Partial<NewStudy>): GrowthFacility {
	const existing = study.growthFacility as GrowthFacility | undefined;
	if (existing) return existing;
	const created: GrowthFacility = {};
	study.growthFacility = created as NewStudy['growthFacility'];
	return created;
}

function ensureExperimentalDesign(study: Partial<NewStudy>): ExperimentalDesign {
	const existing = study.experimentalDesign as ExperimentalDesign | undefined;
	if (existing) return existing;
	const created: ExperimentalDesign = {};
	study.experimentalDesign = created as NewStudy['experimentalDesign'];
	return created;
}

/** Splits a delimited hierarchy string (e.g. "field > plot > plant") into BrAPI's
 *  ObservationLevel[] shape, assigning levelOrder by position -- MIAPPE stores this as one
 *  free-text field (DM-24) while BrAPI needs the cardinality/type change into a leveled array. */
function parseObservationLevelHierarchy(value: string): ObservationLevel[] {
	return value
		.split('>')
		.map((level) => level.trim())
		.filter(Boolean)
		.map((levelName, index) => ({ levelName, levelOrder: index }));
}

const BRAPI_STUDY_SETTERS = new Map<string, (study: Partial<NewStudy>, value: unknown) => void>([
	[
		'study:studyId',
		(study, value) => {
			study.sourceId = value as string;
		}
	],
	[
		'study:studyTitle',
		(study, value) => {
			study.name = value as string;
		}
	],
	[
		'study:studyDescription',
		(study, value) => {
			study.description = value as string;
		}
	],
	[
		'study:studyStartDate',
		(study, value) => {
			study.startDate = value as string;
		}
	],
	[
		'study:studyEndDate',
		(study, value) => {
			study.endDate = value as string;
		}
	],
	[
		'study:culturalPractices',
		(study, value) => {
			study.culturalPractices = value as string;
		}
	],
	[
		'study:obsUnitDesc',
		(study, value) => {
			study.observationUnitsDescription = value as string;
		}
	],
	[
		'study:obsUnitLevelHierarchy',
		(study, value) => {
			study.observationLevels = parseObservationLevelHierarchy(value as string);
		}
	],
	[
		'study:growthFacilityDesc',
		(study, value) => {
			ensureGrowthFacility(study).description = value as string;
		}
	],
	[
		'study:growthFacilityType',
		(study, value) => {
			ensureGrowthFacility(study).PUI = value as string;
		}
	],
	[
		'study:expeDesignDesc',
		(study, value) => {
			ensureExperimentalDesign(study).description = value as string;
		}
	],
	[
		'study:expeDesignType',
		(study, value) => {
			ensureExperimentalDesign(study).PUI = value as string;
		}
	]
]);

/** Lazily creates a Point-geometry GeoJSON Feature the first time any of the three lat/long/alt
 *  setters fires, matching the RFC 7946 `[longitude, latitude, altitude?]` position order. Takes
 *  a structural `{ coordinates }` type rather than `Partial<NewLocation>` so it can be reused for
 *  `GermplasmOrigin.coordinates` below without duplicating this logic a second time. */
function ensureGeoJsonPoint(holder: { coordinates?: GeoJSON | null }): GeoJSONPointGeometry {
	if (holder.coordinates?.geometry?.type === 'Point') {
		return holder.coordinates.geometry;
	}
	const geometry: GeoJSONPointGeometry = { type: 'Point', coordinates: [] };
	holder.coordinates = { type: 'Feature', geometry };
	return geometry;
}

const BRAPI_LOCATION_SETTERS = new Map<
	string,
	(location: Partial<NewLocation>, value: unknown) => void
>([
	[
		'study:contactInst',
		(location, value) => {
			location.instituteName = value as string;
		}
	],
	[
		'study:locationCountry',
		(location, value) => {
			location.countryName = value as string;
		}
	],
	[
		'study:siteName',
		(location, value) => {
			location.name = value as string;
		}
	],
	[
		'study:locationLatitude',
		(location, value) => {
			ensureGeoJsonPoint(location).coordinates[1] = Number(value);
		}
	],
	[
		'study:locationLongitude',
		(location, value) => {
			ensureGeoJsonPoint(location).coordinates[0] = Number(value);
		}
	],
	[
		'study:locationAltitude',
		(location, value) => {
			ensureGeoJsonPoint(location).coordinates[2] = Number(value);
		}
	]
]);

/* ------------------------------------------------------------------------------------------
 * BiologicalMaterial (MIAPPE) <-> ISA process graph / BrAPI Germplasm registries
 *
 * Unlike every other subject above, ISA has no dedicated node for "biological material" — per
 * biological_material.yaml's `special_case_isa: process_graph_traversal` annotation on the
 * BiologicalMaterial class, it must be located by finding the ArcTable row whose ProtocolType
 * term accession identifies the "plant growth protocol" (DPBO:1000164) and taking that row's
 * Input. Its `biologicalMaterialId` (-> germplasmName) is deliberately *not* that Input's own
 * name, though: it's the name of the originating ISA Source, reached by walking backward through
 * the study's process graph (Output name -> the row that produced it, by matching Input name)
 * until a row whose Input IOType is actually Source is found — see the long comment on
 * biological_material_id in biological_material.yaml for why (ISA process-graph nodes need a
 * unique name per node, so only the Source carries the real accession/seed-lot identity).
 * ---------------------------------------------------------------------------------------- */

type IsaArcTable = IsaStudy['Tables'][number];

/** ARCtrl's `TryXxx()` accessors are typed `Option<T> = T | Some<T> | undefined`, but Fable only
 *  ever produces an actual `Some` wrapper when T could itself be `undefined`/`null` -- never the
 *  case for the CompositeColumn/OntologyAnnotation/IOType values unwrapped here, so at runtime
 *  these always come back as a plain T or `undefined`. Asserting that shape directly avoids a
 *  hard dependency on `@fable-org/fable-library-ts`, which is only a transitive dependency (via
 *  arctrl) and isn't resolvable from this package's own imports. */
function unwrapOption<T>(value: unknown): T | undefined {
	return value as T | undefined;
}

/** Case-insensitively matches a term against its canonical accession, falling back to comparing
 *  the human-readable name whenever the accession doesn't match — whether the source data left
 *  the term accession blank, or filled it in with a real ontology accession that simply isn't the
 *  one we're looking for (a real ARC has no reason to use our placeholder curie, see the `bco:`
 *  constants below) — matching the same accession-with-name-fallback lookup already implied by
 *  ISA_STUDY_ACCESSORS's growthFacilityType comment-name lookups. */
function matchesTerm(
	term: OntologyAnnotation | undefined,
	accession: string,
	nameFallback: string
): boolean {
	if (!term) return false;
	if (term.TermAccessionShort?.toLowerCase() === accession.toLowerCase()) return true;
	return term.NameText.toLowerCase() === nameFallback.toLowerCase();
}

// Accession constants from biological_material.yaml's special_case_note text, each paired with
// the human-readable term name to fall back on when a source ARC left the accession blank.
const PLANT_GROWTH_PROTOCOL_ACCESSION = 'DPBO:1000164';
const PLANT_GROWTH_PROTOCOL_NAME = 'plant growth protocol';
const GENUS_ACCESSION = 'NCIT:C45292';
const GENUS_NAME = 'Genus';
const SPECIES_ACCESSION = 'NCIT:C45293';
const SPECIES_NAME = 'Species';
const INFRASPECIFIC_EPITHET_ACCESSION = 'bco:infraspecificEpithet';
const INFRASPECIFIC_EPITHET_NAME = 'Infraspecific Epithet';
const LATITUDE_ACCESSION = 'SIO:000319';
const LATITUDE_NAME = 'Latitude';
const LONGITUDE_ACCESSION = 'SIO:000318';
const LONGITUDE_NAME = 'Longitude';
const ALTITUDE_ACCESSION = 'C:316';
const ALTITUDE_NAME = 'Altitude';
const COORD_UNCERTAINTY_ACCESSION = 'bco:coordinateUncertaintyInMeters';
const COORD_UNCERTAINTY_NAME = 'Coordinate Uncertainty in Meters';
const EXTERNAL_REFERENCE_ID_ACCESSION = 'MS:1000878';
const EXTERNAL_REFERENCE_ID_NAME = 'external reference identifier';

/** ARCtrl's IOType union: Source = 0, Sample = 1, Data = 2, Material = 3 (see `IOType` in
 *  `@nfdi4plants/arctrl`'s CompositeHeader module). Declared here, ahead of SAMPLE_IO_TYPE_TAG
 *  further down, since collectProcessLinks/resolveBiologicalMaterials need it first to identify
 *  the true originating Source while walking the process graph. */
const SOURCE_IO_TYPE_TAG = 0;

interface ProcessLink {
	inputName: string;
	inputIsSource: boolean;
	outputName: string;
}

/** Real ARCs are hand-authored per study/year and aren't always internally consistent about
 *  whether "_" or "-" separates the name segments of a generated node name (e.g. a growth
 *  table's input referencing "B73-2017-acclimated" while the acclimatisation table that
 *  produced it is named "B73_2017_acclimated") -- collapsing both to the same separator before
 *  comparing lets resolveSourceName's backward walk still find the producing row. */
function normalizeLinkName(name: string): string {
	return name.replace(/[-_]/g, '_');
}

/** One entry per row of every ArcTable in the study that has both an Input and Output column —
 *  the edges of the study's ISA process graph, keyed for backward traversal from an Output name
 *  to the row that produced it (see resolveSourceName). */
function collectProcessLinks(study: IsaStudy): ProcessLink[] {
	const links: ProcessLink[] = [];
	for (const table of study.Tables) {
		const inputColumn = unwrapOption<CompositeColumn>(table.TryGetInputColumn());
		const outputColumn = unwrapOption<CompositeColumn>(table.TryGetOutputColumn());
		if (!inputColumn || !outputColumn) continue;
		const inputIoType = unwrapOption<{ tag: number }>(inputColumn.Header.TryIOType());
		const inputIsSource = inputIoType?.tag === SOURCE_IO_TYPE_TAG;
		for (let row = 0; row < table.RowCount; row++) {
			const inputName = inputColumn.Cells[row]?.GetContent()[0];
			const outputName = outputColumn.Cells[row]?.GetContent()[0];
			if (!inputName || !outputName) continue;
			links.push({ inputName, inputIsSource, outputName });
		}
	}
	return links;
}

const warnedUnresolvedSourceNames = new Set<string>();

/** Walks `collectProcessLinks` backward from `name` until it finds a link whose input is
 *  actually a Source (the true origin), a dead end (no row produced this name — return the last
 *  name seen), or a depth cap is hit (malformed/cyclic process graph). */
function resolveSourceName(links: ProcessLink[], materialName: string): string {
	let current = materialName;
	for (let depth = 0; depth < 25; depth++) {
		const normalizedCurrent = normalizeLinkName(current);
		const producingLink = links.find(
			(link) => normalizeLinkName(link.outputName) === normalizedCurrent
		);
		if (!producingLink) return current;
		if (producingLink.inputIsSource) return producingLink.inputName;
		current = producingLink.inputName;
	}
	if (!warnedUnresolvedSourceNames.has(materialName)) {
		warnedUnresolvedSourceNames.add(materialName);
		logger.warn(
			`[transformRoCrate] could not resolve a Source for material "${materialName}" within 25 process-graph hops; using its own name.`
		);
	}
	return current;
}

interface BiologicalMaterialRow {
	sourceId: string;
	getCharacteristic(accession: string, nameFallback: string): string | undefined;
	getCharacteristics(accession: string, nameFallback: string): string[];
}

function characteristicsMatching(
	table: IsaArcTable,
	row: number,
	accession: string,
	nameFallback: string
): string[] {
	const values: string[] = [];
	for (const column of table.Columns) {
		if (!column.Header.isCharacteristic) continue;
		const term = unwrapOption<OntologyAnnotation>(column.Header.TryGetTerm());
		if (!matchesTerm(term, accession, nameFallback)) continue;
		const value = column.Cells[row]?.GetContent()[0];
		if (value) values.push(value);
	}
	return values;
}

/** Finds every ArcTable in the study whose ProtocolType matches the "plant growth protocol"
 *  accession (falling back to case-insensitive name), and returns one BiologicalMaterialRow per
 *  row of those tables — see biological_material.yaml's `special_case_isa:
 *  process_graph_traversal` annotation on BiologicalMaterial for why this indirection is
 *  necessary (ISA has no dedicated node for the biological material itself). */
function resolveBiologicalMaterials(study: IsaStudy): BiologicalMaterialRow[] {
	const links = collectProcessLinks(study);
	const materials: BiologicalMaterialRow[] = [];

	for (const table of study.Tables) {
		const inputColumn = unwrapOption<CompositeColumn>(table.TryGetInputColumn());
		if (!inputColumn) continue;
		const protocolTypeColumnIndex = table.Columns.findIndex(
			(column) => column.Header.isProtocolType
		);
		if (protocolTypeColumnIndex === -1) continue;
		const protocolTypeColumn = table.Columns[protocolTypeColumnIndex];

		for (let row = 0; row < table.RowCount; row++) {
			const protocolTypeCell = protocolTypeColumn.Cells[row];
			const protocolType = protocolTypeCell?.isTerm ? protocolTypeCell.AsTerm : undefined;
			if (!matchesTerm(protocolType, PLANT_GROWTH_PROTOCOL_ACCESSION, PLANT_GROWTH_PROTOCOL_NAME)) {
				continue;
			}

			const materialName = inputColumn.Cells[row]?.GetContent()[0];
			if (!materialName) continue;
			const inputIoType = unwrapOption<{ tag: number }>(inputColumn.Header.TryIOType());
			const inputIsSource = inputIoType?.tag === SOURCE_IO_TYPE_TAG;
			const sourceId = inputIsSource ? materialName : resolveSourceName(links, materialName);

			materials.push({
				sourceId,
				getCharacteristic: (accession, nameFallback) =>
					characteristicsMatching(table, row, accession, nameFallback)[0],
				getCharacteristics: (accession, nameFallback) =>
					characteristicsMatching(table, row, accession, nameFallback)
			});
		}
	}
	return materials;
}

const ISA_MATERIAL_ACCESSORS = new Map<string, (material: BiologicalMaterialRow) => unknown>([
	['biological_material:biologicalMaterialId', (material) => material.sourceId],
	[
		'biological_material:genus',
		(material) => material.getCharacteristic(GENUS_ACCESSION, GENUS_NAME)
	],
	[
		'biological_material:species',
		(material) => material.getCharacteristic(SPECIES_ACCESSION, SPECIES_NAME)
	],
	[
		'biological_material:infraspecificName',
		(material) =>
			material.getCharacteristic(INFRASPECIFIC_EPITHET_ACCESSION, INFRASPECIFIC_EPITHET_NAME)
	],
	[
		'biological_material:biologicalMaterialLatitude',
		(material) => material.getCharacteristic(LATITUDE_ACCESSION, LATITUDE_NAME)
	],
	[
		'biological_material:biologicalMaterialLongitude',
		(material) => material.getCharacteristic(LONGITUDE_ACCESSION, LONGITUDE_NAME)
	],
	[
		'biological_material:biologicalMaterialAltitude',
		(material) => material.getCharacteristic(ALTITUDE_ACCESSION, ALTITUDE_NAME)
	],
	[
		'biological_material:biologicalMaterialCoordUncertainty',
		(material) => material.getCharacteristic(COORD_UNCERTAINTY_ACCESSION, COORD_UNCERTAINTY_NAME)
	],
	[
		'biological_material:biologicalMaterialExtId',
		(material) =>
			material.getCharacteristics(EXTERNAL_REFERENCE_ID_ACCESSION, EXTERNAL_REFERENCE_ID_NAME)
	]
]);

/** Lazily creates the first (and, for how this ETL populates it, only) GermplasmOrigin entry —
 *  germplasmOrigin is a jsonb array column, same "lazy first element" shape as
 *  ensureDatasetAuthorship/ensureGrowthFacility above. */
function ensureGermplasmOrigin(germplasm: Partial<NewGermplasm>): GermplasmOrigin {
	const existing = germplasm.germplasmOrigin as GermplasmOrigin[] | undefined;
	if (existing && existing.length > 0) {
		return existing[0];
	}
	const created: GermplasmOrigin[] = [{}];
	germplasm.germplasmOrigin = created as NewGermplasm['germplasmOrigin'];
	return created[0];
}

const BRAPI_GERMPLASM_SETTERS = new Map<
	string,
	(germplasm: Partial<NewGermplasm>, value: unknown) => void
>([
	[
		'biological_material:biologicalMaterialId',
		(germplasm, value) => {
			germplasm.germplasmName = value as string;
		}
	],
	[
		'biological_material:genus',
		(germplasm, value) => {
			germplasm.genus = value as string;
		}
	],
	[
		'biological_material:species',
		(germplasm, value) => {
			germplasm.species = value as string;
		}
	],
	[
		'biological_material:infraspecificName',
		(germplasm, value) => {
			germplasm.subtaxa = value as string;
		}
	],
	[
		'biological_material:biologicalMaterialLatitude',
		(germplasm, value) => {
			ensureGeoJsonPoint(ensureGermplasmOrigin(germplasm)).coordinates[1] = Number(value);
		}
	],
	[
		'biological_material:biologicalMaterialLongitude',
		(germplasm, value) => {
			ensureGeoJsonPoint(ensureGermplasmOrigin(germplasm)).coordinates[0] = Number(value);
		}
	],
	[
		'biological_material:biologicalMaterialAltitude',
		(germplasm, value) => {
			ensureGeoJsonPoint(ensureGermplasmOrigin(germplasm)).coordinates[2] = Number(value);
		}
	],
	[
		'biological_material:biologicalMaterialCoordUncertainty',
		(germplasm, value) => {
			ensureGermplasmOrigin(germplasm).coordinateUncertainty = value as string;
		}
	],
	[
		'biological_material:biologicalMaterialExtId',
		(germplasm, value) => {
			const referenceIds = value as string[];
			const existing = (germplasm.externalReferences as ExternalReference[] | undefined) ?? [];
			germplasm.externalReferences = [
				...existing,
				...referenceIds.map((referenceId) => ({ referenceId }))
			] as NewGermplasm['externalReferences'];
		}
	]
]);

/* ------------------------------------------------------------------------------------------
 * MaterialSource (MIAPPE) <-> ISA Source / BrAPI Germplasm & Germplasm.mcpd registries
 *
 * Unlike BiologicalMaterial, MaterialSource's ISA side has a dedicated node -- `isa_source:Source`
 * (see sssom.tsv's material_source:MaterialSource class-level row) -- so no process-graph
 * traversal is needed here, just every ArcTable row across the study where an Input or Output
 * column is IOType.Source, deduped by name (the same "dedicated node" shape as ObservationUnit's
 * isa_sample:Sample, just one IOType tag over). Its sourceId is always the same Source name
 * resolveBiologicalMaterials already resolved via process-graph traversal for its own
 * biological_material:* fields (a Source is a process-graph leaf -- nothing produces it, so the
 * name found here and the name found there necessarily agree), which is how transformRoCrate
 * below merges this row's fields onto the very same germplasmDraft object.
 *
 * material_source:MaterialSource's isa_source:Source/brapi_germplasm:Germplasm pairing maps onto
 * two distinct BrAPI namespaces that applyMiappeCrosswalk's prefix filter already separates
 * without any engine change: `brapi_germplasm:` (fields that live directly on Germplasm --
 * instituteCode, accessionNumber, instituteName, germplasmPUI) and `brapi_germplasm_mcpd:`
 * (fields that live in Germplasm's nested `mcpd` MCPD block instead -- accessionNames, remarks,
 * alternateIDs, and the collectingInfo.collectingSite geo fields). Both share the one accessor
 * map below, keyed by MIAPPE subject id per the engine's convention, and are applied via two
 * separate applyMiappeCrosswalk calls against the same germplasmDraft in transformRoCrate --
 * mirroring how ISA_STUDY_ACCESSORS above feeds both BRAPI_STUDY_SETTERS and
 * BRAPI_LOCATION_SETTERS from one accessor map.
 *
 * material_source:materialSourceId (-> isa_source:name only, no brapi_ row) is intentionally
 * absent from the accessor map below, same as biological_material:biologicalMaterialPreprocessing
 * and study:expeDesignMap further up -- buildCrosswalk never produces a crosswalk entry for a
 * subject with no BrAPI-side row, so there's nothing to resolve. The class-level
 * material_source:MaterialSource row *does* pair an isa_ and a brapi_germplasm: id, though, so it
 * does produce an entry -- registered below as an explicit no-op (it carries no field data of its
 * own to move) purely to suppress the "no accessor registered" warning that would otherwise fire.
 *
 * No material_source.yaml exists in this repo to source accession numbers from (unlike
 * biological_material.yaml above, itself likewise absent but at least pinned down by prior
 * context). The geo fields (altitude/coordUncertainty/latitude/longitude) reuse the exact same
 * accession/name-fallback constants already declared above for BiologicalMaterial's identical geo
 * characteristics -- a real ARC has no reason to use a different ontology term for "Latitude"
 * depending on which node it's attached to. The remaining passport-style fields (accession
 * name/number, institute code/name, DOI, other ids, source description) have no equivalent
 * already in scope, so they get new bco:-style slug accessions, following the same made-up-curie
 * convention already used above for INFRASPECIFIC_EPITHET_ACCESSION/
 * COORD_UNCERTAINTY_ACCESSION. matchesTerm's name-fallback means a real ARC using a different (or
 * no) accession curie for these still matches correctly off the human-readable term name.
 * ---------------------------------------------------------------------------------------- */

const ACCESSION_NAME_ACCESSION = 'bco:accessionName';
const ACCESSION_NAME_NAME = 'Accession';
const INSTITUTE_CODE_ACCESSION = 'bco:instituteCode';
const INSTITUTE_CODE_NAME = 'Material source institute code';
const ACCESSION_NUMBER_ACCESSION = 'bco:accessionNumber';
const ACCESSION_NUMBER_NAME = 'Accession Number';
const INSTITUTE_NAME_ACCESSION = 'bco:instituteName';
const INSTITUTE_NAME_NAME = 'Material source institute name';
const SOURCE_DOI_ACCESSION = 'bco:doi';
const SOURCE_DOI_NAME = 'DOI';
const SOURCE_DESCRIPTION_ACCESSION = 'bco:sourceDescription';
const SOURCE_DESCRIPTION_NAME = 'Description';
const OTHER_IDS_ACCESSION = 'bco:otherIdentifiers';
const OTHER_IDS_NAME = 'Other Identifiers';

interface MaterialSourceRow {
	sourceId: string;
	getCharacteristic(accession: string, nameFallback: string): string | undefined;
	getCharacteristics(accession: string, nameFallback: string): string[];
}

/** Finds every ArcTable row in the study where an Input or Output column is IOType.Source,
 *  deduped by name -- see the section comment above for why this needs no process-graph
 *  traversal, mirroring resolveObservationUnits' dedicated-node shape one IOType tag over. */
function resolveMaterialSources(study: IsaStudy): MaterialSourceRow[] {
	const sources: MaterialSourceRow[] = [];
	const seenNames = new Set<string>();

	for (const table of study.Tables) {
		for (const column of table.Columns) {
			if (!column.Header.isInput && !column.Header.isOutput) continue;
			const ioType = unwrapOption<{ tag: number }>(column.Header.TryIOType());
			if (ioType?.tag !== SOURCE_IO_TYPE_TAG) continue;

			for (let row = 0; row < table.RowCount; row++) {
				const name = column.Cells[row]?.GetContent()[0];
				if (!name || seenNames.has(name)) continue;
				seenNames.add(name);
				sources.push({
					sourceId: name,
					getCharacteristic: (accession, nameFallback) =>
						characteristicsMatching(table, row, accession, nameFallback)[0],
					getCharacteristics: (accession, nameFallback) =>
						characteristicsMatching(table, row, accession, nameFallback)
				});
			}
		}
	}
	return sources;
}

const ISA_MATERIAL_SOURCE_ACCESSORS = new Map<string, (source: MaterialSourceRow) => unknown>([
	['material_source:MaterialSource', () => undefined],
	[
		'material_source:materialSourceAccName',
		(source) => source.getCharacteristics(ACCESSION_NAME_ACCESSION, ACCESSION_NAME_NAME)
	],
	[
		'material_source:materialSourceInstCode',
		(source) => source.getCharacteristic(INSTITUTE_CODE_ACCESSION, INSTITUTE_CODE_NAME)
	],
	[
		'material_source:materialSourceAccNumber',
		(source) => source.getCharacteristic(ACCESSION_NUMBER_ACCESSION, ACCESSION_NUMBER_NAME)
	],
	[
		'material_source:materialSourceAltitude',
		(source) => source.getCharacteristic(ALTITUDE_ACCESSION, ALTITUDE_NAME)
	],
	[
		'material_source:materialSourceCoordUncertainty',
		(source) => source.getCharacteristic(COORD_UNCERTAINTY_ACCESSION, COORD_UNCERTAINTY_NAME)
	],
	[
		'material_source:materialSourceDesc',
		(source) => source.getCharacteristic(SOURCE_DESCRIPTION_ACCESSION, SOURCE_DESCRIPTION_NAME)
	],
	[
		'material_source:materialSourceDoi',
		(source) => source.getCharacteristic(SOURCE_DOI_ACCESSION, SOURCE_DOI_NAME)
	],
	[
		'material_source:materialSourceInstName',
		(source) => source.getCharacteristic(INSTITUTE_NAME_ACCESSION, INSTITUTE_NAME_NAME)
	],
	[
		'material_source:materialSourceLatitude',
		(source) => source.getCharacteristic(LATITUDE_ACCESSION, LATITUDE_NAME)
	],
	[
		'material_source:materialSourceLongitude',
		(source) => source.getCharacteristic(LONGITUDE_ACCESSION, LONGITUDE_NAME)
	],
	[
		'material_source:materialSourceOtherIds',
		(source) => source.getCharacteristics(OTHER_IDS_ACCESSION, OTHER_IDS_NAME)
	]
]);

const BRAPI_GERMPLASM_FROM_SOURCE_SETTERS = new Map<
	string,
	(germplasm: Partial<NewGermplasm>, value: unknown) => void
>([
	// Structural confirmation only -- see ISA_MATERIAL_SOURCE_ACCESSORS above.
	['material_source:MaterialSource', () => {}],
	[
		'material_source:materialSourceInstCode',
		(germplasm, value) => {
			germplasm.instituteCode = value as string;
		}
	],
	[
		'material_source:materialSourceAccNumber',
		(germplasm, value) => {
			germplasm.accessionNumber = value as string;
		}
	],
	[
		'material_source:materialSourceInstName',
		(germplasm, value) => {
			germplasm.instituteName = value as string;
		}
	],
	[
		'material_source:materialSourceDoi',
		(germplasm, value) => {
			germplasm.germplasmPui = value as string;
		}
	]
]);

/** Lazily creates germplasm.mcpd, same "lazy first nested object" shape as
 *  ensureDatasetAuthorship/ensureGrowthFacility/ensureGermplasmOrigin above. */
function ensureGermplasmMcpd(germplasm: Partial<NewGermplasm>): GermplasmMcpd {
	const existing = germplasm.mcpd as GermplasmMcpd | undefined;
	if (existing) return existing;
	const created: GermplasmMcpd = {};
	germplasm.mcpd = created as NewGermplasm['mcpd'];
	return created;
}

/** A handful of GermplasmMCPD fields (accessionNumber, instituteCode, germplasmPUI, ...) are
 *  synonyms of fields that live directly on Germplasm -- sssom.tsv only ever crosswalks each of
 *  these onto the `brapi_germplasm:` side (see the MaterialSource registries section above), so
 *  BRAPI_GERMPLASM_MCPD_SETTERS never receives them. Mirroring them into mcpd here, once the
 *  draft's own fields are final, keeps the persisted mcpd block a complete, self-contained MCPD
 *  record instead of leaving every reader to reassemble it from the top-level columns.
 *  germplasmDbId is the one GermplasmMCPD field this can't cover -- `germplasm.id` is a
 *  DB-generated default not known until insert, so the mcpd endpoint still fills that one in
 *  at read time. */
function fillGermplasmMcpdSynonyms(germplasmDraft: Partial<NewGermplasm>): void {
	const mcpd = ensureGermplasmMcpd(germplasmDraft);
	mcpd.accessionNumber = germplasmDraft.accessionNumber ?? mcpd.accessionNumber;
	mcpd.acquisitionDate = germplasmDraft.acquisitionDate ?? mcpd.acquisitionDate;
	mcpd.biologicalStatusOfAccessionCode =
		germplasmDraft.biologicalStatusOfAccessionCode ?? mcpd.biologicalStatusOfAccessionCode;
	mcpd.commonCropName = germplasmDraft.commonCropName ?? mcpd.commonCropName;
	mcpd.countryOfOrigin = germplasmDraft.countryOfOriginCode ?? mcpd.countryOfOrigin;
	mcpd.genus = germplasmDraft.genus ?? mcpd.genus;
	mcpd.germplasmPUI = germplasmDraft.germplasmPui ?? mcpd.germplasmPUI;
	mcpd.instituteCode = germplasmDraft.instituteCode ?? mcpd.instituteCode;
	mcpd.species = germplasmDraft.species ?? mcpd.species;
	mcpd.speciesAuthority = germplasmDraft.speciesAuthority ?? mcpd.speciesAuthority;
	mcpd.subtaxon = germplasmDraft.subtaxa ?? mcpd.subtaxon;
	mcpd.subtaxonAuthority = germplasmDraft.subtaxaAuthority ?? mcpd.subtaxonAuthority;

	const storageTypeCodes = germplasmDraft.storageTypes
		?.map((storageType) => storageType.code)
		.filter((code): code is StorageTypeCode => code !== undefined);
	if (storageTypeCodes && storageTypeCodes.length > 0) mcpd.storageTypeCodes = storageTypeCodes;
}

/** Lazily creates mcpd.collectingInfo.collectingSite, one level deeper than
 *  ensureGermplasmMcpd -- same lazy-nested-object shape, just two levels instead of one. */
function ensureCollectingSite(germplasm: Partial<NewGermplasm>): CollectingSite {
	const mcpd = ensureGermplasmMcpd(germplasm);
	const collectingInfo = mcpd.collectingInfo ?? (mcpd.collectingInfo = {});
	return collectingInfo.collectingSite ?? (collectingInfo.collectingSite = {});
}

const BRAPI_GERMPLASM_MCPD_SETTERS = new Map<
	string,
	(germplasm: Partial<NewGermplasm>, value: unknown) => void
>([
	[
		'material_source:materialSourceAccName',
		(germplasm, value) => {
			const mcpd = ensureGermplasmMcpd(germplasm);
			mcpd.accessionNames = [...(mcpd.accessionNames ?? []), ...(value as string[])];
		}
	],
	[
		'material_source:materialSourceAltitude',
		(germplasm, value) => {
			ensureCollectingSite(germplasm).elevation = value as string;
		}
	],
	[
		'material_source:materialSourceCoordUncertainty',
		(germplasm, value) => {
			ensureCollectingSite(germplasm).coordinateUncertainty = value as string;
		}
	],
	[
		'material_source:materialSourceDesc',
		(germplasm, value) => {
			ensureGermplasmMcpd(germplasm).remarks = value as string;
		}
	],
	[
		'material_source:materialSourceLatitude',
		(germplasm, value) => {
			ensureCollectingSite(germplasm).latitudeDecimal = value as string;
		}
	],
	[
		'material_source:materialSourceLongitude',
		(germplasm, value) => {
			ensureCollectingSite(germplasm).longitudeDecimal = value as string;
		}
	],
	[
		'material_source:materialSourceOtherIds',
		(germplasm, value) => {
			const mcpd = ensureGermplasmMcpd(germplasm);
			mcpd.alternateIDs = [...(mcpd.alternateIDs ?? []), ...(value as string[])];
		}
	]
]);

const NCBI_EUTILS_BASE = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const NCBI_REQUEST_TIMEOUT_MS = 5000;

/** Species (full binomial, since it already includes the genus) -> resolved common crop name,
 *  memoized in-process. The same handful of species recur across germplasm rows and ARCs, and the
 *  scientific-to-common-name mapping is effectively static reference data, so caching avoids
 *  re-querying NCBI for every germplasm row. */
const commonCropNameCache = new Map<string, Promise<string | undefined>>();

/** Looks up the NCBI Taxonomy "common name" for a scientific name via E-utils (esearch to resolve
 *  the tax id, then esummary for its commonname field) -- e.g. "Zea mays" -> "maize", "Solanum
 *  lycopersicum" -> "tomato". A genus-only lookup can't be used for this: several genera contain
 *  multiple economically distinct crops (Solanum tuberosum is Potato, Solanum lycopersicum is
 *  Tomato), so the full species binomial is required. Returns undefined on any network error,
 *  timeout, or unmatched name -- this is best-effort for a NOT NULL column with no MIAPPE source,
 *  not a hard dependency. */
async function fetchNcbiCommonName(species: string): Promise<string | undefined> {
	try {
		const searchUrl = `${NCBI_EUTILS_BASE}/esearch.fcgi?db=taxonomy&retmode=json&term=${encodeURIComponent(`${species}[Scientific Name]`)}`;
		const searchRes = await fetch(searchUrl, {
			signal: AbortSignal.timeout(NCBI_REQUEST_TIMEOUT_MS)
		});
		if (!searchRes.ok) return undefined;
		const searchJson = (await searchRes.json()) as { esearchresult?: { idlist?: string[] } };
		const taxId = searchJson.esearchresult?.idlist?.[0];
		if (!taxId) return undefined;

		const summaryUrl = `${NCBI_EUTILS_BASE}/esummary.fcgi?db=taxonomy&retmode=json&id=${taxId}`;
		const summaryRes = await fetch(summaryUrl, {
			signal: AbortSignal.timeout(NCBI_REQUEST_TIMEOUT_MS)
		});
		if (!summaryRes.ok) return undefined;
		const summaryJson = (await summaryRes.json()) as {
			result?: Record<string, { commonname?: string }>;
		};
		const commonName = summaryJson.result?.[taxId]?.commonname?.trim();
		return commonName ? commonName.charAt(0).toUpperCase() + commonName.slice(1) : undefined;
	} catch {
		return undefined;
	}
}

/** MIAPPE keeps Genus and Species in separate columns, but NCBI matches on the full scientific name.
 *  A species that already carries its genus ("Zea mays") is used as is. */
function scientificName(
	genus: string | null | undefined,
	species: string | null | undefined
): string | undefined {
	const sp = species?.trim();
	if (!sp) return undefined;
	const g = genus?.trim();
	if (!g || /\s/.test(sp)) return sp;
	return `${g} ${sp}`;
}

function commonCropNameForGermplasm(name: string | undefined): Promise<string | undefined> {
	const key = name?.trim().toLowerCase();
	if (!key) return Promise.resolve(undefined);
	let cached = commonCropNameCache.get(key);
	if (!cached) {
		cached = fetchNcbiCommonName(key);
		commonCropNameCache.set(key, cached);
	}
	return cached;
}

/* ------------------------------------------------------------------------------------------
 * ObservationUnit (MIAPPE) <-> ISA Sample / BrAPI ObservationUnit registries
 *
 * Unlike BiologicalMaterial, ISA has a dedicated node for this MIAPPE subject (see
 * observation_unit.yaml's `close_mappings: isa_sample:Sample` on the ObservationUnit class
 * itself), so no process-graph backtracking is needed -- just every ArcTable row whose Input or
 * Output column is IOType.Sample, deduped by name (the same physical sample is commonly the
 * Output of one protocol row and the Input of the next).
 * ---------------------------------------------------------------------------------------- */

const OBSERVATION_LEVEL_ACCESSION = 'ppeo:PPEO_observation_level';
const OBSERVATION_LEVEL_NAME = 'observation level';
const SPATIAL_COLUMN_ACCESSION = 'NCIT:C61516';
const SPATIAL_COLUMN_NAME = 'Column';
const SPATIAL_ROW_ACCESSION = 'NCIT:C43378';
const SPATIAL_ROW_NAME = 'Row';
const SPATIAL_POSITION_ACCESSION = 'NCIT:C104788';
const SPATIAL_POSITION_NAME = 'Position';
const SPATIAL_REPLICATE_ACCESSION = 'NCIT:C28038';
const SPATIAL_REPLICATE_NAME = 'Replicate';
const SPATIAL_ENTRY_TYPE_ACCESSION = 'ppeo:hasEntryType';
const SPATIAL_ENTRY_TYPE_NAME = 'Entry Type';

/** See SOURCE_IO_TYPE_TAG above for the full IOType union this tag comes from. */
const SAMPLE_IO_TYPE_TAG = 1;

interface ObservationUnitRow {
	sourceId: string;
	getCharacteristic(accession: string, nameFallback: string): string | undefined;
	getCharacteristics(accession: string, nameFallback: string): string[];
}

interface TableRowLocation {
	table: IsaArcTable;
	row: number;
}

/** Finds every ArcTable row across every Assay in the investigation where an Input or Output
 *  column is IOType.Sample, keyed by sample name. Spatial-distribution characteristics
 *  (Replicate/Position/Row/Column) are recorded where a Sample is *consumed* -- typically a
 *  phenotyping Assay taking the study's Sample as Input -- not on the Study table row that first
 *  produced it, so resolveObservationUnits alone (which only looks at the study's own tables)
 *  never sees them. This indexes by sample name across the whole investigation rather than via
 *  ArcStudy.RegisteredAssays/RegisteredAssayIdentifiers, since real ARCs don't always carry that
 *  registration link even when their Study and Assay tables clearly correspond by sample name. */
function collectAssaySampleRows(investigation: IsaInvestigation): Map<string, TableRowLocation> {
	const bySampleName = new Map<string, TableRowLocation>();
	for (const assay of investigation.Assays) {
		for (const table of assay.Tables) {
			for (const column of table.Columns) {
				if (!column.Header.isInput && !column.Header.isOutput) continue;
				const ioType = unwrapOption<{ tag: number }>(column.Header.TryIOType());
				if (ioType?.tag !== SAMPLE_IO_TYPE_TAG) continue;

				for (let row = 0; row < table.RowCount; row++) {
					const name = column.Cells[row]?.GetContent()[0];
					if (!name || bySampleName.has(name)) continue;
					bySampleName.set(name, { table, row });
				}
			}
		}
	}
	return bySampleName;
}

/** Finds every ArcTable row in the study where an Input or Output column is IOType.Sample,
 *  deduped by name -- see the section comment above for why this needs no process-graph
 *  traversal, unlike resolveBiologicalMaterials. Characteristics are read off both that row and
 *  (when present) the matching assay row from `assaySampleRows` -- see collectAssaySampleRows for
 *  why a sample's characteristics can be split across both places. */
function resolveObservationUnits(
	study: IsaStudy,
	assaySampleRows: Map<string, TableRowLocation>
): ObservationUnitRow[] {
	const units: ObservationUnitRow[] = [];
	const seenNames = new Set<string>();

	for (const table of study.Tables) {
		for (const column of table.Columns) {
			if (!column.Header.isInput && !column.Header.isOutput) continue;
			const ioType = unwrapOption<{ tag: number }>(column.Header.TryIOType());
			if (ioType?.tag !== SAMPLE_IO_TYPE_TAG) continue;

			for (let row = 0; row < table.RowCount; row++) {
				const name = column.Cells[row]?.GetContent()[0];
				if (!name || seenNames.has(name)) continue;
				seenNames.add(name);
				const assayLocation = assaySampleRows.get(name);
				units.push({
					sourceId: name,
					getCharacteristic: (accession, nameFallback) =>
						characteristicsMatching(table, row, accession, nameFallback)[0] ??
						(assayLocation &&
							characteristicsMatching(
								assayLocation.table,
								assayLocation.row,
								accession,
								nameFallback
							)[0]),
					getCharacteristics: (accession, nameFallback) => [
						...characteristicsMatching(table, row, accession, nameFallback),
						...(assayLocation
							? characteristicsMatching(
									assayLocation.table,
									assayLocation.row,
									accession,
									nameFallback
								)
							: [])
					]
				});
			}
		}
	}
	return units;
}

/** The five ISA characteristics that together make up one MIAPPE `spatialDistribution` slot
 *  (see observation_unit.yaml's `special_case_brapi` note on that field) -- read as one struct so
 *  they can go through the same single accessor/setter crosswalk entry as every other field,
 *  rather than needing five entries chained through the same miappeId. */
interface SpatialDistributionValues {
	column?: string;
	row?: string;
	position?: string;
	replicate?: string;
	entryType?: string;
}

function readSpatialDistribution(unit: ObservationUnitRow): SpatialDistributionValues | undefined {
	const values: SpatialDistributionValues = {
		column: unit.getCharacteristic(SPATIAL_COLUMN_ACCESSION, SPATIAL_COLUMN_NAME),
		row: unit.getCharacteristic(SPATIAL_ROW_ACCESSION, SPATIAL_ROW_NAME),
		position: unit.getCharacteristic(SPATIAL_POSITION_ACCESSION, SPATIAL_POSITION_NAME),
		replicate: unit.getCharacteristic(SPATIAL_REPLICATE_ACCESSION, SPATIAL_REPLICATE_NAME),
		entryType: unit.getCharacteristic(SPATIAL_ENTRY_TYPE_ACCESSION, SPATIAL_ENTRY_TYPE_NAME)
	};
	return Object.values(values).some((value) => value !== undefined) ? values : undefined;
}

const ISA_OBSERVATION_UNIT_ACCESSORS = new Map<string, (unit: ObservationUnitRow) => unknown>([
	['observation_unit:obsUnitId', (unit) => unit.sourceId],
	[
		'observation_unit:obsUnitType',
		(unit) => unit.getCharacteristic(OBSERVATION_LEVEL_ACCESSION, OBSERVATION_LEVEL_NAME)
	],
	['observation_unit:spatialDistribution', readSpatialDistribution]
]);

function ensureObservationUnitPosition(unit: Partial<NewObservationUnit>): ObservationUnitPosition {
	const existing = unit.observationUnitPosition as ObservationUnitPosition | undefined;
	if (existing) return existing;
	const created: ObservationUnitPosition = {};
	unit.observationUnitPosition = created as NewObservationUnit['observationUnitPosition'];
	return created;
}

const ENTRY_TYPE_VALUES = new Set(['CHECK', 'TEST', 'FILLER']);

/** Row/Column MIAPPE characteristics collapse onto BrAPI's generic grid position pair
 *  (positionCoordinateX/Y). Position is a distinct sub-plot coordinate (e.g. the plant's index
 *  within its Row/Column cell) and must NOT be collapsed onto the same X/Y pair -- doing so
 *  silently overwrote Column with Position's value, since both landed on positionCoordinateX.
 *  Instead it becomes its own observationLevelRelationships entry, one level finer than the
 *  Row/Column grid, matching the "rep" entry below. The raw ISA value may still carry a
 *  "TYPE:VALUE" prefix (per the MIAPPE spatial_distribution slot's doc: "a key-value pair of the
 *  form type:value"); only the value part is kept as levelCode. */
function parsePositionValue(raw: string): string {
	const separatorIndex = raw.indexOf(':');
	return (separatorIndex === -1 ? raw : raw.slice(separatorIndex + 1)).trim();
}

const BRAPI_OBSERVATION_UNIT_SETTERS = new Map<
	string,
	(unit: Partial<NewObservationUnit>, value: unknown) => void
>([
	[
		'observation_unit:obsUnitId',
		(unit, value) => {
			unit.sourceId = value as string;
			unit.observationUnitName = value as string;
		}
	],
	[
		'observation_unit:obsUnitType',
		(unit, value) => {
			ensureObservationUnitPosition(unit).observationLevel = { levelName: value as string };
		}
	],
	[
		'observation_unit:spatialDistribution',
		(unit, value) => {
			const values = value as SpatialDistributionValues;
			const position = ensureObservationUnitPosition(unit);
			if (values.column !== undefined) {
				position.positionCoordinateX = values.column;
				position.positionCoordinateXType = 'GRID_COL';
			}
			if (values.row !== undefined) {
				position.positionCoordinateY = values.row;
				position.positionCoordinateYType = 'GRID_ROW';
			}
			if (values.position !== undefined) {
				position.observationLevelRelationships = [
					...(position.observationLevelRelationships ?? []),
					{ levelName: 'plant', levelCode: parsePositionValue(values.position) }
				];
			}
			if (values.replicate !== undefined) {
				position.observationLevelRelationships = [
					...(position.observationLevelRelationships ?? []),
					{ levelName: 'rep', levelCode: values.replicate }
				];
			}
			if (values.entryType !== undefined) {
				const normalized = values.entryType.trim().toUpperCase();
				if (ENTRY_TYPE_VALUES.has(normalized)) {
					position.entryType = normalized as 'CHECK' | 'TEST' | 'FILLER';
				}
			}
		}
	]
]);

/**
 * Maps a staged ISA RO-Crate (JSON-LD) into BrAPI entities.
 * Shared/reference entities (program, ...) are out of scope for this function — see the Load
 * stage for why.
 */
export async function transformRoCrate(
	rawRoCrate: unknown,
	arcId: number
): Promise<TransformResult> {
	const investigation = ARC.fromROCrateJsonString(JSON.stringify(rawRoCrate));

	// Investigation -> Trial: driven by sssom.tsv via the MIAPPE pivot (see registries above).
	const trialDraft: Partial<NewTrial> = { arcId };
	applyMiappeCrosswalk(
		investigation,
		trialDraft,
		'isa_investigation:',
		'brapi_trial:',
		ISA_INVESTIGATION_ACCESSORS,
		BRAPI_TRIAL_SETTERS
	);
	// investigation_title has no ISA fallback in the crosswalk itself; ISA's own convention (an
	// investigation with no title is identified by its accession) is preserved as a small
	// post-crosswalk fallback rather than folded into the registry.
	trialDraft.name = trialDraft.name ?? trialDraft.sourceId ?? investigation.Identifier;
	// Guarantee one datasetAuthorships entry exists even if none of the license/date fields
	// were present in the source data, matching the original transform's shape.
	ensureDatasetAuthorship(trialDraft);
	// Publications -> Trial.publications: associatedPublication (the PUI/DOI) is driven by
	// sssom.tsv via the MIAPPE pivot, same engine as above but applied per-publication (see
	// registries above for why). publicationReference stays a hand-formatted citation, same as
	// license/miappeVersion's Comment lookups -- it's a reshaping transform, not a field copy.
	trialDraft.publications = investigation.Publications.map((publication) => {
		const publicationDraft: Partial<TrialPublication> = {};
		applyMiappeCrosswalk(
			publication,
			publicationDraft,
			'isa_publication:',
			'brapi_trial:',
			ISA_PUBLICATION_ACCESSORS,
			BRAPI_PUBLICATION_SETTERS
		);
		publicationDraft.publicationReference = formatVancouverCitation(
			publication.Authors,
			publication.Title
		);
		return publicationDraft as TrialPublication;
	});
	const trial = trialDraft as NewTrial;

	const contacts: NewContact[] = investigation.Contacts.map(toBrapiContact);

	// Study -> Study & Location: driven by sssom.tsv via the MIAPPE pivot, same engine as the
	// investigation block above (see the registries above this function for why one accessor map
	// feeds two setter maps). A study only contributes a Location row if the crosswalk actually
	// populated at least one location-relevant field -- most studies won't carry site/geography
	// Comments at all, and emitting an all-fallback-name Location for every study would just be
	// noise the Load stage would have to dedupe back out.
	const studies: NewStudy[] = [];
	const locations: NewLocation[] = [];
	const studyLocations: StudyLocationLink[] = [];

	for (const arcStudy of investigation.Studies) {
		const studyDraft: Partial<NewStudy> = { arcId, studyCode: arcStudy.Identifier };
		applyMiappeCrosswalk(
			arcStudy,
			studyDraft,
			'isa_',
			'brapi_study:',
			ISA_STUDY_ACCESSORS,
			BRAPI_STUDY_SETTERS
		);
		// Same ISA-identifies-by-accession-when-untitled fallback as the trial's name above.
		studyDraft.name = studyDraft.name ?? arcStudy.Identifier;
		studies.push(studyDraft as NewStudy);

		const locationDraft: Partial<NewLocation> = {};
		applyMiappeCrosswalk(
			arcStudy,
			locationDraft,
			'isa_',
			'brapi_location:',
			ISA_STUDY_ACCESSORS,
			BRAPI_LOCATION_SETTERS
		);
		if (Object.keys(locationDraft).length > 0) {
			locationDraft.name = locationDraft.name ?? `${arcStudy.Identifier} location`;
			const location = locationDraft as NewLocation;
			locations.push(location);
			studyLocations.push({ studySourceId: arcStudy.Identifier, location });
		}
	}

	const studyContacts: StudyContactLink[] = investigation.Studies.flatMap((arcStudy) =>
		arcStudy.Contacts.map((person) => ({
			studySourceId: arcStudy.Identifier,
			contact: toBrapiContact(person)
		}))
	);

	// BiologicalMaterial -> Germplasm: driven by sssom.tsv via the MIAPPE pivot, same engine as
	// above, but the "source" objects aren't ISA classes directly -- they're resolved by walking
	// each study's process graph first (see the long comment above resolveBiologicalMaterials for
	// why ISA has no dedicated node to read this off of). The same accession (germplasmName) can
	// legitimately recur across studies in one ARC (the same seed lot used in multiple trials), so
	// dedupe by sourceId rather than emitting one Germplasm row per occurrence.
	const germplasm: NewGermplasm[] = [];
	const germplasmRowBySourceId = new Map<string, NewGermplasm>();
	for (const arcStudy of investigation.Studies) {
		// MaterialSource -> Germplasm/Germplasm.mcpd: a Source is a process-graph leaf, so its
		// name always agrees with the sourceId resolveBiologicalMaterials resolves below by
		// walking backward from the material/sample -- see the MaterialSource registries section
		// above for why this needs its own resolver instead of extending resolveBiologicalMaterials.
		const materialSourceRowsByName = new Map(
			resolveMaterialSources(arcStudy).map((row) => [row.sourceId, row])
		);
		for (const material of resolveBiologicalMaterials(arcStudy)) {
			if (germplasmRowBySourceId.has(material.sourceId)) continue;

			const germplasmDraft: Partial<NewGermplasm> = {};
			applyMiappeCrosswalk(
				material,
				germplasmDraft,
				'isa_',
				'brapi_germplasm:',
				ISA_MATERIAL_ACCESSORS,
				BRAPI_GERMPLASM_SETTERS,
				'biological_material:'
			);
			const materialSource = materialSourceRowsByName.get(material.sourceId);
			if (materialSource) {
				applyMiappeCrosswalk(
					materialSource,
					germplasmDraft,
					'isa_',
					'brapi_germplasm:',
					ISA_MATERIAL_SOURCE_ACCESSORS,
					BRAPI_GERMPLASM_FROM_SOURCE_SETTERS,
					'material_source:'
				);
				applyMiappeCrosswalk(
					materialSource,
					germplasmDraft,
					'isa_',
					'brapi_germplasm_mcpd:',
					ISA_MATERIAL_SOURCE_ACCESSORS,
					BRAPI_GERMPLASM_MCPD_SETTERS,
					'material_source:'
				);
			}
			germplasmDraft.germplasmName = germplasmDraft.germplasmName ?? material.sourceId;
			// commonCropName/germplasmPui are NOT NULL columns with no MIAPPE source at all --
			// a best-effort NCBI Taxonomy lookup and a synthetic PUI are the only options here,
			// but only as a last resort: materialSourceDoi (via BRAPI_GERMPLASM_FROM_SOURCE_SETTERS
			// above) is a real externally-authored identifier when the source data has one.
			germplasmDraft.commonCropName =
				(await commonCropNameForGermplasm(
					scientificName(germplasmDraft.genus, germplasmDraft.species)
				)) ?? '';
			germplasmDraft.germplasmPui =
				germplasmDraft.germplasmPui ??
				(germplasmDraft.externalReferences as ExternalReference[] | undefined)?.[0]?.referenceId ??
				`${arcId}:${material.sourceId}`;
			fillGermplasmMcpdSynonyms(germplasmDraft);
			germplasmRowBySourceId.set(material.sourceId, germplasmDraft as NewGermplasm);
			germplasm.push(germplasmDraft as NewGermplasm);
		}
	}

	// Sample -> ObservationUnit: driven by sssom.tsv via the MIAPPE pivot, same engine as above.
	// ISA has a dedicated Sample node for this MIAPPE subject (see the registries above this
	// function for why no process-graph walk is needed here, unlike BiologicalMaterial).
	const observationUnits: NewObservationUnit[] = [];
	const studyObservationUnits: StudyObservationUnitLink[] = [];
	const observationUnitGermplasm: ObservationUnitGermplasmLink[] = [];
	const assaySampleRows = collectAssaySampleRows(investigation);
	for (const arcStudy of investigation.Studies) {
		// Walking backward from the *sample's* own name passes through the exact same
		// plant-growth-protocol row resolveBiologicalMaterials walked from (Input=material,
		// Output=sample) before continuing upstream, landing on the identical Source name -- so
		// this always agrees with the sourceId germplasmRowBySourceId was keyed on above, with no
		// separate traversal logic to keep in sync.
		const processLinks = collectProcessLinks(arcStudy);
		for (const unitRow of resolveObservationUnits(arcStudy, assaySampleRows)) {
			const unitDraft: Partial<NewObservationUnit> = { arcId };
			applyMiappeCrosswalk(
				unitRow,
				unitDraft,
				'isa_sample:',
				'brapi_observation_unit:',
				ISA_OBSERVATION_UNIT_ACCESSORS,
				BRAPI_OBSERVATION_UNIT_SETTERS
			);
			// externalId's sssom.tsv row reuses the exact same (isa_material:characteristics ->
			// brapi_germplasm:externalReferences) object pair as biological_material's own
			// externalId mapping, so it can't be routed through the generic engine here without
			// colliding with Germplasm's registry (the engine dispatches by MIAPPE subject id, but
			// scopes *which* entries a call sees by isaId/brapiId prefix -- see the crosswalk
			// engine's doc comment above). Handled directly instead: same characteristic, read here
			// and written onto ObservationUnit.externalReferences (identical ExternalReference[]
			// shape to Germplasm's) rather than literally onto Germplasm, as the yaml's setter
			// annotation -- copy-pasted from biological_material's own -- literally names. The
			// germplasm crosswalk call above also sees this same crosswalk entry by isaId/brapiId
			// prefix, but its 'biological_material:' miappePrefix scope excludes it, so no
			// spurious "no ISA accessor" warning is emitted for it.
			const externalReferenceIds = unitRow.getCharacteristics(
				EXTERNAL_REFERENCE_ID_ACCESSION,
				EXTERNAL_REFERENCE_ID_NAME
			);
			if (externalReferenceIds.length > 0) {
				unitDraft.externalReferences = externalReferenceIds.map((referenceId) => ({
					referenceId
				})) as NewObservationUnit['externalReferences'];
			}
			unitDraft.observationUnitName = unitDraft.observationUnitName ?? unitRow.sourceId;

			const observationUnitRow = unitDraft as NewObservationUnit;
			observationUnits.push(observationUnitRow);
			studyObservationUnits.push({
				studySourceId: arcStudy.Identifier,
				observationUnit: observationUnitRow
			});

			const germplasmSourceId = resolveSourceName(processLinks, unitRow.sourceId);
			const germplasmRow = germplasmRowBySourceId.get(germplasmSourceId);
			if (germplasmRow) {
				observationUnitGermplasm.push({
					observationUnit: observationUnitRow,
					germplasm: germplasmRow
				});
			}
		}
	}

	return {
		trials: [trial],
		studies,
		contacts,
		studyContacts,
		locations,
		studyLocations,
		germplasm,
		observationUnits,
		studyObservationUnits,
		observationUnitGermplasm,
		observations: [],
		observationVariables: [],
		images: [],
		events: []
	};
}
