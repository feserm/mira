const VISIBILITY_BADGE_CLASS: Record<string, string> = {
	public: 'badge-success',
	internal: 'badge-info',
	private: 'badge-warning'
};

export function visibilityBadgeClass(visibility: string): string {
	return VISIBILITY_BADGE_CLASS[visibility] ?? 'badge-ghost';
}
