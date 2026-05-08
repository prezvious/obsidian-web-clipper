import browser from './utils/browser-polyfill';
import * as highlighter from './utils/highlighter';
import { removeExistingHighlights } from './utils/highlighter-overlays';
import { loadSettings, generalSettings } from './utils/storage-utils';
import { getDomain } from './utils/string-utils';
import { extractContentBySelector as extractContentBySelectorShared } from './utils/shared';
import Defuddle from 'defuddle/full';
import { createMarkdownContent } from 'defuddle/full';
import { flattenShadowDom } from './utils/flatten-shadow-dom';
import { serializeChildren } from './utils/dom-utils';
import { debugLog } from './utils/debug';
import { updateSidebarWidth, addResizeHandle, cleanupResizeHandlers } from './utils/iframe-resize';
import { parseForClip } from './utils/clip-utils';

declare global {
	interface Window {
		obsidianClipperGeneration?: number;
	}
}

// IIFE to scope variables and allow safe re-execution
(function() {
	// Bump the generation counter on every injection. Older listeners close
	// over their own generation value and bail out when they see a newer one,
	// so a zombie content script (runtime invalidated after extension update)
	// will silently yield to the freshly-injected instance.
	window.obsidianClipperGeneration = (window.obsidianClipperGeneration ?? 0) + 1;
	const myGeneration = window.obsidianClipperGeneration;

	debugLog('Clipper', 'Initializing content script, generation', myGeneration);

	let isHighlighterMode = false;
	const iframeId = 'obsidian-clipper-iframe';
	const containerId = 'obsidian-clipper-container';
	const toastId = 'obsidian-clipper-status-toast';
	const chipId = 'obsidian-clipper-saved-chip';
	const faviconId = 'obsidian-clipper-status-favicon';
	let activeFaviconStatus: 'none' | 'saved' | 'duplicate' | 'failed' = 'none';
	let lastStableFaviconStatus: 'none' | 'saved' | 'duplicate' = 'none';
	let faviconEnabled = true;
	let faviconObserver: MutationObserver | null = null;

	function statusFaviconSvg(status: 'saved' | 'duplicate' | 'failed'): string {
		if (status === 'saved') {
			return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#2f9e44"/><path d="M8.5 16.4 13.7 21.5 23.7 10.5" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
		}
		if (status === 'duplicate') {
			return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path d="M16 3 30 28H2Z" fill="#f59f00"/><path d="M16 11v8" stroke="#1f1300" stroke-width="3.5" stroke-linecap="round"/><circle cx="16" cy="24" r="1.8" fill="#1f1300"/></svg>`;
		}
		return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#e03131"/><path d="m10 10 12 12M22 10 10 22" stroke="#fff" stroke-width="4" stroke-linecap="round"/></svg>`;
	}

	function ensureFaviconObserver(): void {
		if (faviconObserver || !document.head) return;
		faviconObserver = new MutationObserver(() => {
			if (activeFaviconStatus !== 'none' && faviconEnabled) {
				applyStatusFavicon(activeFaviconStatus);
			}
		});
		faviconObserver.observe(document.head, { childList: true });
	}

	function applyStatusFavicon(status: 'none' | 'saved' | 'duplicate' | 'failed'): void {
		activeFaviconStatus = status;
		const existing = document.getElementById(faviconId);
		if (!faviconEnabled || status === 'none') {
			existing?.remove();
			return;
		}

		ensureFaviconObserver();
		const link = (existing || document.createElement('link')) as HTMLLinkElement;
		link.id = faviconId;
		link.rel = 'icon';
		link.type = 'image/svg+xml';
		link.href = `data:image/svg+xml,${encodeURIComponent(statusFaviconSvg(status))}`;
		if (!existing) document.head.appendChild(link);
	}

	function getToastText(status: 'saved' | 'duplicate' | 'failed', savedClip?: any): { title: string; detail: string } {
		const filename = savedClip?.filename || savedClip?.noteFile || '';
		const timestamp = savedClip?.lastSavedAt || savedClip?.downloadedAt || savedClip?.firstSavedAt;
		const savedAt = timestamp ? new Date(timestamp).toLocaleString() : '';
		const detail = [filename, savedAt ? `Downloaded ${savedAt}` : ''].filter(Boolean).join(' - ');
		if (status === 'saved') return { title: 'Downloaded', detail };
		if (status === 'duplicate') return { title: 'Already downloaded', detail: detail || 'This page was already downloaded from this browser profile.' };
		return { title: 'Download failed', detail: 'Web Clipper could not download Markdown for this page.' };
	}

	function showStatusToast(status: 'saved' | 'duplicate' | 'failed', savedClip?: any): void {
		const existing = document.getElementById(toastId);
		existing?.remove();

		const toast = document.createElement('div');
		toast.id = toastId;
		toast.className = `obsidian-clipper-toast is-${status}`;
		const text = getToastText(status, savedClip);

		const title = document.createElement('div');
		title.className = 'obsidian-clipper-toast-title';
		title.textContent = text.title;
		toast.appendChild(title);

		if (text.detail) {
			const detail = document.createElement('div');
			detail.className = 'obsidian-clipper-toast-detail';
			detail.textContent = text.detail;
			toast.appendChild(detail);
		}

		const actions = document.createElement('div');
		actions.className = 'obsidian-clipper-toast-actions';
		const dismissButton = document.createElement('button');
		dismissButton.type = 'button';
		dismissButton.textContent = 'Dismiss';
		dismissButton.addEventListener('click', () => toast.remove());
		actions.appendChild(dismissButton);
		toast.appendChild(actions);

		document.documentElement.appendChild(toast);
		requestAnimationFrame(() => toast.classList.add('is-visible'));
	}

	function updateSavedChip(status: 'none' | 'saved' | 'duplicate' | 'failed', showIndicator: boolean, savedClip?: any): void {
		const existing = document.getElementById(chipId);
		if (!showIndicator || (status !== 'saved' && status !== 'duplicate')) {
			existing?.remove();
			return;
		}

		const chip = (existing || document.createElement('button')) as HTMLButtonElement;
		chip.id = chipId;
		chip.className = `obsidian-clipper-saved-chip is-${status}`;
		chip.type = 'button';
		chip.textContent = status === 'duplicate' ? 'Downloaded !' : 'Downloaded';
		chip.onclick = () => showStatusToast(status, savedClip);
		if (!existing) document.documentElement.appendChild(chip);
	}

	function applyClipPageIndicator(request: any): void {
		let status = request.status as 'none' | 'saved' | 'duplicate' | 'failed';
		const savedClip = request.savedClip;
		faviconEnabled = request.changeSavedPageFavicon !== false;
		if (status === 'none') {
			document.getElementById(toastId)?.remove();
		}
		updateSavedChip(status, request.showSavedPageIndicator !== false, savedClip);

		if (status === 'failed') {
			applyStatusFavicon('failed');
			if (request.showToast !== false) showStatusToast('failed', savedClip);
			window.setTimeout(() => applyStatusFavicon(lastStableFaviconStatus), 8000);
			return;
		}

		lastStableFaviconStatus = status === 'duplicate' ? 'duplicate' : status === 'saved' ? 'saved' : 'none';
		applyStatusFavicon(lastStableFaviconStatus);
		if (request.showToast && (status === 'saved' || status === 'duplicate')) {
			showStatusToast(status, savedClip);
		}
	}

	function notifyClipperUrlChanged(): void {
		browser.runtime.sendMessage({ action: 'clipperUrlChanged', url: location.href }).catch(() => undefined);
	}

	function watchSpaUrlChanges(): void {
		let lastUrl = location.href;
		const checkUrl = () => {
			if (location.href === lastUrl) return;
			lastUrl = location.href;
			notifyClipperUrlChanged();
		};

		const originalPushState = history.pushState;
		const originalReplaceState = history.replaceState;
		history.pushState = function(data: any, unused: string, url?: string | URL | null) {
			const result = originalPushState.call(this, data, unused, url);
			window.setTimeout(checkUrl, 0);
			return result;
		};
		history.replaceState = function(data: any, unused: string, url?: string | URL | null) {
			const result = originalReplaceState.call(this, data, unused, url);
			window.setTimeout(checkUrl, 0);
			return result;
		};
		window.addEventListener('popstate', checkUrl);
		window.addEventListener('hashchange', checkUrl);
	}

	function removeContainer(container: HTMLElement) {
		container.classList.add('is-closing');
		updateSidebarWidth(document, null);
		cleanupResizeHandlers(document);
		container.addEventListener('animationend', () => {
			container.remove();
			highlighter.repositionHighlights();
		}, { once: true });
	}

	async function toggleIframe() {
		const existingContainer = document.getElementById(containerId);
		if (existingContainer) {
			removeContainer(existingContainer);
			return;
		}

		await ensureHighlighterCSS();

		const container = document.createElement('div');
		container.id = containerId;
		container.classList.add('is-open');

		const { clipperIframeWidth, clipperIframeHeight } = await browser.storage.local.get(['clipperIframeWidth', 'clipperIframeHeight']);
		if (clipperIframeWidth) {
			container.style.width = `${clipperIframeWidth}px`;
		}
		if (clipperIframeHeight) {
			container.style.height = `${clipperIframeHeight}px`;
		}

		const iframe = document.createElement('iframe');
		iframe.id = iframeId;
		iframe.allow = 'clipboard-write; web-share';
		iframe.src = browser.runtime.getURL('side-panel.html?context=iframe');
		container.appendChild(iframe);

		const resizeCallbacks = {
			onResize: () => highlighter.repositionHighlights(),
			onResizeEnd: () => highlighter.repositionHighlights(),
		};
		addResizeHandle(document, container, 'w', resizeCallbacks);
		addResizeHandle(document, container, 's', resizeCallbacks);
		addResizeHandle(document, container, 'sw', resizeCallbacks);

		document.body.appendChild(container);
		updateSidebarWidth(document, container);
		container.addEventListener('animationend', () => highlighter.repositionHighlights(), { once: true });
	}

	// Firefox
	browser.runtime.sendMessage({ action: "contentScriptLoaded" });

	interface ContentResponse {
		content: string;
		selectedHtml: string;
		extractedContent: { [key: string]: string };
		schemaOrgData: any;
		fullHtml: string;
		highlights: string[];
		title: string;
		description: string;
		domain: string;
		favicon: string;
		image: string;
		parseTime: number;
		published: string;
		author: string;
		site: string;
		wordCount: number;
		language: string;
		metaTags: { name?: string | null; property?: string | null; content: string | null }[];
	}

	interface DefuddleProxyResponse {
		success?: boolean;
		status: number;
		statusText: string;
		headers: Record<string, string>;
		body: string;
		error?: string;
	}

	function headersToObject(headers: HeadersInit | undefined): Record<string, string> {
		if (!headers) return {};
		if (headers instanceof Headers) {
			const result: Record<string, string> = {};
			headers.forEach((value, key) => {
				result[key] = value;
			});
			return result;
		}
		if (Array.isArray(headers)) {
			const result: Record<string, string> = {};
			headers.forEach(([key, value]) => {
				result[key] = String(value);
			});
			return result;
		}
		const result: Record<string, string> = {};
		Object.entries(headers).forEach(([key, value]) => {
			result[key] = String(value);
		});
		return result;
	}

	async function serializeBody(body: BodyInit | null | undefined): Promise<string | undefined> {
		if (body === undefined || body === null) return undefined;
		if (typeof body === 'string') return body;
		if (body instanceof URLSearchParams) return body.toString();
		if (body instanceof Blob) return body.text();
		if (body instanceof ArrayBuffer) {
			return new TextDecoder().decode(body);
		}
		return String(body);
	}

	async function proxyFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
		if (!url) {
			throw new Error('Missing URL.');
		}

		const response = await browser.runtime.sendMessage({
			action: 'defuddleProxyFetch',
			url,
			init: {
				method: init.method || 'GET',
				headers: headersToObject(init.headers),
				body: await serializeBody(init.body),
			},
		}) as DefuddleProxyResponse;

		if (!response || response.success === false) {
			throw new Error(response?.error || 'Extension fetch failed.');
		}

		return new Response(response.body || '', {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	}

	function getDownloadName(result: { title?: string }, sourceUrl: string): string {
		let name = result.title || '';
		if (!name) {
			try {
				const parsed = new URL(sourceUrl);
				name = `${parsed.hostname}${parsed.pathname.replace(/\/$/, '')}`;
			} catch {
				name = 'clipping';
			}
		}

		name = name
			.replace(/&quot;/g, '')
			.replace(/[^a-z0-9]+/gi, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 80);

		return `${name || 'clipping'}.md`;
	}

	async function extractMarkdownForDownload(): Promise<{ markdown: string; filename: string; title?: string }> {
		const flattenTimeout = new Promise<void>(resolve => setTimeout(resolve, 3000));
		await Promise.race([flattenShadowDom(document), flattenTimeout]);

		const snapshot = document.cloneNode(true) as Document;
		try {
			Object.defineProperty(snapshot, 'URL', {
				value: document.URL,
				configurable: true,
			});
		} catch {}

		const defuddle = new Defuddle(snapshot, {
			url: document.URL,
			markdown: true,
			fetch: proxyFetch,
		});
		const parseTimeout = new Promise<never>((_, reject) =>
			setTimeout(() => reject(new Error('parseAsync timeout')), 10000)
		);
		const result = await Promise.race([defuddle.parseAsync(), parseTimeout])
			.catch(() => defuddle.parse());
		const markdown = ((result as { contentMarkdown?: string }).contentMarkdown || result.content || '').trim();

		if (!markdown) {
			throw new Error('No readable content was extracted from this tab.');
		}

		return {
			markdown: `${markdown}\n`,
			filename: getDownloadName(result, document.URL),
			title: result.title || document.title,
		};
	}

	browser.runtime.onMessage.addListener((request: any, sender, sendResponse) => {
		// If a newer generation of this content script has been injected,
		// yield to it rather than responding from a potentially stale context.
		if (window.obsidianClipperGeneration !== myGeneration) {
			return;
		}

		if (request.action === "ping") {
			sendResponse({});
			return true;
		}

		if (request.action === "setClipPageIndicator") {
			ensureHighlighterCSS().then(() => {
				applyClipPageIndicator(request);
				sendResponse({ success: true });
			});
			return true;
		}

		if (request.action === "toggle-iframe") {
			toggleIframe().then(() => {
				sendResponse({ success: true });
			});
			return true;
		}

		if (request.action === "close-iframe") {
			const existingContainer = document.getElementById(containerId);
			if (existingContainer) {
				removeContainer(existingContainer);
			}
			return;
		}

		if (request.action === "copy-text-to-clipboard") {
			const textArea = document.createElement("textarea");
			textArea.value = request.text;
			document.body.appendChild(textArea);
			textArea.select();
			try {
				document.execCommand('copy');
				sendResponse({success: true});
			} catch (err) {
				sendResponse({success: false});
			}
			document.body.removeChild(textArea);
			return true;
		}

		if (request.action === "copyMarkdownToClipboard") {
			flattenShadowDom(document).then(() => {
				try {
					const defuddled = parseForClip(document);

					// Convert HTML content to markdown
					const markdown = createMarkdownContent(defuddled.content, document.URL);

					// Copy to clipboard
					const textArea = document.createElement("textarea");
					textArea.value = markdown;
					document.body.appendChild(textArea);
					textArea.select();
					document.execCommand('copy');
					document.body.removeChild(textArea);

					sendResponse({ success: true });
				} catch (err) {
					console.error('Failed to copy markdown to clipboard:', err);
					sendResponse({ success: false, error: (err as Error).message });
				}
			});
			return true;
		}

		if (request.action === "extractMarkdownForDownload") {
			Promise.resolve().then(async () => {
				try {
					const result = await extractMarkdownForDownload();
					sendResponse({ success: true, ...result });
				} catch (err) {
					console.error('Failed to extract markdown file:', err);
					sendResponse({ success: false, error: (err as Error).message });
				}
			});
			return true;
		}

		if (request.action === "saveMarkdownToFile") {
			Promise.resolve().then(async () => {
				try {
					const { markdown, filename } = await extractMarkdownForDownload();
					const downloadResponse = await browser.runtime.sendMessage({
						action: 'downloadMarkdown',
						markdown,
						filename,
					}) as { success?: boolean; error?: string };
					if (!downloadResponse?.success) {
						throw new Error(downloadResponse?.error || 'Download failed.');
					}
					sendResponse({ success: true });
				} catch (err) {
					console.error('Failed to save markdown file:', err);
					sendResponse({ success: false, error: (err as Error).message });
				}
			});
			return true;
		}

		if (request.action === "getPageContent") {
			// Flatten shadow DOM before extraction (async, needs main world)
			const flattenTimeout = new Promise<void>(resolve => setTimeout(resolve, 3000));
			Promise.race([flattenShadowDom(document), flattenTimeout]).then(async () => {
				let selectedHtml = '';
				const selection = window.getSelection();

				if (selection && selection.rangeCount > 0) {
					const range = selection.getRangeAt(0);
					const clonedSelection = range.cloneContents();
					const div = document.createElement('div');
					div.appendChild(clonedSelection);
					selectedHtml = serializeChildren(div);
				}

				// Use parseAsync to ensure async variables like {{transcript}} are available.
				// If it hangs (e.g. another extension has corrupted fetch), fall back to sync parse.
				const defuddle = new Defuddle(document, { url: document.URL });
				const parseTimeout = new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error('parseAsync timeout')), 8000)
				);
				const defuddled = await Promise.race([defuddle.parseAsync(), parseTimeout])
					.catch(() => defuddle.parse());
				const extractedContent: { [key: string]: string } = {
					...defuddled.variables,
				};

				// Create a new DOMParser
				const parser = new DOMParser();
				// Parse the document's HTML
				const doc = parser.parseFromString(document.documentElement.outerHTML, 'text/html');

				// Remove all script and style elements
				doc.querySelectorAll('script, style').forEach(el => el.remove());

				// Remove style attributes from all elements
				doc.querySelectorAll('*').forEach(el => el.removeAttribute('style'));

				// Convert all relative URLs to absolute
				doc.querySelectorAll('[src], [href]').forEach(element => {
					['src', 'href', 'srcset'].forEach(attr => {
						const value = element.getAttribute(attr);
						if (!value) return;

						if (attr === 'srcset') {
							const newSrcset = value.split(',').map(src => {
								const [url, size] = src.trim().split(' ');
								try {
									const absoluteUrl = new URL(url, document.baseURI).href;
									return `${absoluteUrl}${size ? ' ' + size : ''}`;
								} catch (e) {
									return src;
								}
							}).join(', ');
							element.setAttribute(attr, newSrcset);
						} else if (!value.startsWith('http') && !value.startsWith('data:') && !value.startsWith('#') && !value.startsWith('//')) {
							try {
								const absoluteUrl = new URL(value, document.baseURI).href;
								element.setAttribute(attr, absoluteUrl);
							} catch (e) {
								console.warn(`Failed to process ${attr} URL:`, value);
							}
						}
					});
				});

				// Get the modified HTML without scripts, styles, and style attributes
				const cleanedHtml = doc.documentElement.outerHTML;

				const response: ContentResponse = {
					author: defuddled.author,
					content: defuddled.content,
					description: defuddled.description,
					domain: getDomain(document.URL),
					extractedContent: extractedContent,
					favicon: defuddled.favicon,
					fullHtml: cleanedHtml,
					highlights: highlighter.getHighlights(),
					image: defuddled.image,
					language: defuddled.language || '',
					parseTime: defuddled.parseTime,
					published: defuddled.published,
					schemaOrgData: defuddled.schemaOrgData,
					selectedHtml: selectedHtml,
					site: defuddled.site,
					title: defuddled.title,
					wordCount: defuddled.wordCount,
					metaTags: defuddled.metaTags || []
				};
				if (defuddled.title) {
					highlighter.setPageTitle(defuddled.title);
				}
				highlighter.updatePageDomainSettings({ site: defuddled.site, favicon: defuddled.favicon });
				sendResponse(response);
			}).catch((error: unknown) => {
				console.error('[Obsidian Clipper] getPageContent error:', error);
				sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) });
			});
			return true;
		} else if (request.action === "extractContent") {
			const content = extractContentBySelector(request.selector, request.attribute, request.extractHtml);
			sendResponse({ content: content });
		} else if (request.action === "paintHighlights") {
			ensureHighlighterCSS().then(() => highlighter.loadHighlights()).then(() => {
				if (generalSettings.alwaysShowHighlights) {
					highlighter.applyHighlights();
				}
				sendResponse({ success: true });
			});
			return true;
		} else if (request.action === "setHighlighterMode") {
			isHighlighterMode = request.isActive;
			ensureHighlighterCSS();
			highlighter.toggleHighlighterMenu(isHighlighterMode);
			updateHasHighlights();
			sendResponse({ success: true });
			return true;
		} else if (request.action === "getHighlighterMode") {
			browser.runtime.sendMessage({ action: "getHighlighterMode" }).then(sendResponse);
			return true;
		} else if (request.action === "toggleHighlighter") {
			ensureHighlighterCSS();
			highlighter.toggleHighlighterMenu(request.isActive);
			updateHasHighlights();
			sendResponse({ success: true });
		} else if (request.action === "highlightSelection") {
			ensureHighlighterCSS();
			highlighter.toggleHighlighterMenu(request.isActive);
			const selection = window.getSelection();
			if (selection && !selection.isCollapsed) {
				highlighter.handleTextSelection(selection);
			}
			updateHasHighlights();
			sendResponse({ success: true });
		} else if (request.action === "highlightElement") {
			ensureHighlighterCSS();
			highlighter.toggleHighlighterMenu(request.isActive);
			if (request.targetElementInfo) {
				const { mediaType, srcUrl, pageUrl } = request.targetElementInfo;
				
				let elementToHighlight: Element | null = null;

				// Function to compare URLs, handling both absolute and relative paths
				const urlMatches = (elementSrc: string, targetSrc: string) => {
					const elementUrl = new URL(elementSrc, pageUrl);
					const targetUrl = new URL(targetSrc, pageUrl);
					return elementUrl.href === targetUrl.href;
				};

				// Try to find the element using the src attribute
				elementToHighlight = document.querySelector(`${mediaType}[src="${srcUrl}"]`);

				// If not found, try with relative URL
				if (!elementToHighlight) {
					const relativeSrc = new URL(srcUrl).pathname;
					elementToHighlight = document.querySelector(`${mediaType}[src="${relativeSrc}"]`);
				}

				// If still not found, iterate through all elements of the media type
				if (!elementToHighlight) {
					const elements = Array.from(document.getElementsByTagName(mediaType));
					for (const el of elements) {
						if (el instanceof HTMLImageElement || el instanceof HTMLVideoElement || el instanceof HTMLAudioElement) {
							if (urlMatches(el.src, srcUrl)) {
								elementToHighlight = el;
								break;
							}
						}
					}
				}

				if (elementToHighlight) {
					highlighter.highlightElement(elementToHighlight);
				} else {
					console.warn('Could not find element to highlight. Info:', request.targetElementInfo);
				}
			}
			updateHasHighlights();
			sendResponse({ success: true });
		} else if (request.action === "clearHighlights") {
			highlighter.clearHighlights();
			updateHasHighlights();
			sendResponse({ success: true });
		} else if (request.action === "getHighlighterState") {
			browser.runtime.sendMessage({ action: "getHighlighterMode" })
				.then(response => {
					sendResponse(response);
				})
				.catch(error => {
					console.error("Error getting highlighter mode:", error);
					sendResponse({ isActive: false });
				});
			return true;
		} else if (request.action === "getReaderModeState") {
			sendResponse({ isActive: document.documentElement.classList.contains('obsidian-reader-active') });
			return true;
		}
		return true;
	});

	function extractContentBySelector(selector: string, attribute?: string, extractHtml: boolean = false): string | string[] {
		return extractContentBySelectorShared(document, selector, attribute, extractHtml);
	}

	function updateHasHighlights() {
		const hasHighlights = highlighter.getHighlights().length > 0;
		browser.runtime.sendMessage({ action: "updateHasHighlights", hasHighlights });
	}

	let highlighterCSSPromise: Promise<void> | null = null;
	function ensureHighlighterCSS(): Promise<void> {
		if (!highlighterCSSPromise) {
			highlighterCSSPromise = new Promise<void>((resolve) => {
				const link = document.createElement('link');
				link.rel = 'stylesheet';
				link.href = browser.runtime.getURL('highlighter.css');
				link.onload = () => resolve();
				link.onerror = () => resolve();
				(document.head || document.documentElement).appendChild(link);
			});
		}
		return highlighterCSSPromise;
	}

	async function initializeHighlighter() {
		await loadSettings();

		if (generalSettings.alwaysShowHighlights) {
			const result = await browser.storage.local.get('highlights');
			const allHighlights = (result.highlights || {}) as Record<string, unknown>;
			if (allHighlights[window.location.href]) {
				await ensureHighlighterCSS();
			}
		}

		await highlighter.loadHighlights();
		highlighter.setPageTitle(document.title);
		updateHasHighlights();
	}

	// Initialize highlighter
	initializeHighlighter();

	// Expose highlighter API on window so reader-script.js (a separate
	// webpack bundle injected when reader mode activates) can delegate
	// all state operations to this single module instance. Without this,
	// both bundles own a copy of highlighter.ts with independent mutable
	// state — the bridge ensures one source of truth per tab.
	window.__obsidianHighlighter = {
		toggleHighlighterMenu: highlighter.toggleHighlighterMenu,
		handleTextSelection: highlighter.handleTextSelection,
		highlightElement: highlighter.highlightElement,
		applyHighlights: highlighter.applyHighlights,
		loadHighlights: highlighter.loadHighlights,
		invalidateHighlightCache: highlighter.invalidateHighlightCache,
		repositionHighlights: highlighter.repositionHighlights,
		getHighlights: highlighter.getHighlights,
		setPageUrl: highlighter.setPageUrl,
		setPageTitle: highlighter.setPageTitle,
		updatePageDomainSettings: highlighter.updatePageDomainSettings,
		clearHighlights: highlighter.clearHighlights,
		saveHighlights: highlighter.saveHighlights,
		updateHighlighterMenu: highlighter.updateHighlighterMenu,
		removeExistingHighlights,
		ensureHighlighterCSS: () => { ensureHighlighterCSS(); },
	} satisfies highlighter.HighlighterAPI;

	// Call updateHasHighlights when the page loads
	window.addEventListener('load', updateHasHighlights);
	watchSpaUrlChanges();

	// Deactivate highlighter mode on unload
	function handlePageUnload() {
		if (isHighlighterMode) {
			highlighter.toggleHighlighterMenu(false);
			browser.runtime.sendMessage({ action: "highlighterModeChanged", isActive: false });
			browser.storage.local.set({ isHighlighterMode: false });
		}
	}

	window.addEventListener('beforeunload', handlePageUnload);

	// Listen for custom events from the reader script
	document.addEventListener('obsidian-reader-init', async () => {
		// Find the highlighter button
		const button = document.querySelector('[data-action="toggle-highlighter"]');
		if (button) {
			// Handle highlighter button clicks
			button.addEventListener('click', async (e) => {
				try {
					// First try to get the tab ID from the background script
					const response = await browser.runtime.sendMessage({ action: "ensureContentScriptLoaded" });
					
					let tabId: number | undefined;
					if (response && typeof response === 'object') {
						tabId = (response as { tabId: number }).tabId;
					}

					// If we didn't get a tab ID, try to get it from the background script
					if (!tabId) {
						try {
							const response = await browser.runtime.sendMessage({ action: "getActiveTab" }) as { tabId?: number; error?: string };
							if (response && !response.error && response.tabId) {
								tabId = response.tabId;
							}
						} catch (error) {
							console.error('[Content] Failed to get tab ID from background script:', error);
						}
					}

					if (tabId) {
						await browser.runtime.sendMessage({ action: "toggleHighlighterMode", tabId });
					} else {
						console.error('[Content]','Could not determine tab ID');
					}
				} catch (error) {
					console.error('[Content]','Error in toggle flow:', error);
				}
			});
		}
	});

})();
