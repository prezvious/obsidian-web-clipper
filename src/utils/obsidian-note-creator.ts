import browser from './browser-polyfill';
import { sanitizeFileName } from '../utils/string-utils';
import { generateFrontmatter as generateFrontmatterCore } from './shared';
import { Template, Property } from '../types/types';
import { generalSettings, incrementStat } from './storage-utils';
import { copyToClipboard } from './clipboard-utils';
import { getMessage } from './i18n';
import { buildNoteFile, buildOpenNoteUri, isDailyBehavior, normalizeNotePath } from './saved-clips';

export interface SaveToObsidianResult {
	status: 'sent';
	vault: string;
	path: string;
	noteName: string;
	noteFile: string;
	behavior: Template['behavior'];
	openUri: string;
	saveUri: string;
}

export async function generateFrontmatter(properties: Property[]): Promise<string> {
	const typeMap: Record<string, string> = {};
	for (const pt of generalSettings.propertyTypes) {
		typeMap[pt.name] = pt.type;
	}
	return generateFrontmatterCore(properties, typeMap);
}

export async function openObsidianUrl(url: string): Promise<boolean> {
	try {
		const response = await browser.runtime.sendMessage({
		action: "openObsidianUrl",
		url: url
		}) as { success?: boolean };
		return response?.success !== false;
	} catch (error) {
		console.error('Error opening Obsidian URL via background script:', error);
		window.open(url, '_blank');
		return true;
	}
}

async function tryClipboardWrite(fileContent: string, obsidianUrl: string): Promise<string> {
	const success = await copyToClipboard(fileContent);
	
	if (success) {
		// &clipboard tells Obsidian to read data from clipboard instead of the content param.
		// content is a fallback shown only if Obsidian can't access the clipboard (e.g. on Linux).
		obsidianUrl += `&clipboard&content=${encodeURIComponent(getMessage('clipboardError', 'https://help.obsidian.md/web-clipper/troubleshoot'))}`;
		if (!await openObsidianUrl(obsidianUrl)) throw new Error('Failed to open Obsidian URL');
		console.log('Obsidian URL:', obsidianUrl);
	} else {
		console.error('All clipboard methods failed, falling back to URI method');
		// Final fallback: use URI method with actual content (same as legacy mode)
		// Note: We don't add &clipboard here since we're bypassing the clipboard entirely
		obsidianUrl += `&content=${encodeURIComponent(fileContent)}`;
		if (!await openObsidianUrl(obsidianUrl)) throw new Error('Failed to open Obsidian URL');
		console.log('Obsidian URL (URI fallback):', obsidianUrl);
	}
	return obsidianUrl;
}

export async function saveToObsidian(
	fileContent: string,
	noteName: string,
	path: string,
	vault: string,
	behavior: Template['behavior'],
): Promise<SaveToObsidianResult> {
	let obsidianUrl: string;

	const isDailyNote = isDailyBehavior(behavior);
	const originalPath = path;
	const noteFile = buildNoteFile(path, noteName, behavior);

	if (isDailyNote) {
		obsidianUrl = `obsidian://daily?`;
	} else {
		const formattedNoteName = sanitizeFileName(noteName);
		obsidianUrl = `obsidian://new?file=${encodeURIComponent(normalizeNotePath(path) + formattedNoteName)}`;
	}

	if (behavior.startsWith('append')) {
		obsidianUrl += '&append=true';
	} else if (behavior.startsWith('prepend')) {
		obsidianUrl += '&prepend=true';
	} else if (behavior === 'overwrite') {
		obsidianUrl += '&overwrite=true';
	}

	const vaultParam = vault ? `&vault=${encodeURIComponent(vault)}` : '';
	obsidianUrl += vaultParam;

	// Add silent parameter if silentOpen is enabled
	if (generalSettings.silentOpen) {
		obsidianUrl += '&silent=true';
	}

	if (generalSettings.legacyMode) {
		// Use the URI method
		obsidianUrl += `&content=${encodeURIComponent(fileContent)}`;
		console.log('Obsidian URL:', obsidianUrl);
		if (!await openObsidianUrl(obsidianUrl)) throw new Error('Failed to open Obsidian URL');
	} else {
		// Try to copy to clipboard with fallback mechanisms
		obsidianUrl = await tryClipboardWrite(fileContent, obsidianUrl);
	}

	return {
		status: 'sent',
		vault,
		path: isDailyNote ? '' : originalPath,
		noteName: isDailyNote ? '' : noteName,
		noteFile,
		behavior,
		openUri: buildOpenNoteUri(vault, noteFile, behavior),
		saveUri: obsidianUrl,
	};
}

export async function openSavedClip(openUri: string): Promise<boolean> {
	return openObsidianUrl(openUri);
}
