import dayjs from 'dayjs';
import { Template, Property, PromptVariable, SavedClipRecord, HistoryEntry } from '../types/types';
import { incrementStat, addHistoryEntry, getClipHistory, getSavedClip, saveSavedClip, mergeSavedClipHighlightIds, findLegacyDuplicateHistory } from '../utils/storage-utils';
import { generateFrontmatter, openSavedClip, SaveToObsidianResult, saveToObsidian } from '../utils/obsidian-note-creator';
import { extractPageContent, initializePageContent } from '../utils/content-extractor';
import { compileTemplate } from '../utils/template-compiler';
import { initializeIcons, getPropertyTypeIcon } from '../icons/icons';
import { findMatchingTemplate, initializeTriggers } from '../utils/triggers';
import { getLocalStorage, setLocalStorage, loadSettings, generalSettings, Settings } from '../utils/storage-utils';
import { escapeHtml, unescapeValue } from '../utils/string-utils';
import { loadTemplates, createDefaultTemplate } from '../managers/template-manager';
import browser from '../utils/browser-polyfill';
import { addBrowserClassToHtml, detectBrowser } from '../utils/browser-detection';
import { createElementWithClass } from '../utils/dom-utils';
import { initializeInterpreter, handleInterpreterUI, collectPromptVariables } from '../utils/interpreter';
import { adjustNoteNameHeight } from '../utils/ui-utils';
import { debugLog } from '../utils/debug';
import { showVariables, initializeVariablesPanel, updateVariablesPanel } from '../managers/inspect-variables';
import { isBlankPage, isValidUrl, isRestrictedUrl } from '../utils/active-tab-manager';
import { memoizeWithExpiration } from '../utils/memoize';
import { debounce } from '../utils/debounce';
import { sanitizeFileName } from '../utils/string-utils';
import { saveFile } from '../utils/file-utils';
import { translatePage, getMessage, setupLanguageAndDirection } from '../utils/i18n';
import { formatPropertyValue } from '../utils/shared';
import type { AnyHighlightData } from '../utils/highlighter';
import { buildHighlightAppendMarkdown, formatSavedClipTarget, getHighlightIds, getNewHighlights } from '../utils/saved-clips';

interface ReaderModeResponse {
	success: boolean;
	isActive: boolean;
}

let loadedSettings: Settings;
let currentTemplate: Template | null = null;
let templates: Template[] = [];
let currentVariables: { [key: string]: string } = {};
let currentTabId: number | undefined;
let lastSelectedVault: string | null = null;
let currentHighlights: AnyHighlightData[] = [];
let currentSavedClip: SavedClipRecord | null = null;
let currentLegacyDuplicate: HistoryEntry | null = null;
let successCloseTimer: number | undefined;

const isSidePanel = window.location.pathname.includes('side-panel.html');
const urlParams = new URLSearchParams(window.location.search);
const isIframe = urlParams.get('context') === 'iframe';

// Memoize compileTemplate with a short expiration and URL-sensitive key
const memoizedCompileTemplate = memoizeWithExpiration(
	async (tabId: number, template: string, variables: { [key: string]: string }, currentUrl: string) => {
		return compileTemplate(tabId, template, variables, currentUrl);
	},
	{
		expirationMs: 5000,
		keyFn: (tabId: number, template: string, variables: { [key: string]: string }, currentUrl: string) =>
			`${tabId}-${template}-${currentUrl}`
	}
);

// Memoize generateFrontmatter with a longer expiration
const memoizedGenerateFrontmatter = memoizeWithExpiration(
	async (properties: Property[]) => {
		return generateFrontmatter(properties);
	},
	{ expirationMs: 5000 }
);

function getPropertiesFromDOM(): Property[] {
	return Array.from(document.querySelectorAll('.metadata-property input')).map(input => {
		const inputElement = input as HTMLInputElement;
		return {
			id: inputElement.dataset.id || Date.now().toString() + Math.random().toString(36).slice(2, 11),
			name: inputElement.id,
			value: inputElement.type === 'checkbox' ? inputElement.checked : inputElement.value
		};
	}) as Property[];
}

// Helper function to get tab info from background script
async function getTabInfo(tabId: number): Promise<{ id: number; url: string }> {
	const response = await browser.runtime.sendMessage({ action: "getTabInfo", tabId }) as { success?: boolean; tab?: { id: number; url: string }; error?: string };
	if (!response || !response.success || !response.tab) {
		throw new Error((response && response.error) || 'Failed to get tab info');
	}
	// On the reader page, tabs.get() can't see the extension page URL
	// without the tabs permission. Fall back to the readerUrl param
	// passed through the iframe src.
	if (!response.tab.url) {
		const readerUrl = urlParams.get('readerUrl');
		if (readerUrl) {
			response.tab.url = readerUrl;
		}
	}
	return response.tab;
}

// Helper function to get current tab URL and title for stats
async function getCurrentTabInfo(): Promise<{ url: string; title?: string }> {
	if (!currentTabId) {
		return { url: '' };
	}
	
	try {
		const tab = await getTabInfo(currentTabId);
		// Try to get the title from the extracted content if available
		const extractedData = await memoizedExtractPageContent(currentTabId);
		return { 
			url: tab.url, 
			title: extractedData?.title || document.title 
		};
	} catch (error) {
		console.warn('Failed to get current tab info for stats:', error);
		return { url: '' };
	}
}

// Memoize extractPageContent with URL-sensitive key
const memoizedExtractPageContent = memoizeWithExpiration(
	async (tabId: number) => {
		await getTabInfo(tabId);
		return extractPageContent(tabId);
	},
	{
		expirationMs: 5000,
		keyFn: async (tabId: number) => {
			const tab = await getTabInfo(tabId);
			return `${tabId}-${tab.url}`;
		}
	}
);

// Width is used to update the note name field height
let previousWidth = window.innerWidth;

function setPopupDimensions() {
	// Get the actual height of the popup after the browser has determined its maximum
	const actualHeight = document.documentElement.offsetHeight;
	
	// Calculate the viewport height and width
	const viewportHeight = window.innerHeight;
	const viewportWidth = window.innerWidth;
	
	// Use the smaller of the two heights
	const finalHeight = Math.min(actualHeight, viewportHeight);
	
	// Set the --popup-height CSS variable to the final height
	document.documentElement.style.setProperty('--chromium-popup-height', `${finalHeight}px`);

	// Check if the width has changed
	if (viewportWidth !== previousWidth) {
		previousWidth = viewportWidth;
		
		// Adjust the note name field height
		const noteNameField = document.getElementById('note-name-field') as HTMLTextAreaElement;
		if (noteNameField) {
			adjustNoteNameHeight(noteNameField);
		}
	}
}

const debouncedSetPopupDimensions = debounce(setPopupDimensions, 100); // 100ms delay

async function initializeExtension(tabId: number) {
	try {
		// Initialize translations
		await translatePage();
		
		// Setup language and RTL support
		await setupLanguageAndDirection();
		
		// First, add the browser class to allow browser-specific styles to apply
		await addBrowserClassToHtml();
		
		// Set an initial large height to allow the browser to determine the maximum height
		// This is necessary for browsers that allow scaling the popup via page zoom
		document.documentElement.style.setProperty('--chromium-popup-height', '2000px');
		
		// Use setTimeout to ensure the DOM has updated before we measure
		setTimeout(() => {
			setPopupDimensions();
		}, 0);

		debugLog('Settings', 'General settings:', loadedSettings);

		templates = await loadTemplates();
		debugLog('Templates', 'Loaded templates:', templates);

		if (templates.length === 0) {
			console.error('No templates loaded');
			return false;
		}

		// Initialize triggers to speed up template matching
		initializeTriggers(templates);

		currentTemplate = templates[0];
		debugLog('Templates', 'Current template set to:', currentTemplate);

		// Load last selected vault
		lastSelectedVault = await getLocalStorage('lastSelectedVault');
		if (!lastSelectedVault && loadedSettings.vaults.length > 0) {
			lastSelectedVault = loadedSettings.vaults[0];
		}
		debugLog('Vaults', 'Last selected vault:', lastSelectedVault);

		const tab = await getTabInfo(tabId);
		if (!tab.url || isBlankPage(tab.url)) {
			showError('pageCannotBeClipped');
			return;
		}
		if (!isValidUrl(tab.url)) {
			showError('onlyHttpSupported');
			return;
		}
		if (isRestrictedUrl(tab.url)) {
			showError('pageCannotBeClipped');
			return;
		}

		// Setup message listeners
		setupMessageListeners();
		setupStorageListeners();

		await checkHighlighterModeState(tabId);

		return true;
	} catch (error) {
		console.error('Error initializing extension:', error);
		showError('failedToInitialize');
		return false;
	}
}

const debouncedHighlightRefresh = debounce(() => {
	if (currentTabId !== undefined) {
		memoizedExtractPageContent.clear();
		memoizedCompileTemplate.clear();
		refreshFields(currentTabId, { checkTemplateTriggers: false, rebuildSkeleton: false });
	}
}, 300);

function setupStorageListeners() {
	browser.storage.local.onChanged.addListener((changes) => {
		if (changes.highlights) {
			debouncedHighlightRefresh();
		}
	});
}

function setupMessageListeners() {
	browser.runtime.onMessage.addListener((request: any, sender: browser.Runtime.MessageSender, sendResponse: (response?: any) => void) => {
		if (request.action === "triggerQuickClip") {
			handleClipObsidian().then(() => {
				sendResponse({success: true});
			}).catch((error) => {
				console.error('Error in handleClipObsidian:', error);
				sendResponse({success: false, error: error.message});
			});
			return true;
		} else if (request.action === "tabUrlChanged") {
			if (request.tabId === currentTabId) {
				if (currentTabId !== undefined) {
					refreshFields(currentTabId);
				}
			}
		} else if (request.action === "activeTabChanged") {
			// Only handle active tab changes if we're in side panel mode, not iframe mode
			if (!isIframe) {
				currentTabId = request.tabId;
				if (request.isRestrictedUrl) {
					showError('pageCannotBeClipped');
				} else if (request.isValidUrl) {
					if (currentTabId !== undefined) {
						refreshFields(currentTabId); // Force template check when URL changes
					}
				} else if (request.isBlankPage) {
					showError('pageCannotBeClipped');
				} else {
					showError('onlyHttpSupported');
				}
			}
		} else if (request.action === "updatePopupHighlighterUI") {
			// This message is now handled by checkHighlighterModeState
		} else if (request.action === "highlighterModeChanged") {
			// This message is now handled by checkHighlighterModeState
		}
	});
}

document.addEventListener('DOMContentLoaded', async function() {
	loadedSettings = await loadSettings();
	if (isIframe) {
		document.documentElement.classList.add('is-embedded');
	}

	const isSidePanel = document.documentElement.classList.contains('is-side-panel');

	try {
		// Get the active tab via background script to handle Firefox compatibility
		const response = await browser.runtime.sendMessage({ action: "getActiveTab" }) as { tabId?: number; error?: string };
		if (!response || response.error || !response.tabId) {
			showError(getMessage('pleaseReload'));
			return;
		}
		
		currentTabId = response.tabId;
		const tab = await getTabInfo(currentTabId);
		const currentBrowser = await detectBrowser();
		const isMobile = currentBrowser === 'mobile-safari';

		const openBehavior: Settings['openBehavior'] = isMobile && loadedSettings.openBehavior !== 'reader' ? 'popup' : loadedSettings.openBehavior;

		// Check if we should open in an iframe, but only if the URL is valid
		if (isValidUrl(tab.url) && !isBlankPage(tab.url) && openBehavior === 'embedded' && !isIframe && !isSidePanel) {
			try {
				const response = await browser.runtime.sendMessage({ action: "getActiveTabAndToggleIframe" }) as { success?: boolean; error?: string };
				if (response && response.success) {
					window.close();
					return; // Exit script after closing the window
				} else if (response && response.error) {
					console.error('Error toggling iframe:', response.error);
					// If there's an error, we'll fall through and open the normal popup.
				}
			} catch (error) {
				console.error('Error toggling iframe:', error);
				// If there's an error, we'll fall through and open the normal popup.
			}
		}

		// Check if we should open in reader mode
		if (isValidUrl(tab.url) && !isBlankPage(tab.url) && openBehavior === 'reader' && !isIframe && !isSidePanel) {
			try {
				const response = await browser.runtime.sendMessage({
					action: "toggleReaderMode",
					tabId: currentTabId
				}) as ReaderModeResponse;
				if (response && response.success) {
					window.close();
					return;
				}
			} catch (error) {
				console.error('Error toggling reader mode:', error);
				// If there's an error, we'll fall through and open the normal popup.
			}
		}

		// Connect to the background script for communication
		browser.runtime.connect({ name: 'popup' });

		// Setup event listeners for popup buttons
		const refreshButton = document.getElementById('refresh-pane');
		if (refreshButton) {
			if (isIframe) {
				refreshButton.style.display = 'none';
			} else {
				refreshButton.addEventListener('click', (e) => {
					e.preventDefault();
					refreshPopup();
					initializeIcons(refreshButton);
				});
			}
		}
		const settingsButton = document.getElementById('open-settings');
		if (settingsButton) {
			settingsButton.addEventListener('click', async function() {
				try {
					await browser.runtime.sendMessage({ action: "openOptionsPage" });
					setTimeout(() => window.close(), 50);
				} catch (error) {
					console.error('Error opening options page:', error);
				}
			});
			initializeIcons(settingsButton);
		}

		// Initialize the rest of the popup
		if (currentTabId) {
			const initialized = await initializeExtension(currentTabId);
			if (!initialized) {
				return;
			}

			try {
				// DOM-dependent initializations
				updateVaultDropdown(loadedSettings.vaults);
				populateTemplateDropdown();
				setupEventListeners(currentTabId);
				await initializeUI();

				determineMainAction();

				const showMoreActionsButton = document.getElementById('show-variables');
				if (showMoreActionsButton) {
					showMoreActionsButton.addEventListener('click', (e) => {
						e.preventDefault();
						showVariables();
					});
				}

				// Initial content load
				await refreshFields(currentTabId);
			} catch (error) {
				console.error('Error initializing popup:', error);
				showError(getMessage('pleaseReload'));
			}
		} else {
			showError(getMessage('pleaseReload'));
		}
	} catch (error) {
		console.error('Error getting active tab:', error);
		showError(getMessage('pleaseReload'));
	}
});

function setupEventListeners(tabId: number) {
	const templateDropdown = document.getElementById('template-select') as HTMLSelectElement;
	if (templateDropdown) {
		templateDropdown.addEventListener('change', function(this: HTMLSelectElement) {
			handleTemplateChange(this.value);
		});
	}

	const noteNameField = document.getElementById('note-name-field') as HTMLTextAreaElement;
	if (noteNameField) {
		noteNameField.addEventListener('input', () => adjustNoteNameHeight(noteNameField));
		noteNameField.addEventListener('keydown', function(e) {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
			}
		});
	}

	const highlighterModeButton = document.getElementById('highlighter-mode');
	if (highlighterModeButton) {
		highlighterModeButton.addEventListener('click', () => toggleHighlighterMode(tabId));
	}

	const embeddedModeButton = document.getElementById('embedded-mode');
		if (embeddedModeButton) {
			embeddedModeButton.addEventListener('click', async function() {
				try {
					await browser.runtime.sendMessage({ action: "getActiveTabAndToggleIframe" });
					setTimeout(() => window.close(), 50);
				} catch (error) {
					console.error('Error toggling emedded iframe:', error);
				}
			});
		}

	const moreButton = document.getElementById('more-btn');
	const moreDropdown = document.getElementById('more-dropdown');
	const copyContentButton = document.getElementById('copy-content');
	const saveDownloadsButton = document.getElementById('save-downloads');
	const shareContentButton = document.getElementById('share-content');

	if (moreButton && moreDropdown) {
		moreButton.addEventListener('click', (e) => {
			e.stopPropagation();
			moreDropdown.classList.toggle('show');
		});

		// Close dropdown when clicking outside
		document.addEventListener('click', (e) => {
			if (!moreButton.contains(e.target as Node)) {
				moreDropdown.classList.remove('show');
			}
		});
	}

	if (copyContentButton) {
		copyContentButton.addEventListener('click', async () => {
			const properties = getPropertiesFromDOM();

			const noteContentField = document.getElementById('note-content-field') as HTMLTextAreaElement;
			const frontmatter = await generateFrontmatter(properties);
			const fileContent = frontmatter + noteContentField.value;
			
			await copyToClipboard(fileContent);
		});
	}

	if (saveDownloadsButton) {
		saveDownloadsButton.addEventListener('click', handleSaveToDownloads);
	}

	const shareButtons = document.querySelectorAll('.share-content');
	if (shareButtons) {
		shareButtons.forEach(button => {
			button.addEventListener('click', async (e) => {
				// Get content synchronously
				const properties = getPropertiesFromDOM();

				const noteContentField = document.getElementById('note-content-field') as HTMLTextAreaElement;
				
				// Use Promise.all to prepare the data
				Promise.all([
					generateFrontmatter(properties),
					Promise.resolve(noteContentField.value)
				]).then(([frontmatter, noteContent]) => {
					const fileContent = frontmatter + noteContent;
					
					// Call share directly from the click handler
					const noteNameField = document.getElementById('note-name-field') as HTMLInputElement;
					let fileName = noteNameField?.value || 'untitled';
					fileName = sanitizeFileName(fileName);
					if (!fileName.toLowerCase().endsWith('.md')) {
						fileName += '.md';
					}

					if (navigator.share && navigator.canShare) {
						const blob = new Blob([fileContent], { type: 'text/markdown;charset=utf-8' });
						const file = new File([blob], fileName, { type: 'text/markdown;charset=utf-8' });
						
						const shareData = {
							files: [file],
							text: 'Shared from Obsidian Web Clipper'
						};

						if (navigator.canShare(shareData)) {
							const pathField = document.getElementById('path-name-field') as HTMLInputElement;
							const vaultDropdown = document.getElementById('vault-select') as HTMLSelectElement;
							const path = pathField?.value || '';
							const vault = vaultDropdown?.value || '';

							navigator.share(shareData)
								.then(async () => {
									const tabInfo = await getCurrentTabInfo();
									await incrementStat('share', vault, path, tabInfo.url, tabInfo.title);
									const moreDropdown = document.getElementById('more-dropdown');
									if (moreDropdown) {
											moreDropdown.classList.remove('show');
									}
								})
								.catch((error) => {
									console.error('Error sharing:', error);
								});
						}
					}
				});
			});
		});
	}

	const shareButtonElements = document.querySelectorAll('.share-content');
	if (shareButtonElements.length > 0) {
		detectBrowser().then(browser => {
			const isSafariBrowser = ['safari', 'mobile-safari', 'ipad-os'].includes(browser);
			if (!isSafariBrowser || !navigator.share || !navigator.canShare) {
				shareButtonElements.forEach(button => {
					const parentElement = button.closest('.share-btn, .menu-item') as HTMLElement;
					if (parentElement) {
						parentElement.style.display = 'none';
					}
				});
			} else {
				// Test if we can share files (only on Safari)
				try {
					const testFile = new File(["test"], "test.txt", { type: "text/plain" });
					const testShare = { files: [testFile] };
					if (!navigator.canShare(testShare)) {
						throw new Error('canShare returned false');
					}
				} catch {
					shareButtonElements.forEach(button => {
						const parentElement = button.closest('.share-btn, .menu-item') as HTMLElement;
						if (parentElement) {
							parentElement.style.display = 'none';
						}
					});
				}
			}
		});
	}

	const readerModeButton = document.getElementById('reader-mode');
	if (readerModeButton) {
		readerModeButton.addEventListener('click', () => toggleReaderMode(tabId));
		checkReaderModeState(tabId);
	}
}

async function initializeUI() {
	const clipButton = document.getElementById('clip-btn');
	if (clipButton) {
		clipButton.focus();
	} else {
		console.warn('Clip button not found');
	}

	const showMoreActionsButton = document.getElementById('show-variables') as HTMLElement;
	const variablesPanel = document.createElement('div');
	variablesPanel.className = 'variables-panel';
	document.body.appendChild(variablesPanel);

	if (showMoreActionsButton) {
		showMoreActionsButton.addEventListener('click', async (e) => {
			e.preventDefault();
			// Initialize the variables panel with the latest data
			initializeVariablesPanel(variablesPanel, currentTemplate, currentVariables);
			await showVariables();
		});
	}

	if (isSidePanel) {
		browser.runtime.sendMessage({ action: "sidePanelOpened" });
		
		window.addEventListener('unload', () => {
			browser.runtime.sendMessage({ action: "sidePanelClosed" });
		});
	}
}

function showError(messageKey: string): void {
	const errorMessage = document.querySelector('.error-message') as HTMLElement;
	const clipper = document.querySelector('.clipper') as HTMLElement;

	if (errorMessage && clipper) {
		errorMessage.textContent = getMessage(messageKey);
		errorMessage.style.display = 'flex';
		clipper.style.display = 'none';

		document.body.classList.add('has-error');
	}
}
function clearError(): void {
	const errorMessage = document.querySelector('.error-message') as HTMLElement;
	const clipper = document.querySelector('.clipper') as HTMLElement;

	if (errorMessage && clipper) {
		errorMessage.style.display = 'none';
		clipper.style.display = 'block';

		document.body.classList.remove('has-error');
	}
}

function createFeedbackButton(label: string, onClick: () => void | Promise<void>, isPrimary = false): HTMLButtonElement {
	const button = document.createElement('button');
	button.type = 'button';
	button.textContent = label;
	if (isPrimary) button.classList.add('mod-cta');
	button.addEventListener('click', () => {
		Promise.resolve(onClick()).catch((error) => {
			console.error('Feedback action failed:', error);
			showError('failedToSaveFile');
		});
	});
	return button;
}

function setPanelContent(panel: HTMLElement, className: string, title: string, detail: string, actions: HTMLButtonElement[] = []): void {
	panel.className = className;
	panel.textContent = '';

	const titleEl = document.createElement('div');
	titleEl.className = 'clip-feedback-title';
	titleEl.textContent = title;
	panel.appendChild(titleEl);

	if (detail) {
		const detailEl = document.createElement('div');
		detailEl.className = 'clip-feedback-detail';
		detailEl.textContent = detail;
		panel.appendChild(detailEl);
	}

	if (actions.length > 0) {
		const actionsEl = document.createElement('div');
		actionsEl.className = 'clip-feedback-actions';
		actions.forEach(action => actionsEl.appendChild(action));
		panel.appendChild(actionsEl);
	}

	panel.hidden = false;
}

function hideDuplicateFeedback(): void {
	const banner = document.getElementById('duplicate-clip-banner') as HTMLElement | null;
	if (banner) {
		banner.hidden = true;
		banner.textContent = '';
	}
}

function hideSaveSuccess(): void {
	const panel = document.getElementById('save-status-panel') as HTMLElement | null;
	if (panel) {
		panel.hidden = true;
		panel.textContent = '';
	}
	if (successCloseTimer) {
		window.clearTimeout(successCloseTimer);
		successCloseTimer = undefined;
	}
}

function getSavedClipNewHighlights(): AnyHighlightData[] {
	if (!currentSavedClip) return [];
	return getNewHighlights(currentHighlights, currentSavedClip.savedHighlightIds || []);
}

async function openCurrentSavedClip(): Promise<void> {
	if (!currentSavedClip?.openUri) return;
	await openSavedClip(currentSavedClip.openUri);
}

async function appendNewHighlightsToSavedClip(): Promise<void> {
	if (!currentSavedClip || !currentTemplate) return;
	const newHighlights = getSavedClipNewHighlights();
	if (newHighlights.length === 0) {
		await openCurrentSavedClip();
		return;
	}

	const tabInfo = await getCurrentTabInfo();
	const appendContent = buildHighlightAppendMarkdown(newHighlights, tabInfo.url);
	const appendBehavior = currentSavedClip.behavior === 'append-daily' || currentSavedClip.behavior === 'prepend-daily'
		? 'append-daily'
		: 'append-specific';
	const result = await saveToObsidian(
		appendContent,
		currentSavedClip.noteName,
		currentSavedClip.path,
		currentSavedClip.vault,
		appendBehavior
	);
	const updatedRecord = await mergeSavedClipHighlightIds(tabInfo.url, getHighlightIds(newHighlights));
	if (updatedRecord) currentSavedClip = updatedRecord;
	const savedClip = currentSavedClip;
	if (!savedClip) return;
	await incrementStat('addToObsidian', savedClip.vault, savedClip.path, tabInfo.url, tabInfo.title);
	hideDuplicateFeedback();
	determineMainAction();
	showSaveSuccess(result, savedClip);
	await notifyPageClipStatus('saved', savedClip);
}

function applyDuplicateMainAction(): void {
	const mainButton = document.getElementById('clip-btn') as HTMLButtonElement | null;
	const moreDropdown = document.getElementById('more-dropdown');
	const secondaryActions = moreDropdown?.querySelector('.secondary-actions');
	if (!mainButton || !secondaryActions) return;

	if (currentSavedClip) {
		if (currentSavedClip.kind === 'download') {
			secondaryActions.textContent = '';
			mainButton.textContent = 'Already downloaded';
			mainButton.disabled = true;
			mainButton.onclick = null;
			return;
		}
		const newHighlights = getSavedClipNewHighlights();
		secondaryActions.textContent = '';
		if (newHighlights.length > 0) {
			mainButton.textContent = 'Append highlights';
			mainButton.onclick = () => appendNewHighlightsToSavedClip();
			addSecondaryAction(secondaryActions, 'openNote', () => openCurrentSavedClip());
		} else {
			mainButton.textContent = 'Open note';
			mainButton.onclick = () => openCurrentSavedClip();
		}
		addSecondaryAction(secondaryActions, 'saveCopy', () => handleClipObsidian({ forceCopy: true }));
		return;
	}

	if (currentLegacyDuplicate) {
		secondaryActions.textContent = '';
		mainButton.textContent = 'Save copy';
		mainButton.onclick = () => handleClipObsidian({ forceCopy: true });
	}
}

function renderDuplicateFeedback(): void {
	const banner = document.getElementById('duplicate-clip-banner') as HTMLElement | null;
	if (!banner) return;

	if (currentSavedClip) {
		if (currentSavedClip.kind === 'download') {
			const filename = currentSavedClip.filename || currentSavedClip.noteFile || '';
			const savedAt = currentSavedClip.lastSavedAt ? dayjs(currentSavedClip.lastSavedAt).format('YYYY-MM-DD HH:mm') : '';
			setPanelContent(
				banner,
				'clip-feedback-banner is-warning',
				'Already downloaded',
				[filename, savedAt ? `Downloaded ${savedAt}` : ''].filter(Boolean).join(' - '),
				[createFeedbackButton('Dismiss', hideDuplicateFeedback, true)]
			);
			applyDuplicateMainAction();
			return;
		}
		const newHighlights = getSavedClipNewHighlights();
		const target = formatSavedClipTarget(currentSavedClip) || 'Obsidian';
		const savedAt = currentSavedClip.lastSavedAt ? dayjs(currentSavedClip.lastSavedAt).format('YYYY-MM-DD HH:mm') : '';
		const actions = newHighlights.length > 0
			? [
				createFeedbackButton('Append highlights', appendNewHighlightsToSavedClip, true),
				createFeedbackButton('Open note', openCurrentSavedClip),
				createFeedbackButton('Save copy', () => handleClipObsidian({ forceCopy: true })),
			]
			: [
				createFeedbackButton('Open note', openCurrentSavedClip, true),
				createFeedbackButton('Save copy', () => handleClipObsidian({ forceCopy: true })),
			];

		setPanelContent(
			banner,
			'clip-feedback-banner is-warning',
			`Already clipped to ${target}`,
			savedAt ? `Saved ${savedAt}` : '',
			actions
		);
		applyDuplicateMainAction();
		return;
	}

	if (currentLegacyDuplicate) {
		const savedAt = currentLegacyDuplicate.datetime ? dayjs(currentLegacyDuplicate.datetime).format('YYYY-MM-DD HH:mm') : '';
		setPanelContent(
			banner,
			'clip-feedback-banner is-warning',
			'Already clipped',
			savedAt ? `Older history entry from ${savedAt}. Open note and append are unavailable for this record.` : 'Older history entry found. Open note and append are unavailable for this record.',
			[createFeedbackButton('Save copy', () => handleClipObsidian({ forceCopy: true }), true)]
		);
		applyDuplicateMainAction();
	}
}

async function refreshSavedClipFeedback(url?: string): Promise<void> {
	if (!url) return;
	currentSavedClip = await getSavedClip(url);
	currentLegacyDuplicate = currentSavedClip ? null : await findLegacyDuplicateHistory(url);

	hideSaveSuccess();
	if (currentSavedClip || currentLegacyDuplicate) {
		renderDuplicateFeedback();
		const status = currentSavedClip && getSavedClipNewHighlights().length > 0 ? 'duplicate' : 'saved';
		await notifyPageClipStatus(status, currentSavedClip || undefined, false);
	} else {
		hideDuplicateFeedback();
		determineMainAction();
		await notifyPageClipStatus('none', undefined, false);
	}
}

function showSaveSuccess(result: SaveToObsidianResult, record?: SavedClipRecord): void {
	const panel = document.getElementById('save-status-panel') as HTMLElement | null;
	if (!panel) return;

	const target = [result.vault, result.noteFile].filter(Boolean).join(' / ');
	setPanelContent(
		panel,
		'clip-status-panel is-success',
		result.vault ? `Saved to ${result.vault}` : 'Saved to Obsidian',
		result.noteFile || target,
		[
			createFeedbackButton('Open note', async () => { await openSavedClip(record?.openUri || result.openUri); }, true),
			createFeedbackButton('Dismiss', hideSaveSuccess),
		]
	);

	if (!isSidePanel && !isIframe) {
		const cancelClose = () => {
			if (successCloseTimer) {
				window.clearTimeout(successCloseTimer);
				successCloseTimer = undefined;
			}
		};
		panel.addEventListener('mouseenter', cancelClose, { once: true });
		panel.addEventListener('focusin', cancelClose, { once: true });
		successCloseTimer = window.setTimeout(() => window.close(), 4000);
	}
}

async function notifyPageClipStatus(status: 'none' | 'saved' | 'duplicate' | 'failed', record?: SavedClipRecord, showToast = true): Promise<void> {
	if (!currentTabId) return;

	browser.runtime.sendMessage({
		action: 'setClipBadgeStatus',
		tabId: currentTabId,
		status,
	}).catch(() => undefined);

	const message = {
		action: 'setClipPageIndicator',
		status,
		showToast,
		showSavedPageIndicator: loadedSettings?.showSavedPageIndicator ?? true,
		changeSavedPageFavicon: loadedSettings?.changeSavedPageFavicon ?? true,
		savedClip: record,
	};

	browser.runtime.sendMessage({
		action: 'sendMessageToTab',
		tabId: currentTabId,
		message,
	}).catch(() => undefined);
}

function logError(message: string, error?: any): void {
	console.error(message, error);
	showError(message);
}

async function waitForInterpreter(interpretBtn: HTMLButtonElement): Promise<void> {
	return new Promise((resolve, reject) => {
		const checkProcessing = () => {
			if (!interpretBtn.classList.contains('processing')) {
				if (interpretBtn.classList.contains('done')) {
					resolve();
				} else if (interpretBtn.classList.contains('error')) {
					reject(new Error(getMessage('failedToProcessInterpreter')));
				} else {
					setTimeout(checkProcessing, 100);
				}
			} else {
				setTimeout(checkProcessing, 100);
			}
		};
		checkProcessing();
	});
}

async function refreshFields(tabId: number, { checkTemplateTriggers = true, rebuildSkeleton = true }: { checkTemplateTriggers?: boolean; rebuildSkeleton?: boolean } = {}) {
	if (templates.length === 0) {
		console.warn('No templates available');
		showError('noTemplates');
		return;
	}

	try {
		const tab = await getTabInfo(tabId);
		if (!tab.url || isBlankPage(tab.url)) {
			showError('pageCannotBeClipped');
			return;
		}
		if (!isValidUrl(tab.url)) {
			showError('onlyHttpSupported');
			return;
		}
		if (isRestrictedUrl(tab.url)) {
			showError('pageCannotBeClipped');
			return;
		}

		// Start content extraction (don't await yet)
		const extractionPromise = memoizedExtractPageContent(tabId);

		// Match URL/regex triggers immediately (schema triggers will await extraction)
		if (checkTemplateTriggers) {
			const getSchemaOrgData = async () => {
				const data = await extractionPromise;
				return data?.schemaOrgData;
			};

			const matchedTemplate = await findMatchingTemplate(tab.url, getSchemaOrgData);
			if (matchedTemplate) {
				console.log('Matched template:', matchedTemplate);
				currentTemplate = matchedTemplate;
				updateTemplateDropdown();
			}
		}

		if (rebuildSkeleton) {
			buildTemplateFieldsSkeleton(currentTemplate);
			setupMetadataToggle();
		}

		const extractedData = await extractionPromise;
		if (extractedData) {
			const currentUrl = tab.url;
			currentHighlights = extractedData.highlights || [];

			const initializedContent = await initializePageContent(
				extractedData.content,
				extractedData.selectedHtml,
				extractedData.extractedContent,
				currentUrl,
				extractedData.schemaOrgData,
				extractedData.fullHtml,
				extractedData.highlights || [],
				extractedData.title,
				extractedData.author,
				extractedData.description,
				extractedData.favicon,
				extractedData.image,
				extractedData.published,
				extractedData.site,
				extractedData.wordCount,
				extractedData.language || '',
				extractedData.metaTags
			);
			if (initializedContent) {
				currentVariables = initializedContent.currentVariables;
				console.log('Updated currentVariables:', currentVariables);
				await fillTemplateFieldValues(
					tabId,
					currentTemplate,
					initializedContent.currentVariables,
					extractedData.schemaOrgData
				);

				// Update variables panel if it's open
				updateVariablesPanel(currentTemplate, currentVariables);
				await refreshSavedClipFeedback(currentUrl);
			} else {
				throw new Error('Unable to initialize page content.');
			}
		} else {
			throw new Error('Unable to extract page content.');
		}
	} catch (error) {
		console.error('Error refreshing fields:', error);
		const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
		showError(errorMessage);
	}
}

function updateTemplateDropdown() {
	const templateDropdown = document.getElementById('template-select') as HTMLSelectElement;
	if (templateDropdown && currentTemplate) {
		templateDropdown.value = currentTemplate.id;
	}
}

function populateTemplateDropdown() {
	const templateDropdown = document.getElementById('template-select') as HTMLSelectElement;
	if (templateDropdown && currentTemplate) {
		// Clear existing options
		templateDropdown.textContent = '';
		templates.forEach((template: Template) => {
			const option = document.createElement('option');
			option.value = template.id;
			option.textContent = template.name;
			templateDropdown.appendChild(option);
		});
		templateDropdown.value = currentTemplate.id;
	}
}

function buildTemplateFieldsSkeleton(template: Template | null) {
	if (!template) return;

	// Handle vault selection
	const vaultDropdown = document.getElementById('vault-select') as HTMLSelectElement;
	if (vaultDropdown) {
		if (template.vault) {
			vaultDropdown.value = template.vault;
		} else if (lastSelectedVault) {
			vaultDropdown.value = lastSelectedVault;
		}
	}

	const existingTemplateProperties = document.querySelector('.metadata-properties') as HTMLElement;

	const newTemplateProperties = createElementWithClass('div', 'metadata-properties');

	if (Array.isArray(template.properties)) {
		for (const property of template.properties) {
			const propertyDiv = createElementWithClass('div', 'metadata-property');
			const propertyType = generalSettings.propertyTypes.find(p => p.name === property.name)?.type || 'text';

			// Create metadata property key container
			const metadataPropertyKey = document.createElement('div');
			metadataPropertyKey.className = 'metadata-property-key';

			const propertyIconSpan = document.createElement('span');
			propertyIconSpan.className = 'metadata-property-icon';
			const iconElement = document.createElement('i');
			iconElement.setAttribute('data-lucide', getPropertyTypeIcon(propertyType));
			propertyIconSpan.appendChild(iconElement);

			const propertyLabel = document.createElement('label');
			propertyLabel.setAttribute('for', property.name);
			propertyLabel.textContent = property.name;

			metadataPropertyKey.appendChild(propertyIconSpan);
			metadataPropertyKey.appendChild(propertyLabel);

			// Create metadata property value container with empty input
			const metadataPropertyValue = document.createElement('div');
			metadataPropertyValue.className = 'metadata-property-value';

			const inputElement = document.createElement('input');
			inputElement.id = property.name;
			inputElement.setAttribute('data-type', propertyType);
			inputElement.setAttribute('data-template-value', property.value);
			inputElement.type = propertyType === 'checkbox' ? 'checkbox' : 'text';

			metadataPropertyValue.appendChild(inputElement);

			propertyDiv.appendChild(metadataPropertyKey);
			propertyDiv.appendChild(metadataPropertyValue);
			newTemplateProperties.appendChild(propertyDiv);
		}
	}

	// Replace the existing element
	if (existingTemplateProperties && existingTemplateProperties.parentNode) {
		existingTemplateProperties.parentNode.replaceChild(newTemplateProperties, existingTemplateProperties);
		existingTemplateProperties.remove();
	}

	initializeIcons(newTemplateProperties);

	// Set up note name and path fields with template values
	const noteNameField = document.getElementById('note-name-field') as HTMLTextAreaElement;
	if (noteNameField) {
		noteNameField.setAttribute('data-template-value', template.noteNameFormat);
	}

	const pathField = document.getElementById('path-name-field') as HTMLInputElement;
	const pathContainer = document.querySelector('.vault-path-container') as HTMLElement;
	if (pathField && pathContainer) {
		const isDailyNote = template.behavior === 'append-daily' || template.behavior === 'prepend-daily';
		if (isDailyNote) {
			pathField.style.display = 'none';
		} else {
			pathContainer.style.display = 'flex';
			pathField.setAttribute('data-template-value', template.path);
		}
	}

	const noteContentField = document.getElementById('note-content-field') as HTMLTextAreaElement;
	if (noteContentField) {
		noteContentField.setAttribute('data-template-value', template.noteContentFormat || '');
	}

	// Show/hide interpreter section based on template prompt variables
	const interpreterContainer = document.getElementById('interpreter');
	const interpretBtn = document.getElementById('interpret-btn');
	const hasPromptVars = generalSettings.interpreterEnabled && collectPromptVariables(template).length > 0;
	if (interpreterContainer) interpreterContainer.style.display = hasPromptVars ? 'flex' : 'none';
	if (interpretBtn) interpretBtn.style.display = hasPromptVars ? 'inline-block' : 'none';

	// Populate model dropdown immediately (only needs generalSettings)
	if (hasPromptVars) {
		const modelSelect = document.getElementById('model-select') as HTMLSelectElement;
		if (modelSelect) {
			const enabledModels = generalSettings.models.filter(model => model.enabled);
			modelSelect.textContent = '';
			enabledModels.forEach(model => {
				const option = document.createElement('option');
				option.value = model.id;
				option.textContent = model.name;
				modelSelect.appendChild(option);
			});
			modelSelect.value = generalSettings.interpreterModel || (enabledModels[0]?.id ?? '');
			modelSelect.style.display = 'inline-block';
		}
	}
}

async function fillTemplateFieldValues(currentTabId: number, template: Template | null, variables: { [key: string]: string }, schemaOrgData?: any) {
	if (!template) return;

	const currentUrl = currentTabId ? (await getTabInfo(currentTabId)).url || '' : '';

	currentVariables = variables;

	if (!Array.isArray(template.properties)) return;

	// Compile all templates in parallel
	const [compiledPropertyValues, formattedNoteName, formattedPath, formattedContent] = await Promise.all([
		Promise.all(template.properties.map(property =>
			memoizedCompileTemplate(currentTabId!, unescapeValue(property.value), variables, currentUrl)
		)),
		memoizedCompileTemplate(currentTabId!, template.noteNameFormat, variables, currentUrl),
		memoizedCompileTemplate(currentTabId!, template.path, variables, currentUrl),
		template.noteContentFormat
			? memoizedCompileTemplate(currentTabId!, template.noteContentFormat, variables, currentUrl)
			: Promise.resolve('')
	]);

	// Fill property values into existing DOM elements
	for (let i = 0; i < template.properties.length; i++) {
		const property = template.properties[i];
		const inputElement = document.getElementById(property.name) as HTMLInputElement;
		if (!inputElement) continue;

		let value = compiledPropertyValues[i];
		const propertyType = inputElement.getAttribute('data-type') || 'text';

		// Apply type-specific parsing
		value = formatPropertyValue(value, propertyType, property.value);

		if (propertyType === 'checkbox') {
			inputElement.checked = value === 'true';
		} else {
			inputElement.value = value;
		}
	}

	const noteNameField = document.getElementById('note-name-field') as HTMLTextAreaElement;
	if (noteNameField) {
		noteNameField.value = formattedNoteName.trim();
		adjustNoteNameHeight(noteNameField);
	}

	const pathField = document.getElementById('path-name-field') as HTMLInputElement;
	if (pathField) {
		pathField.value = formattedPath;
	}

	const noteContentField = document.getElementById('note-content-field') as HTMLTextAreaElement;
	if (noteContentField) {
		noteContentField.value = template.noteContentFormat ? formattedContent : '';
	}

	if (generalSettings.interpreterEnabled) {
		await initializeInterpreter(template, variables, currentTabId!, currentUrl);

		const promptVariables = collectPromptVariables(template);

		if (generalSettings.interpreterAutoRun && promptVariables.length > 0) {
			try {
				const interpretBtn = document.getElementById('interpret-btn') as HTMLButtonElement;
				const modelSelect = document.getElementById('model-select') as HTMLSelectElement;
				const selectedModelId = modelSelect?.value || generalSettings.interpreterModel;
				const modelConfig = generalSettings.models.find(m => m.id === selectedModelId);
				if (!modelConfig) {
					throw new Error(`Model configuration not found for ${selectedModelId}`);
				}
				await handleInterpreterUI(template, variables, currentTabId!, currentUrl, modelConfig);

				if (interpretBtn) {
					interpretBtn.classList.add('done');
					interpretBtn.disabled = true;
				}
			} catch (error) {
				console.error('Error auto-processing with interpreter:', error);
				const interpretBtn = document.getElementById('interpret-btn') as HTMLButtonElement;
				if (interpretBtn) {
					interpretBtn.classList.add('error');
				}
			}
		}
	}

	const replacedTemplate = await getReplacedTemplate(template, variables, currentTabId!, currentUrl);
	debugLog('Variables', 'Current template with replaced variables:', JSON.stringify(replacedTemplate, null, 2));
}

function setupMetadataToggle() {
	const metadataHeader = document.querySelector('.metadata-properties-header') as HTMLElement;
	const metadataProperties = document.querySelector('.metadata-properties') as HTMLElement;
	
	if (metadataHeader && metadataProperties) {
		metadataHeader.removeEventListener('click', toggleMetadataProperties);
		metadataHeader.addEventListener('click', toggleMetadataProperties);

		// Set initial state
		getLocalStorage('propertiesCollapsed').then((isCollapsed) => {
			if (isCollapsed === undefined) {
				// If the value is not set, default to not collapsed
				updateMetadataToggleState(false); 
			} else {
				updateMetadataToggleState(isCollapsed);
			}
		});
	}
}

function toggleMetadataProperties() {
	const metadataProperties = document.querySelector('.metadata-properties') as HTMLElement;
	const metadataHeader = document.querySelector('.metadata-properties-header') as HTMLElement;
	
	if (metadataProperties && metadataHeader) {
		const isCollapsed = metadataProperties.classList.toggle('collapsed');
		metadataHeader.classList.toggle('collapsed');
		setLocalStorage('propertiesCollapsed', isCollapsed);
	}
}

function updateMetadataToggleState(isCollapsed: boolean) {
	const metadataProperties = document.querySelector('.metadata-properties') as HTMLElement;
	const metadataHeader = document.querySelector('.metadata-properties-header') as HTMLElement;
	
	if (metadataProperties && metadataHeader) {
		if (isCollapsed) {
			metadataProperties.classList.add('collapsed');
			metadataHeader.classList.add('collapsed');
		} else {
			metadataProperties.classList.remove('collapsed');
			metadataHeader.classList.remove('collapsed');
		}
	}
}

async function getReplacedTemplate(template: Template, variables: { [key: string]: string }, tabId: number, currentUrl: string): Promise<any> {
	const replacedTemplate: any = {
		schemaVersion: "0.1.0",
		name: template.name,
		behavior: template.behavior,
		noteNameFormat: await compileTemplate(tabId, template.noteNameFormat, variables, currentUrl),
		path: template.path,
		noteContentFormat: await compileTemplate(tabId, template.noteContentFormat, variables, currentUrl),
		properties: [],
		triggers: template.triggers
	};

	if (template.context) {
		replacedTemplate.context = await compileTemplate(tabId, template.context, variables, currentUrl);
	}

	for (const prop of template.properties) {
		const replacedProp: Property = {
			id: prop.id,
			name: prop.name,
			value: await compileTemplate(tabId, prop.value, variables, currentUrl)
		};
		replacedTemplate.properties.push(replacedProp);
	}

	return replacedTemplate;
}

function updateVaultDropdown(vaults: string[]) {
	const vaultDropdown = document.getElementById('vault-select') as HTMLSelectElement | null;
	const vaultContainer = document.getElementById('vault-container');

	if (!vaultDropdown || !vaultContainer) return;

	// Clear existing options
	vaultDropdown.textContent = '';
	
	vaults.forEach(vault => {
		const option = document.createElement('option');
		option.value = vault;
		option.textContent = vault;
		vaultDropdown.appendChild(option);
	});

	// Only show vault selector if vaults are defined
	if (vaults.length > 0) {
		vaultContainer.style.display = 'block';
		if (lastSelectedVault && vaults.includes(lastSelectedVault)) {
			vaultDropdown.value = lastSelectedVault;
		} else {
			vaultDropdown.value = vaults[0];
		}
	} else {
		vaultContainer.style.display = 'none';
	}

	// Add event listener to update lastSelectedVault when changed
	vaultDropdown.addEventListener('change', () => {
		lastSelectedVault = vaultDropdown.value;
		setLocalStorage('lastSelectedVault', lastSelectedVault);
	});
}

function refreshPopup() {
	window.location.reload();
}

function handleTemplateChange(templateId: string) {
	currentTemplate = templates.find(t => t.id === templateId) || templates[0];
	refreshFields(currentTabId!, { checkTemplateTriggers: false });
}

function setReaderButtonState(isActive: boolean) {
	const readerButton = document.getElementById('reader-mode');
	if (readerButton) {
		readerButton.classList.toggle('active', isActive);
		readerButton.setAttribute('aria-pressed', isActive.toString());
		readerButton.title = isActive ? getMessage('disableReader') : getMessage('enableReader');
	}
}

async function checkReaderModeState(tabId: number) {
	try {
		// When embedded in a reader.html page, we know reader mode is active
		if (urlParams.get('readerUrl')) {
			setReaderButtonState(true);
			return;
		}

		// Query the actual page DOM via content script rather than
		// relying on background state, which can be stale across tabs
		const response = await browser.runtime.sendMessage({
			action: "sendMessageToTab",
			tabId: tabId,
			message: { action: "getReaderModeState" }
		}) as { isActive: boolean } | undefined;

		setReaderButtonState(response?.isActive ?? false);
	} catch (error) {
		// Tab may not have content script loaded yet
		console.error('Error checking reader mode state:', error);
	}
}

async function checkHighlighterModeState(tabId: number) {
	try {
		const response = await browser.runtime.sendMessage({
			action: "getHighlighterMode",
			tabId: tabId
		}) as { isActive: boolean };

		const isHighlighterMode = response.isActive;
		
		loadedSettings = await loadSettings();
		
		updateHighlighterModeUI(isHighlighterMode);
	} catch (error) {
		console.error('Error checking highlighter mode state:', error);
		// If there's an error, assume highlighter mode is off
		updateHighlighterModeUI(false);
	}
}

async function toggleHighlighterMode(tabId: number) {
	try {
		const response = await browser.runtime.sendMessage({
			action: "toggleHighlighterMode",
			tabId: tabId
		}) as { success: boolean, isActive: boolean, error?: string };

		if (response && response.success) {
			const isNowActive = response.isActive;
			updateHighlighterModeUI(isNowActive);

			// Close the popup if highlighter mode is turned on and not in side panel
			if (isNowActive && !isSidePanel && !isIframe) {
				setTimeout(() => window.close(), 50);
			}
		} else {
			throw new Error(response.error || "Failed to toggle highlighter mode.");
		}
	} catch (error) {
		console.error('Error toggling highlighter mode:', error);
		showError('failedToToggleHighlighter');
	}
}

function updateHighlighterModeUI(isActive: boolean) {
	const highlighterModeButton = document.getElementById('highlighter-mode');
	if (highlighterModeButton) {
		if (generalSettings.highlighterEnabled) {
			highlighterModeButton.style.display = 'flex';
			highlighterModeButton.classList.toggle('active', isActive);
			highlighterModeButton.setAttribute('aria-pressed', isActive.toString());
			highlighterModeButton.title = isActive ? getMessage('disableHighlighter') : getMessage('highlighterOn');
		} else {
			highlighterModeButton.style.display = 'none';
		}
	}
}

async function toggleReaderMode(tabId: number) {
	try {
		// When embedded in a reader.html page, pass the reader URL
		// so the background can navigate away even without tab URL access
		const response = await browser.runtime.sendMessage({
			action: "toggleReaderMode",
			tabId: tabId,
			readerUrl: urlParams.get('readerUrl') || undefined
		}) as ReaderModeResponse;

		if (response && response.success) {
			setReaderButtonState(response.isActive ?? false);
		}

		// Close the popup if not in side panel or iframe
		if (!isSidePanel && !isIframe) {
			window.close();
		}
	} catch (error) {
		console.error('Error toggling reader mode:', error);
		showError('failedToToggleReaderMode');
	}
}

export async function copyToClipboard(content: string) {
	try {
		try {
			await navigator.clipboard.writeText(content);
		} catch {
			await browser.runtime.sendMessage({
				action: 'copy-to-clipboard',
				text: content
			});
		}

		const pathField = document.getElementById('path-name-field') as HTMLInputElement;
		const vaultDropdown = document.getElementById('vault-select') as HTMLSelectElement;
		const path = pathField?.value || '';
		const vault = vaultDropdown?.value || '';
		
		const tabInfo = await getCurrentTabInfo();
		await incrementStat('copyToClipboard', vault, path, tabInfo.url, tabInfo.title);

		// Change the main button text temporarily
		const clipButton = document.getElementById('clip-btn');
		if (clipButton) {
			const originalText = clipButton.textContent || getMessage('addToObsidian');
			clipButton.textContent = getMessage('copied');
			
			// Reset the text after 1.5 seconds
			setTimeout(() => {
				clipButton.textContent = originalText;
			}, 1500);
		}
	} catch (error) {
		console.error('Failed to copy to clipboard:', error);
		showError('failedToCopyText');
	}
}

async function handleSaveToDownloads() {
	try {
		const noteNameField = document.getElementById('note-name-field') as HTMLInputElement;
		const pathField = document.getElementById('path-name-field') as HTMLInputElement;
		const vaultDropdown = document.getElementById('vault-select') as HTMLSelectElement;
		
		let fileName = noteNameField?.value || 'untitled';
		const path = pathField?.value || '';
		const vault = vaultDropdown?.value || '';
		
		const properties = getPropertiesFromDOM();

		const noteContentField = document.getElementById('note-content-field') as HTMLTextAreaElement;
		const frontmatter = await generateFrontmatter(properties);
		const fileContent = frontmatter + noteContentField.value;

		await saveFile({
			content: fileContent,
			fileName,
			mimeType: 'text/markdown',
			tabId: currentTabId,
			onError: (error) => showError('failedToSaveFile')
		});

		const tabInfo = await getCurrentTabInfo();
		await incrementStat('saveFile', vault, path, tabInfo.url, tabInfo.title);

		const moreDropdown = document.getElementById('more-dropdown');
		if (moreDropdown) {
			moreDropdown.classList.remove('show');
		}
	} catch (error) {
		console.error('Failed to save file:', error);
		showError('failedToSaveFile');
	}
}

function determineMainAction() {
	const mainButton = document.getElementById('clip-btn');
	const moreDropdown = document.getElementById('more-dropdown');
	const secondaryActions = moreDropdown?.querySelector('.secondary-actions');
	if (!mainButton || !secondaryActions) return;

	(mainButton as HTMLButtonElement).disabled = false;
	secondaryActions.textContent = '';

	switch (loadedSettings.saveBehavior) {
		case 'copyToClipboard':
			mainButton.textContent = getMessage('copyToClipboard');
			mainButton.onclick = () => copyContent();
			addSecondaryAction(secondaryActions, 'addToObsidian', () => handleClipObsidian());
			addSecondaryAction(secondaryActions, 'saveFile', handleSaveToDownloads);
			break;
		case 'saveFile':
			mainButton.textContent = getMessage('saveFile');
			mainButton.onclick = () => handleSaveToDownloads();
			addSecondaryAction(secondaryActions, 'addToObsidian', () => handleClipObsidian());
			addSecondaryAction(secondaryActions, 'copyToClipboard', copyContent);
			break;
		default:
			mainButton.textContent = getMessage('addToObsidian');
			mainButton.onclick = () => handleClipObsidian();
			addSecondaryAction(secondaryActions, 'copyToClipboard', copyContent);
			addSecondaryAction(secondaryActions, 'saveFile', handleSaveToDownloads);
	}
}

async function handleClipObsidian(options: { forceCopy?: boolean } = {}): Promise<void> {
	if (!currentTemplate) return;

	const vaultDropdown = document.getElementById('vault-select') as HTMLSelectElement;
	const noteContentField = document.getElementById('note-content-field') as HTMLTextAreaElement;
	const noteNameField = document.getElementById('note-name-field') as HTMLInputElement;
	const pathField = document.getElementById('path-name-field') as HTMLInputElement;
	const interpretBtn = document.getElementById('interpret-btn') as HTMLButtonElement;

	if (!vaultDropdown || !noteContentField) {
		showError('Some required fields are missing. Please try reloading the extension.');
		return;
	}

	try {
		// Handle interpreter if needed
		if (generalSettings.interpreterEnabled && interpretBtn && collectPromptVariables(currentTemplate).length > 0) {
			if (interpretBtn.classList.contains('processing')) {
				await waitForInterpreter(interpretBtn);
			} else if (!interpretBtn.classList.contains('done')) {
				interpretBtn.click();
				await waitForInterpreter(interpretBtn);
			}
		}

		// Gather content
		const properties = getPropertiesFromDOM();

		const frontmatter = await generateFrontmatter(properties);
		const fileContent = frontmatter + noteContentField.value;

		// Save to Obsidian
		const selectedVault = vaultDropdown.value || currentTemplate.vault || '';
		const isDailyNote = currentTemplate.behavior === 'append-daily' || currentTemplate.behavior === 'prepend-daily';
		const noteName = isDailyNote ? '' : noteNameField?.value || '';
		const path = isDailyNote ? '' : pathField?.value || '';

		if (!options.forceCopy && currentSavedClip) {
			const newHighlights = getSavedClipNewHighlights();
			if (newHighlights.length > 0) {
				await appendNewHighlightsToSavedClip();
			} else {
				await openCurrentSavedClip();
			}
			return;
		}

		const saveResult = await saveToObsidian(fileContent, noteName, path, selectedVault, currentTemplate.behavior);
		const tabInfo = await getCurrentTabInfo();
		await incrementStat('addToObsidian', selectedVault, path, tabInfo.url, tabInfo.title);
		const savedRecord = await saveSavedClip({
			url: tabInfo.url,
			title: tabInfo.title,
			vault: saveResult.vault,
			path: saveResult.path,
			noteName: saveResult.noteName,
			noteFile: saveResult.noteFile,
			templateId: currentTemplate.id,
			templateName: currentTemplate.name,
			behavior: currentTemplate.behavior,
			savedHighlightIds: getHighlightIds(currentHighlights),
			openUri: saveResult.openUri,
		});
		currentSavedClip = savedRecord;
		currentLegacyDuplicate = null;

		lastSelectedVault = selectedVault;
		await setLocalStorage('lastSelectedVault', lastSelectedVault);

		hideDuplicateFeedback();
		determineMainAction();
		showSaveSuccess(saveResult, savedRecord);
		await notifyPageClipStatus('saved', savedRecord);
	} catch (error) {
		console.error('Error in handleClipObsidian:', error);
		const tabInfo = await getCurrentTabInfo().catch(() => null);
		if (tabInfo?.url) {
			await notifyPageClipStatus('failed', currentSavedClip || undefined);
		}
		showError('failedToSaveFile');
		throw error;
	}
}

function addSecondaryAction(container: Element, actionType: string, handler: () => void) {
	const menuItem = document.createElement('div');
	menuItem.className = 'menu-item';
	
	// Create menu item icon container
	const menuItemIcon = document.createElement('div');
	menuItemIcon.className = 'menu-item-icon';
	
	const iconElement = document.createElement('i');
	iconElement.setAttribute('data-lucide', getActionIcon(actionType));
	menuItemIcon.appendChild(iconElement);
	
	// Create menu item title
	const menuItemTitle = document.createElement('div');
	menuItemTitle.className = 'menu-item-title';
	menuItemTitle.setAttribute('data-i18n', actionType);
	menuItemTitle.textContent = getMessage(actionType);
	
	// Assemble menu item
	menuItem.appendChild(menuItemIcon);
	menuItem.appendChild(menuItemTitle);
	
	menuItem.addEventListener('click', handler);
	container.appendChild(menuItem);
	initializeIcons(menuItem);
}

function getActionIcon(actionType: string): string {
	switch (actionType) {
		case 'copyToClipboard': return 'copy';
		case 'saveFile': return 'file-down';
		case 'addToObsidian': return 'pen-line';
		case 'openNote': return 'external-link';
		case 'saveCopy': return 'copy';
		default: return 'plus';
	}
}

async function copyContent() {
	const properties = getPropertiesFromDOM();

	const noteContentField = document.getElementById('note-content-field') as HTMLTextAreaElement;
	const frontmatter = await generateFrontmatter(properties);
	const fileContent = frontmatter + noteContentField.value;
	await copyToClipboard(fileContent);
}

// Update the resize event listener to use the debounced version
window.addEventListener('resize', debouncedSetPopupDimensions);
