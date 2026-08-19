/**
 * DEPRECATED. Do not use. Instead use Arctrl library for ARC RO Crate handling.
 * 
 * Types for the ARC (Annotated Research Context) RO-Crate format produced by
 * PLANTdataHUB/DataPLANT, derived from an example `ro-crate-metadata.json`'s
 * `@graph` array. Vocabulary is bioschemas.org + https://w3id.org/ro/terms/arc.
 */

/** A JSON-LD reference to another entity in the graph, resolved by `@id`. */
export interface RoCrateReference {
	'@id': string;
}

export interface RoCrateOrganization {
	'@id': string;
	'@type': 'Organization';
	name: string;
}

/** Named `RoCratePerson` for naming symmetry with the other entity interfaces here. */
export interface RoCratePerson {
	'@id': string;
	'@type': 'Person';
	email: string;
	givenName: string;
	familyName: string;
	jobTitle?: RoCrateReference[];
	affiliation?: RoCrateReference;
}

export interface RoCrateDefinedTerm {
	'@id': string;
	'@type': 'DefinedTerm';
	name: string;
	termCode?: string;
}

/** Named `RoCrateFile` (not `File`) to avoid shadowing the DOM `File` interface. */
export interface RoCrateFile {
	'@id': string;
	'@type': 'File';
	name: string;
}

/** An ISA "Source" or "Sample" node, distinguished via `additionalType`. */
export interface RoCrateSample {
	'@id': string;
	'@type': 'Sample';
	name: string;
	additionalType: 'Sample' | 'Source';
	additionalProperty?: RoCrateReference[];
}

/**
 * A Characteristic/Parameter/Factor value attached to a Sample via `additionalProperty`.
 * Only `additionalType: 'CharacteristicValue'` was observed in the example file, but the
 * ARC schema defines sibling kinds (e.g. `ParameterValue`, `FactorValue`) for the same shape.
 */
export interface RoCratePropertyValue {
	'@id': string;
	'@type': 'PropertyValue';
	name: string;
	additionalType: string;
	value?: string;
	propertyID?: string;
	columnIndex: string | string[];
}

export interface RoCrateLabProtocol {
	'@id': string;
	'@type': 'LabProtocol';
	name: string;
	url: string;
	version: string;
	description: string;
	intendedUse: RoCrateReference;
}

export interface RoCrateLabProcess {
	'@id': string;
	'@type': 'LabProcess';
	name: string;
	object: RoCrateReference;
	result: RoCrateReference;
	executesLabProtocol: RoCrateReference;
}

/** Named `RoCrateComment` (not `Comment`) to avoid shadowing the DOM `Comment` interface. */
export interface RoCrateComment {
	'@id': string;
	'@type': 'Comment';
	name: string;
	text: string;
}

export interface RoCrateCreativeWork {
	'@id': string;
	'@type': 'CreativeWork';
	text?: string;
	about?: RoCrateReference;
	conformsTo?: RoCrateReference;
}

/** An assay, a study, or the root dataset (`@id: "./"`). */
export interface RoCrateDataset {
	'@id': string;
	'@type': 'Dataset';
	name?: string;
	identifier: string;
	additionalType: string;
	hasPart: RoCrateReference | RoCrateReference[];
	about?: RoCrateReference[];
	comment?: RoCrateReference | RoCrateReference[];
	creator?: RoCrateReference;
	license?: RoCrateReference;
	datePublished?: string;
	dateModified?: string;
	sdDatePublished?: string;
}

export type RoCrateEntity =
	| RoCrateOrganization
	| RoCratePerson
	| RoCrateDefinedTerm
	| RoCrateFile
	| RoCrateSample
	| RoCratePropertyValue
	| RoCrateLabProtocol
	| RoCrateLabProcess
	| RoCrateComment
	| RoCrateCreativeWork
	| RoCrateDataset;

/** The parsed contents of an `ro-crate-metadata.json` file. */
export interface RoCrate {
	'@context': unknown;
	'@graph': RoCrateEntity[];
}
