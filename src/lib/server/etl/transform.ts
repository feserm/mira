import type { NewTrial, NewStudy } from '$lib/types/brapi/core';
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

export interface TransformResult {
	trials: NewTrial[];
	studies: NewStudy[];
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
        const authorList = formattedAuthors.split(',').map((a) => a.trim()).filter(Boolean);
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

	return {
		trials: [trial],
		studies: [],
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
