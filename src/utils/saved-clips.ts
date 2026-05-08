import { SavedClipRecord, Template } from '../types/types';
import { sanitizeFileName } from './string-utils';

const EPHEMERAL_PARAMS = new Set([
	't',
	'utm_source',
	'utm_medium',
	'utm_campaign',
	'utm_term',
	'utm_content',
	'ref',
	'source',
	'src',
	'fbclid',
	'gclid',
	'dclid',
	'msclkid',
	'twclid',
	'mc_cid',
	'mc_eid',
	'_ga',
	'_gl',
	'si',
]);

export interface HighlightLike {
	id?: string;
	content?: string;
	text?: string;
}

export interface SavedClipRecordInput {
	kind?: SavedClipRecord['kind'];
	url: string;
	title?: string;
	vault?: string;
	path?: string;
	noteName?: string;
	noteFile?: string;
	filename?: string;
	downloadId?: number;
	templateId?: string;
	templateName?: string;
	behavior?: Template['behavior'];
	savedHighlightIds?: string[];
	timestamp?: string;
	openUri?: string;
}

export function normalizeClipUrl(url: string): string {
	try {
		const parsed = new URL(url);
		parsed.hash = '';

		const params = new URLSearchParams(parsed.search);
		for (const key of [...params.keys()]) {
			if (EPHEMERAL_PARAMS.has(key.toLowerCase())) {
				params.delete(key);
			}
		}
		parsed.search = params.toString();
		return parsed.toString();
	} catch {
		return url;
	}
}

export function normalizeNotePath(path: string): string {
	const cleanPath = path.trim();
	if (!cleanPath) return '';
	return cleanPath.endsWith('/') ? cleanPath : `${cleanPath}/`;
}

export function isDailyBehavior(behavior?: Template['behavior']): boolean {
	return behavior === 'append-daily' || behavior === 'prepend-daily';
}

export function buildNoteFile(path: string, noteName: string, behavior?: Template['behavior']): string {
	if (isDailyBehavior(behavior)) return 'Daily note';
	return `${normalizeNotePath(path)}${sanitizeFileName(noteName)}`;
}

export function buildOpenNoteUri(vault: string | undefined, noteFile: string | undefined, behavior?: Template['behavior']): string {
	const params: string[] = [];
	if (vault) params.push(`vault=${encodeURIComponent(vault)}`);

	if (isDailyBehavior(behavior)) {
		const query = params.join('&');
		return query ? `obsidian://daily?${query}` : 'obsidian://daily';
	}

	if (noteFile) params.push(`file=${encodeURIComponent(noteFile)}`);
	const query = params.join('&');
	return query ? `obsidian://open?${query}` : 'obsidian://open';
}

export function getHighlightIds(highlights: HighlightLike[] = []): string[] {
	return [...new Set(highlights.map(highlight => highlight.id).filter((id): id is string => Boolean(id)))];
}

export function getNewHighlightIds(highlights: HighlightLike[] = [], savedHighlightIds: string[] = []): string[] {
	const saved = new Set(savedHighlightIds);
	return getHighlightIds(highlights).filter(id => !saved.has(id));
}

export function getNewHighlights<T extends HighlightLike>(highlights: T[] = [], savedHighlightIds: string[] = []): T[] {
	const newIds = new Set(getNewHighlightIds(highlights, savedHighlightIds));
	return highlights.filter(highlight => highlight.id && newIds.has(highlight.id));
}

export function mergeHighlightIds(savedHighlightIds: string[] = [], newHighlightIds: string[] = []): string[] {
	return [...new Set([...savedHighlightIds, ...newHighlightIds])];
}

function stripHtml(value: string): string {
	return value.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

function formatHighlightText(highlight: HighlightLike): string {
	return stripHtml(highlight.text || highlight.content || '').replace(/\n{3,}/g, '\n\n').trim();
}

export function buildHighlightAppendMarkdown(highlights: HighlightLike[], pageUrl: string, date = new Date()): string {
	const formattedDate = date.toISOString().slice(0, 10);
	const items = highlights
		.map(formatHighlightText)
		.filter(Boolean)
		.map(text => {
			const indentedText = text.split(/\r?\n/).map((line, index) => index === 0 ? line : `  ${line}`).join('\n');
			return `- ${indentedText}\n  - Source: ${pageUrl}`;
		});

	return `\n\n## Highlights added ${formattedDate}\n\n${items.join('\n')}\n`;
}

export function buildSavedClipRecord(input: SavedClipRecordInput, previous?: SavedClipRecord): SavedClipRecord {
	const now = input.timestamp || new Date().toISOString();
	const kind = input.kind || previous?.kind || 'obsidian';
	const behavior = input.behavior || previous?.behavior;
	const filename = input.filename ?? previous?.filename;
	const noteFile = input.noteFile || previous?.noteFile || (kind === 'download' ? filename || '' : buildNoteFile(input.path || previous?.path || '', input.noteName || previous?.noteName || '', behavior));
	const vault = kind === 'download' ? '' : input.vault ?? previous?.vault ?? '';
	const savedHighlightIds = mergeHighlightIds(previous?.savedHighlightIds || [], input.savedHighlightIds || []);
	const openUri = kind === 'download' ? undefined : input.openUri || previous?.openUri || buildOpenNoteUri(vault, noteFile, behavior);

	return {
		kind,
		normalizedUrl: normalizeClipUrl(input.url),
		url: input.url,
		title: input.title || previous?.title,
		vault,
		path: kind === 'download' ? '' : input.path ?? previous?.path ?? '',
		noteName: kind === 'download' ? '' : input.noteName ?? previous?.noteName ?? '',
		noteFile,
		filename,
		downloadId: input.downloadId ?? previous?.downloadId,
		downloadedAt: kind === 'download' ? now : previous?.downloadedAt,
		templateId: input.templateId ?? previous?.templateId,
		templateName: input.templateName ?? previous?.templateName,
		behavior,
		firstSavedAt: previous?.firstSavedAt || now,
		lastSavedAt: now,
		savedHighlightIds,
		openUri,
	};
}

export function formatSavedClipTarget(record: Pick<SavedClipRecord, 'kind' | 'vault' | 'noteFile' | 'filename'>): string {
	if (record.kind === 'download') return record.filename || record.noteFile || '';
	return [record.vault, record.noteFile].filter(Boolean).join(' / ');
}
