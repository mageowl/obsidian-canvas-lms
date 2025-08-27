export interface CourseSettings {
	folder: string;
	id: number;
	extraTags: string[];
	extraFrontmatter: [string, string][];
}

export function parseCourseSettings(rule: string): CourseSettings | null {
	const dict: { [key: string]: string } = Object.fromEntries(
		rule.split(";").map((kv) => kv.split("=").map((s) => s.trim())),
	);

	const id = parseInt(dict.id);
	if (isNaN(id)) return null;

	return {
		id,
		folder: dict.folder ?? "",
		extraTags: dict.tags?.split(",").map((s) => s.trim()) ?? [],
		extraFrontmatter: Object.entries(dict).filter(([k, _]) =>
			k !== "tags" && k !== "id" && k !== "folder"
		),
	};
}
