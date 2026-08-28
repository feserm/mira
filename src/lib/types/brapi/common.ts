export interface ExternalReference {
	/** The external reference ID. Could be a simple string or a URI. */
	referenceId?: string;
	referenceSource?: string;
}

export interface OntologyReferenceLink {
	URL?: string;
	type?: 'OBO' | 'RDF' | 'WEBPAGE';
}

export interface OntologyReference {
	ontologyDbId: string;
	ontologyName: string;
	/** The ID which uniquely identifies a ontology reference. */
	ontologyReferenceDbId?: string;
	version?: string;
	documentationLinks?: OntologyReferenceLink[];
}

export type AdditionalInfo = Record<string, unknown>;

/** [longitude, latitude, altitude?] per RFC 7946 3.1.1. */
export type GeoJSONPosition = number[];

export interface GeoJSONPointGeometry {
	type: 'Point';
	coordinates: GeoJSONPosition;
}

export interface GeoJSONPolygonGeometry {
	type: 'Polygon';
	coordinates: GeoJSONPosition[][];
}

export interface GeoJSON {
	type?: string;
	geometry?: GeoJSONPointGeometry | GeoJSONPolygonGeometry;
}

/** Shared institute-address triple reused across MCPD sub-objects. */
export interface Institute {
	instituteAddress?: string;
	instituteCode?: string;
	instituteName?: string;
}
