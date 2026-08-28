import type { NewTrial, NewStudy, NewContact } from '$lib/types/brapi/core';
import type {
	NewCrossingProject,
	NewCross,
	NewPlannedCross,
	NewPedigreeNode,
	NewSeedLot,
	NewSeedLotTransaction,
	NewGermplasmAttributeValue
} from '$lib/types/brapi/germplasm';
import type {
	NewObservationUnit,
	NewObservation,
	NewImage,
	NewBrapiEvent
} from '$lib/types/brapi/phenotyping';
import { ARC } from '@nfdi4plants/arctrl';

/** A study-level contact, paired with the ARC identifier of the study it belongs to
 *  (studies aren't upserted yet at transform time, so they have no database id to link by). */
export interface StudyContactLink {
	studySourceId: string;
	contact: NewContact;
}

export interface TransformResult {
	trials: NewTrial[];
	contacts: NewContact[];
	studies: NewStudy[];
	studyContacts: StudyContactLink[];
	crossingProjects: NewCrossingProject[];
	crosses: NewCross[];
	plannedCrosses: NewPlannedCross[];
	pedigreeNodes: NewPedigreeNode[];
	seedLots: NewSeedLot[];
	seedLotTransactions: NewSeedLotTransaction[];
	germplasmAttributeValues: NewGermplasmAttributeValue[];
	observationUnits: NewObservationUnit[];
	observations: NewObservation[];
	images: NewImage[];
	events: NewBrapiEvent[];
}

/**
 * Formats "Authors. Title." per Vancouver citation style. ARC's Publication model doesn't
 * capture journal/year/volume, so author list and title are all that's available to cite.
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

/**
 * Maps a staged ISA RO-Crate (JSON-LD) into BrAPI entities.
 * TODO: implement the ISA -> BrAPI mapping once the target entity set is known.
 * Shared/reference entities (germplasm, location, program, person, ...) are out of
 * scope for this function — see the Load stage for why.
 */
export function transformRoCrate(rawRoCrate: unknown, arcId: number): TransformResult {
	const investigation = ARC.fromROCrateJsonString(JSON.stringify(rawRoCrate));

	const license = investigation.Comments.find((comment) => comment.Name === 'License')?.Value;

	const trial: NewTrial = {
		arcId,
		sourceId: investigation.Identifier,
		name: investigation.Title ?? investigation.Identifier,
		description: investigation.Description,
		datasetAuthorships: [
			{
				license,
				submissionDate: investigation.SubmissionDate,
				publicReleaseDate: investigation.PublicReleaseDate
			}
		],
		publications: investigation.Publications.map((publication) => ({
			publicationPUI: publication.DOI,
			publicationReference: formatVancouverCitation(publication.Authors, publication.Title)
		}))
	};

	const contacts: NewContact[] = investigation.Contacts.map((person) => ({
		name: [person.FirstName, person.MidInitials, person.LastName].filter(Boolean).join(' '),
		email: person.EMail,
		orcid: person.ORCID,
		type:
			person.Roles.map((role) => role.NameText)
				.filter(Boolean)
				.join(', ') || undefined,
		instituteName: person.Affiliation
	}));

	// Study fields sourced from a plain top-level ISA "Comment[...]" are looked up by name,
	// same as the trial's License comment above. Fields whose ARC source is an annotation-table
	// characteristic (e.g. start date, growth facility type, experimental design description,
	// map of experimental design) aren't mapped here — this transform doesn't parse ArcTables.
	const studies: NewStudy[] = investigation.Studies.map((arcStudy) => {
		const studyComments = arcStudy.Comments;
		const findComment = (name: string) => studyComments.find((c) => c.Name === name)?.Value;

		const growthFacilityDescription = findComment('Description of growth facility');
		const observationUnitLevelHierarchy = findComment('Observation unit level hierarchy');
		const [firstDesignDescriptor] = arcStudy.StudyDesignDescriptors;

		return {
			arcId,
			sourceId: arcStudy.Identifier,
			name: arcStudy.Title ?? arcStudy.Identifier,
			studyCode: arcStudy.Identifier,
			description: arcStudy.Description,
			endDate: findComment('End date of study'),
			culturalPractices: findComment('Cultural practices'),
			observationUnitsDescription: findComment('Observation unit description'),
			experimentalDesign: firstDesignDescriptor
				? { PUI: firstDesignDescriptor.TermAccessionNumber }
				: undefined,
			growthFacility: growthFacilityDescription
				? { description: growthFacilityDescription }
				: undefined,
			additionalInfo: observationUnitLevelHierarchy ? { observationUnitLevelHierarchy } : undefined
		};
	});

	const studyContacts: StudyContactLink[] = investigation.Studies.flatMap((arcStudy) =>
		arcStudy.Contacts.map((person) => ({
			studySourceId: arcStudy.Identifier,
			contact: {
				name: [person.FirstName, person.MidInitials, person.LastName].filter(Boolean).join(' '),
				email: person.EMail,
				orcid: person.ORCID,
				type:
					person.Roles.map((role) => role.NameText)
						.filter(Boolean)
						.join(', ') || undefined,
				instituteName: person.Affiliation
			}
		}))
	);

	return {
		trials: [trial],
		contacts,
		studies,
		studyContacts,
		crossingProjects: [],
		crosses: [],
		plannedCrosses: [],
		pedigreeNodes: [],
		seedLots: [],
		seedLotTransactions: [],
		germplasmAttributeValues: [],
		observationUnits: [],
		observations: [],
		images: [],
		events: []
	};
}
