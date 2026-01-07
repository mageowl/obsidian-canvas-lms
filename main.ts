import {
	App,
	htmlToMarkdown,
	MarkdownView,
	moment,
	Notice,
	Plugin,
	PluginSettingTab,
	requestUrl,
	RequestUrlResponsePromise,
	Setting,
} from "obsidian";
import {
	CourseSettings,
	parseCourseSettings,
} from "./src/courseSettingsParser.js";

// Some characters are not allowed on windows and android.
const replaceInvalidCharacters = (str: string) =>
	str.replace(/[/\\:\[\]|#^*&]/g, "_").replace('"', "'");

interface CanvasLMSSettings {
	accessToken: string;
	canvasURL: string;
	rubricMode: "todo-list" | "table";
	courses: CourseSettings[];
	coursesText: string;
}

function joinPaths(...paths: string[]): string {
	return paths
		.filter((p) => p)
		.reduce((a, b) => a.replace(/\/$/, "") + "/" + b.replace(/^\//, ""));
}

const DEFAULT_SETTINGS: CanvasLMSSettings = {
	accessToken: "",
	canvasURL: "",
	rubricMode: "todo-list",
	courses: [],
	coursesText: "",
};

interface Assignment {
	name: string;
	classID: number;
	lastUpdated: string;
	filePath: string;
}

interface APIAssignment {
	id: number;
	name: string;
	description?: string;
	created_at: string;
	updated_at: string;
	due_at?: string;
	course_id: number;
	has_submitted_submissions: boolean;
	// URL to canvas page
	html_url: string;
	rubric: {
		points: number;
		description: string;
		long_description?: string;
	}[] | null;
}

export default class CanvasLMS extends Plugin {
	settings: CanvasLMSSettings = DEFAULT_SETTINGS;
	knownAssignments: { [id: number]: Assignment } = {};

	override async onload() {
		await this.loadSettings();

		// This adds a simple command that can be triggered anywhere
		this.addCommand({
			id: "sync-canvas-assignments",
			name: "Sync Canvas assignments",
			callback: async () => {
				new Notice("Syncing assignments...");
				const start = performance.now();
				const success = await this.syncAssignments().catch((e) => {
					console.error(e);
					return false;
				});
				if (success) {
					new Notice(
						`Assignments synced in ${
							Math.round(performance.now() - start)
						}ms`,
					);
				} else {new Notice(
						"Failed to sync assignments! Check your access token.",
					);}
			},
		});
		this.addCommand({
			id: "reset-assignment",
			name: "Reset Assignment",
			checkCallback: (checking) => {
				const markdownView = this.app.workspace.getActiveViewOfType(
					MarkdownView,
				);
				if (!markdownView) return false;
				const file = markdownView.file;
				if (!file) return false;
				const cache = this.app.metadataCache.getFileCache(file);
				if (!cache) return false;
				const urlRegex = new RegExp(
					`https://${this.settings.canvasURL}/courses/(\\d+)/assignments/(\\d+)`,
				);
				const canvasUrl: string[] = cache.frontmatter?.url?.match(
					urlRegex,
				);
				if (!canvasUrl) return false;

				const [, courseIDStr, assignmentIDStr] = canvasUrl;
				const courseID = parseInt(courseIDStr),
					assignmentID = parseInt(assignmentIDStr);
				const course = this.settings.courses.find(({ id }) =>
					id === courseID
				);
				if (course == null) return false;

				if (checking) return true;

				(async () => {
					const assignment = (await this.getAssignment(
						courseID,
						assignmentID,
					)).json;
					console.log(course);

					const text = this.makeAssignment(
						assignment,
						course,
					);
					this.app.vault.modify(file, text);
				})();
			},
		});

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new CanvasLMSSettingTab(this.app, this));
	}

	override onunload() {
	}

	async loadSettings() {
		const data = await this.loadData();
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings);
		this.knownAssignments = data.knownAssignments ?? {};
	}

	async saveSettings() {
		await this.saveData({
			settings: this.settings,
			knownAssignments: this.knownAssignments,
		});
	}

	async syncAssignments(): Promise<boolean> {
		for (const course of this.settings.courses) {
			if (this.app.vault.getFolderByPath(course.folder) == null) {
				this.app.vault.createFolder(course.folder);
			}
			if (!await this.syncCourse(course)) {
				return false;
			}
		}
		return true;
	}

	async syncCourse(course: CourseSettings): Promise<boolean> {
		const firstPage = await this.getAssignmentPage(course.id, 0);
		const linkHeader = firstPage.headers.link ?? firstPage.headers.Link;
		const numPagesStr = linkHeader.match(/page=(\d+)[^>]*>; rel="last"/)
			?.[1];
		if (numPagesStr == null) {
			console.error(`Invalid number of pages: ${linkHeader}`);
			return false;
		}
		const numPages = parseInt(numPagesStr);

		const assignments: APIAssignment[] = firstPage.json;
		for (let i = 1; i < numPages; i++) {
			assignments.push(...(await this.getAssignmentPage(548, i)).json);
		}

		for (const assignment of assignments) {
			const knownData = this.knownAssignments[assignment.id];
			if (knownData != null) {
				if (knownData.lastUpdated === assignment.updated_at) continue;

				const file = this.app.vault.getFileByPath(knownData.filePath);
				if (file == null) {
					this.app.vault.create(
						knownData.filePath,
						this.makeAssignment(assignment, course),
					);
				} else {
					this.app.fileManager.processFrontMatter(
						file,
						(frontmatter) => {
							if (assignment.due_at != null) {
								frontmatter.due = moment.utc(assignment.due_at)
									.local().format(
										"YYYY-MM-DD HH:mm:ss",
									);
							}
							frontmatter.assigned =
								assignment.created_at.split("T")[0];
							// frontmatter.done ||=
							// 	assignment.has_submitted_submissions;
						},
					);
				}
			} else {
				const filePath = joinPaths(
					course.folder,
					replaceInvalidCharacters(assignment.name),
				) +
					".md";
				console.log(filePath);
				this.knownAssignments[assignment.id] = {
					name: assignment.name,
					classID: course.id,
					lastUpdated: assignment.updated_at,
					filePath,
				};

				const file = this.app.vault.getFileByPath(filePath);
				if (file == null) {
					this.app.vault.create(
						filePath,
						this.makeAssignment(assignment, course),
					);
				}
			}
		}

		await this.saveSettings();
		return true;
	}

	makeAssignment(
		assignment: APIAssignment,
		course: CourseSettings,
	) {
		let text = `---
tags:
  - assignment ${course.extraTags.map((t) => "\n  - " + t).join("")}
due: ${
			assignment.due_at != null
				? moment.utc(assignment.due_at).local().format(
					"YYYY-MM-DD HH:mm:ss",
				)
				: ""
		}
assigned: ${assignment.created_at.split("T")[0]}
url: ${assignment.html_url}
done: ${
			// assignment.has_submitted_submissions ?? false}
			false}${
			course.extraFrontmatter.map(([k, v]) => `\n${k}: ${v}`).join("")
		}
---
`;

		if (assignment.description != null) {
			text += "## Description\n";
			text += htmlToMarkdown(
				assignment.description.replace("\n", "").replace(
					"h2",
					"h3",
				),
			);
		}

		if (assignment.rubric != null) {
			text += "\n## Rubric\n";
			switch (this.settings.rubricMode) {
				case "todo-list": {
					for (const rubricItem of assignment.rubric) {
						text +=
							`- [ ] **${rubricItem.description}** (${rubricItem.points} points)\n`;
						if (rubricItem.long_description) {
							text += `\t- _${rubricItem.long_description}_\n`;
						}
					}
					break;
				}
				case "table": {
					text +=
						"| Criteria | Points | Description |\n| -------- | ------ | ----------- |\n";
					for (const rubricItem of assignment.rubric) {
						text +=
							`| ${rubricItem.description} | ${rubricItem.points} | ${
								rubricItem.long_description ?? ""
							} |\n`;
					}
					break;
				}
			}
		}

		return text;
	}

	getAssignmentPage(course: number, idx: number): RequestUrlResponsePromise {
		return requestUrl(
			{
				url: `https://${this.settings.canvasURL}/api/v1/courses/${course}/assignments?page=${
					idx + 1
				}&per_page=100`,
				headers: {
					Authorization: `Bearer ${this.settings.accessToken}`,
				},
			},
		);
	}

	getAssignment(course: number, id: number): RequestUrlResponsePromise {
		return requestUrl(
			{
				url: `https://${this.settings.canvasURL}/api/v1/courses/${course}/assignments/${id}`,
				headers: {
					Authorization: `Bearer ${this.settings.accessToken}`,
				},
			},
		);
	}
}

// class SampleModal extends Modal {
// 	constructor(app: App) {
// 		super(app);
// 	}

// 	onOpen() {
// 		const {contentEl} = this;
// 		contentEl.setText("Woah!");
// 	}

// 	onClose() {
// 		const {contentEl} = this;
// 		contentEl.empty();
// 	}
// }

class CanvasLMSSettingTab extends PluginSettingTab {
	plugin: CanvasLMS;

	constructor(app: App, plugin: CanvasLMS) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName("Access token")
			.setDesc("Generate one at {canvas url}/profile/settings")
			.addText((text) =>
				text
					.setPlaceholder("Enter your token")
					.setValue(this.plugin.settings.accessToken)
					.onChange(async (value) => {
						this.plugin.settings.accessToken = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Canvas URL")
			.addText((text) =>
				text
					.setPlaceholder("example.instructure.com")
					.setValue(this.plugin.settings.canvasURL)
					.onChange(async (value) => {
						this.plugin.settings.canvasURL = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Display rubrics as")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("todo-list", "Todo List")
					.addOption("table", "Table")
					.setValue(this.plugin.settings.rubricMode)
					.onChange(async (value) => {
						// SAFETY: the dropdown always gives one of the options
						this.plugin.settings.rubricMode = value as
							| "todo-list"
							| "table";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Courses")
			.setDesc(
				"Each line is a new course. You can find the ID in the url of the course page.",
			)
			.addTextArea((textArea) =>
				textArea
					.setPlaceholder(
						"id = 123; folder = path/to/assignment/folder;",
					)
					.setValue(this.plugin.settings.coursesText)
					.onChange(async (value) => {
						const data = value
							.split("\n")
							.filter((line) => !line.startsWith("#"))
							.map(parseCourseSettings);
						if (!data.includes(null)) {
							textArea.inputEl.setCustomValidity("");
							this.plugin.settings.coursesText = value;
							this.plugin.settings.courses =
								data as CourseSettings[];
							await this.plugin.saveSettings();
						} else {
							textArea.inputEl.setCustomValidity(
								"Invalid course data. Make sure you defined a numerical id.",
							);
						}
						textArea.inputEl.reportValidity();
					})
			);

		const cachedDataBtn = new Setting(containerEl)
			.setName("Cached data")
			.setDesc(
				`${
					Object.keys(this.plugin.knownAssignments).length
				} assignments cached.`,
			)
			.addButton((btn) =>
				btn
					.setButtonText("Clear")
					.onClick(() => {
						this.plugin.knownAssignments = {};
						this.plugin.saveSettings();
						cachedDataBtn.setDesc("0 assignments cached.");
					})
			);
	}
}
