import type {
	ontology,
	trait,
	method,
	scale,
	observationVariable,
	studyObservationVariable,
	observationUnit,
	observation,
	image,
	observationImage,
	event,
	eventObservationUnit
} from '$lib/server/db/schema/brapi/phenotyping';
import type { GeoJSON } from './common';

export interface ScaleValidValueCategory {
	label?: string;
	value?: string;
}

export interface ScaleValidValues {
	categories?: ScaleValidValueCategory[];
	/** @deprecated use minimumValue */
	min?: number;
	/** @deprecated use maximumValue */
	max?: number;
	minimumValue?: string;
	maximumValue?: string;
}

/** Shared shape of `ObservationUnitLevel` and `ObservationUnitLevelRelationship`. */
export interface ObservationUnitLevelInfo {
	levelName?: string;
	levelOrder?: number;
	levelCode?: string;
}

export type PositionCoordinateType =
	| 'LONGITUDE'
	| 'LATITUDE'
	| 'PLANTED_ROW'
	| 'PLANTED_INDIVIDUAL'
	| 'GRID_ROW'
	| 'GRID_COL'
	| 'MEASURED_ROW'
	| 'MEASURED_COL';

export interface ObservationUnitPosition {
	observationLevel?: ObservationUnitLevelInfo;
	observationLevelRelationships?: ObservationUnitLevelInfo[];
	entryType?: 'CHECK' | 'TEST' | 'FILLER';
	positionCoordinateX?: string;
	positionCoordinateXType?: PositionCoordinateType;
	positionCoordinateY?: string;
	positionCoordinateYType?: PositionCoordinateType;
	geoCoordinates?: GeoJSON;
}

export interface ObservationTreatment {
	factor?: string;
	modality?: string;
}

export interface EventDateRange {
	discreteDates?: string[];
	startDate?: string;
	endDate?: string;
}

export interface EventParameterValueByDate {
	date?: string;
	value?: string;
}

export interface EventParameter {
	name?: string;
	code?: string;
	units?: string;
	value?: string;
	valuesByDate?: EventParameterValueByDate[];
	description?: string;
	valueDescription?: string;
}

export type Ontology = typeof ontology.$inferSelect;
export type NewOntology = typeof ontology.$inferInsert;

export type Trait = typeof trait.$inferSelect;
export type NewTrait = typeof trait.$inferInsert;

export type Method = typeof method.$inferSelect;
export type NewMethod = typeof method.$inferInsert;

export type Scale = typeof scale.$inferSelect;
export type NewScale = typeof scale.$inferInsert;

export type ObservationVariable = typeof observationVariable.$inferSelect;
export type NewObservationVariable = typeof observationVariable.$inferInsert;

export type StudyObservationVariable = typeof studyObservationVariable.$inferSelect;
export type NewStudyObservationVariable = typeof studyObservationVariable.$inferInsert;

export type ObservationUnit = typeof observationUnit.$inferSelect;
export type NewObservationUnit = typeof observationUnit.$inferInsert;

export type Observation = typeof observation.$inferSelect;
export type NewObservation = typeof observation.$inferInsert;

export type Image = typeof image.$inferSelect;
export type NewImage = typeof image.$inferInsert;

export type ObservationImage = typeof observationImage.$inferSelect;
export type NewObservationImage = typeof observationImage.$inferInsert;

// Named `BrapiEvent` (not `Event`) to avoid shadowing the DOM `Event` interface.
export type BrapiEvent = typeof event.$inferSelect;
export type NewBrapiEvent = typeof event.$inferInsert;

export type EventObservationUnit = typeof eventObservationUnit.$inferSelect;
export type NewEventObservationUnit = typeof eventObservationUnit.$inferInsert;
