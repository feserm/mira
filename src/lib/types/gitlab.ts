export interface GitlabNamespace {
	id: number;
	name: string;
	path: string;
	kind: string;
	full_path: string;
}

export interface GitlabProjectSummary {
	id: number;
	name: string;
	name_with_namespace: string;
	path: string;
	path_with_namespace: string;
	description: string | null;
	avatar_url: string | null;
	web_url: string;
	star_count: number;
	forks_count: number;
	visibility: string;
	archived: boolean;
	last_activity_at: string;
	namespace: GitlabNamespace;
}

export interface GitlabLicense {
	key: string;
	name: string;
	html_url: string;
}

export interface GitlabProjectStatistics {
	repository_size: number;
	storage_size: number;
	lfs_objects_size: number;
}

export interface GitlabProjectDetail extends GitlabProjectSummary {
	created_at: string;
	default_branch: string | null;
	topics: string[];
	open_issues_count?: number;
	readme_url: string | null;
	license: GitlabLicense | null;
	statistics?: GitlabProjectStatistics;
}

export interface Pagination {
	page: number;
	perPage: number;
	totalPages: number;
	total: number;
}
