import { describe, expect, it } from 'vitest';
import {
	buildHighlightAppendMarkdown,
	buildNoteFile,
	buildOpenNoteUri,
	buildSavedClipRecord,
	getNewHighlightIds,
	mergeHighlightIds,
	normalizeClipUrl,
} from './saved-clips';

Object.defineProperty(globalThis, 'navigator', {
	value: { platform: 'Win32', userAgentData: { platform: 'Windows' } },
	configurable: true,
});

describe('saved clip helpers', () => {
	it('normalizes duplicate URLs by removing fragments, text fragments, tracking params, and YouTube timestamps', () => {
		expect(normalizeClipUrl('https://example.com/article?utm_source=x&id=1#section')).toBe('https://example.com/article?id=1');
		expect(normalizeClipUrl('https://example.com/article#:~:text=quoted')).toBe('https://example.com/article');
		expect(normalizeClipUrl('https://www.youtube.com/watch?v=abc&t=90&si=share')).toBe('https://www.youtube.com/watch?v=abc');
	});

	it('builds note files and open note URIs', () => {
		expect(buildNoteFile('Clippings', 'A/B: Test', 'create')).toBe('Clippings/AB Test');
		expect(buildOpenNoteUri('Vault', 'Clippings/AB Test', 'create')).toBe('obsidian://open?vault=Vault&file=Clippings%2FAB%20Test');
		expect(buildOpenNoteUri('Vault', 'Daily note', 'append-daily')).toBe('obsidian://daily?vault=Vault');
	});

	it('filters only new highlight ids and merges saved ids', () => {
		const highlights = [{ id: 'a' }, { id: 'b' }, { id: 'a' }, { id: 'c' }];
		expect(getNewHighlightIds(highlights, ['a'])).toEqual(['b', 'c']);
		expect(mergeHighlightIds(['a'], ['b', 'a'])).toEqual(['a', 'b']);
	});

	it('creates and updates saved clip records without losing first saved time', () => {
		const first = buildSavedClipRecord({
			url: 'https://example.com/post?utm_campaign=x',
			title: 'Post',
			vault: 'Vault',
			path: 'Clippings',
			noteName: 'Post',
			behavior: 'create',
			savedHighlightIds: ['h1'],
			timestamp: '2026-05-01T00:00:00.000Z',
		});
		const second = buildSavedClipRecord({
			url: 'https://example.com/post#section',
			vault: 'Vault',
			path: 'Clippings',
			noteName: 'Post',
			behavior: 'create',
			savedHighlightIds: ['h2'],
			timestamp: '2026-05-02T00:00:00.000Z',
		}, first);

		expect(first.normalizedUrl).toBe('https://example.com/post');
		expect(second.firstSavedAt).toBe('2026-05-01T00:00:00.000Z');
		expect(second.lastSavedAt).toBe('2026-05-02T00:00:00.000Z');
		expect(second.savedHighlightIds).toEqual(['h1', 'h2']);
	});

	it('creates download records without Obsidian note actions', () => {
		const record = buildSavedClipRecord({
			kind: 'download',
			url: 'https://example.com/post?utm_source=x',
			title: 'Post',
			filename: 'Post.md',
			downloadId: 7,
			timestamp: '2026-05-02T00:00:00.000Z',
		});

		expect(record.kind).toBe('download');
		expect(record.normalizedUrl).toBe('https://example.com/post');
		expect(record.filename).toBe('Post.md');
		expect(record.noteFile).toBe('Post.md');
		expect(record.downloadId).toBe(7);
		expect(record.downloadedAt).toBe('2026-05-02T00:00:00.000Z');
		expect(record.openUri).toBeUndefined();
		expect(record.vault).toBe('');
	});

	it('formats appended highlights with source links', () => {
		const markdown = buildHighlightAppendMarkdown(
			[{ id: 'h1', content: '<p>Important text</p>' }],
			'https://example.com/post',
			new Date('2026-05-02T12:00:00.000Z')
		);

		expect(markdown).toContain('## Highlights added 2026-05-02');
		expect(markdown).toContain('- Important text');
		expect(markdown).toContain('  - Source: https://example.com/post');
	});
});
