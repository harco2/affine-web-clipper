import dayjs from 'dayjs';
import { Template, Property, PromptVariable } from '../types/types';
import { incrementStat, addHistoryEntry, getClipHistory } from '../utils/storage-utils';
import { generateFrontmatter, saveToObsidian } from '../utils/obsidian-note-creator';
import { extractPageContent, initializePageContent } from '../utils/content-extractor';
import { compileTemplate } from '../utils/template-compiler';
import { initializeIcons, getPropertyTypeIcon } from '../icons/icons';
import { decompressFromUTF16 } from 'lz-string';
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
import { ensureContentScriptLoaded } from '../utils/content-script-utils';
import { isBlankPage, isValidUrl } from '../utils/active-tab-manager';
import { memoizeWithExpiration } from '../utils/memoize';
import { debounce } from '../utils/debounce';
import { sanitizeFileName } from '../utils/string-utils';
import { saveFile } from '../utils/file-utils';
import { translatePage, getMessage, setupLanguageAndDirection } from '../utils/i18n';
import { saveToAFFiNE } from '../utils/affine-note-creator';

let loadedSettings: Settings;
let currentTemplate: Template | null = null;
let templates: Template[] = [];
let currentVariables: { [key: string]: string } = {};
let currentTabId: number | undefined;
let lastSelectedVault: string | null = null;
let isHighlighterMode = false;

const isSidePanel = window.location.pathname.includes('side-panel.html');

// Memoize compileTemplate with a short expiration and URL-sensitive key
const memoizedCompileTemplate = memoizeWithExpiration(
	async (tabId: number, template: string, variables: { [key: string]: string }, currentUrl: string) => {
		return compileTemplate(tabId, template, variables, currentUrl);
	},
	{
		expirationMs: 50,
		keyFn: (tabId: number, template: string, variables: { [key: string]: string }, currentUrl: string) => 
			`${tabId}-${template}-${currentUrl}`
	}
);

// Memoize generateFrontmatter with a longer expiration
const memoizedGenerateFrontmatter = memoizeWithExpiration(
	async (properties: Property[]) => {
		return generateFrontmatter(properties);
	},
	{ expirationMs: 50 }
);

// Memoize extractPageContent with URL-sensitive key and short expiration
const memoizedExtractPageContent = memoizeWithExpiration(
	async (tabId: number) => {
		const tab = await browser.tabs.get(tabId);
		return extractPageContent(tabId);
	},
	{ 
		expirationMs: 50, 
		keyFn: async (tabId: number) => {
			const tab = await browser.tabs.get(tabId);
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

		loadedSettings = await loadSettings();
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

		updateVaultDropdown(loadedSettings.vaults);

		const tab = await browser.tabs.get(tabId);
		if (!tab.url || isBlankPage(tab.url)) {
			showError('pageCannotBeClipped');
			return;
		}
		if (!isValidUrl(tab.url)) {
			showError('onlyHttpSupported');
			return;
		}
		await ensureContentScriptLoaded(tabId);

		await loadAndSetupTemplates();

		// Setup message listeners
		setupMessageListeners();

		await checkHighlighterModeState(tabId);

		return true;
	} catch (error) {
		console.error('Error initializing extension:', error);
		showError('failedToInitialize');
		return false;
	}
}

async function loadAndSetupTemplates() {
	const data = await browser.storage.sync.get(['template_list']);
	const templateIds = data.template_list || [];
	const loadedTemplates = await Promise.all((templateIds as string[]).map(async (id: string) => {
		try {
			const result = await browser.storage.sync.get(`template_${id}`);
			const compressedChunks = result[`template_${id}`] as string[];
			if (compressedChunks) {
				const decompressedData = decompressFromUTF16(compressedChunks.join(''));
				const template = JSON.parse(decompressedData);
				if (template && Array.isArray(template.properties)) {
					return template;
				}
			}
		} catch (error) {
			console.error(`Error parsing template ${id}:`, error);
		}
		return null;
	}));

	templates = loadedTemplates.filter((t: Template | null): t is Template => t !== null);

	if (templates.length === 0) {
		currentTemplate = createDefaultTemplate();
		templates = [currentTemplate];
	} else {
		currentTemplate = templates[0];
	}

	currentTemplate.properties = []; // TODO: determine what to do with properties
}

function setupMessageListeners() {
	browser.runtime.onMessage.addListener((request: any, sender: browser.Runtime.MessageSender, sendResponse: (response?: any) => void) => {
		if (request.action === "triggerQuickClip") {
			handleClip().then(() => {
				sendResponse({success: true});
			}).catch((error) => {
				console.error('Error in handleClip:', error);
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
			currentTabId = request.tabId;
			if (request.isValidUrl) {
				if (currentTabId !== undefined) {
					refreshFields(currentTabId); // Force template check when URL changes
				}
			} else if (request.isBlankPage) {
				showError(getMessage('pageCannotBeClipped'));
			} else {
				showError(getMessage('onlyHttpSupported'));
			}
		} else if (request.action === "highlightsUpdated") {
			// Refresh fields when highlights are updated
			if (currentTabId !== undefined) {
				refreshFields(currentTabId);
			}
		} else if (request.action === "updatePopupHighlighterUI") {
			isHighlighterMode = request.isActive;
			updateHighlighterModeUI(request.isActive);
		} else if (request.action === "highlighterModeChanged") {
			isHighlighterMode = request.isActive;
			updateHighlighterModeUI(isHighlighterMode);
		}
	});
}

document.addEventListener('DOMContentLoaded', async function() {
	browser.runtime.connect({ name: 'popup' });

	const refreshButton = document.getElementById('refresh-pane');
	if (refreshButton) {
		refreshButton.addEventListener('click', (e) => {
			e.preventDefault();
			refreshPopup();
			initializeIcons(refreshButton);
		});
	}
	const settingsButton = document.getElementById('open-settings');
	if (settingsButton) {
		settingsButton.addEventListener('click', async function() {
			browser.runtime.openOptionsPage();
			setTimeout(() => window.close(), 50);
		});
		initializeIcons(settingsButton);
	}

	const tabs = await browser.tabs.query({active: true, currentWindow: true});
	const currentTab = tabs[0];
	currentTabId = currentTab?.id;

	if (currentTabId) {
		try {		
			const initialized = await initializeExtension(currentTabId);
			if (!initialized) {
				showError(getMessage('pageCannotBeClipped'));
				return;
			}

			// DOM-dependent initializations
			updateVaultDropdown(loadedSettings.vaults);
			populateTemplateDropdown();
			populateMetadataDropdowns();
			setupEventListeners(currentTabId);
			await initializeUI();
			setupMetadataToggle();

			// Initial content load
			await refreshFields(currentTabId);

			const showMoreActionsButton = document.getElementById('show-variables');
			if (showMoreActionsButton) {
					showMoreActionsButton.addEventListener('click', (e) => {
						e.preventDefault();
						showVariables();
					});
			}

		} catch (error) {
			console.error('Error initializing popup:', error);
			showError(getMessage('pleaseReloadPage'));
		}
	} else {
		showError(getMessage('pleaseReloadPage'));
	}
});

function setupEventListeners(tabId: number) {
	const templateDropdown = document.getElementById('template-select') as HTMLSelectElement;
	if (templateDropdown) {
		templateDropdown.addEventListener('change', function(this: HTMLSelectElement) {
			handleTemplateChange(this.value);
		});
	}

	const destinationDropdown = document.getElementById('destination-select') as HTMLSelectElement;
	if (destinationDropdown) {
		destinationDropdown.addEventListener('change', function(this: HTMLSelectElement) {
			handleDestinationChange(this.value);
		})
	}

	const cloudDestinationDropdown = document.getElementById('cloud-destination-select') as HTMLSelectElement;
	if (cloudDestinationDropdown) {
		let lastValue = cloudDestinationDropdown.value;
		cloudDestinationDropdown.addEventListener('change', function(this: HTMLSelectElement) {
			if (this.value === 'add-new') {
				this.value = lastValue;
				openNewDestinationDialog();
			} else {
				lastValue = this.value;
				handleCloudDestinationChange(this.value);
			}
		})
	}

	const cloudDestinationDialogWrapper = document.getElementById('destination-dialog-wrapper') as HTMLDivElement;
	if (cloudDestinationDialogWrapper) {
		cloudDestinationDialogWrapper.addEventListener('click', function(e) {
			if (e.target === cloudDestinationDialogWrapper) {
				const clipperContainer = document.getElementById("destination-dialog-wrapper");
				if (!clipperContainer) return;
				clipperContainer.style.display = 'none';
			}
		})
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

	const addServerButton = document.getElementById("add-server-btn") as HTMLButtonElement;
	if (addServerButton) {
		addServerButton.addEventListener("click", () => {
			saveSelfHostedCloud();
		})
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
			const properties = Array.from(document.querySelectorAll('.metadata-property input')).map(input => {
				const inputElement = input as HTMLInputElement;
				return {
					id: inputElement.dataset.id || Date.now().toString() + Math.random().toString(36).slice(2, 11),
					name: inputElement.id,
					value: inputElement.type === 'checkbox' ? inputElement.checked : inputElement.value
				};
			}) as Property[];

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
				const properties = Array.from(document.querySelectorAll('.metadata-property input')).map(input => {
					const inputElement = input as HTMLInputElement;
					return {
						id: inputElement.dataset.id || Date.now().toString() + Math.random().toString(36).slice(2, 11),
						name: inputElement.id,
						value: inputElement.type === 'checkbox' ? inputElement.checked : inputElement.value
					};
				}) as Property[];

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
							text: 'Shared from AFFiNE Web Clipper'
						};

						if (navigator.canShare(shareData)) {
							const pathField = document.getElementById('path-name-field') as HTMLInputElement;
							const vaultDropdown = document.getElementById('vault-select') as HTMLSelectElement;
							const path = pathField?.value || '';
							const vault = vaultDropdown?.value || '';

							navigator.share(shareData)
								.then(async () => {
									await incrementStat('share', vault, path);
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

	// Update the visibility check for share buttons
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
				const testFile = new File(["test"], "test.txt", { type: "text/plain" });
				const testShare = { files: [testFile] };
				if (!navigator.canShare(testShare)) {
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
}

async function initializeUI() {
	const clipButton = document.getElementById('clip-btn');
	if (clipButton) {
		clipButton.addEventListener('click', handleClip);
		
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

function logError(message: string, error?: any): void {
	console.error(message, error);
	showError(message);
}

async function handleClip() {
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

	const selectedVault = currentTemplate.vault || vaultDropdown.value;
	const noteContent = noteContentField.value;
	const isDailyNote = currentTemplate.behavior === 'append-daily' || currentTemplate.behavior === 'prepend-daily';

	let noteName = '';
	let path = '';

	if (!isDailyNote) {
		if (!noteNameField || !pathField) {
			showError('Note name or path field is missing. Please try reloading the extension.');
			return;
		}
		noteName = noteNameField.value;
		path = pathField.value;
	}

	// Check if interpreter is enabled, the button exists, and there are prompt variables
	const promptVariables = collectPromptVariables(currentTemplate);
	if (generalSettings.interpreterEnabled && interpretBtn && promptVariables.length > 0) {
		if (interpretBtn.classList.contains('processing')) {
			try {
				await waitForInterpreter(interpretBtn);
			} catch (error) {
				console.error('Interpreter processing failed:', error);
				showError('failedToProcessInterpreter');
				return;
			}
		} else if (!interpretBtn.classList.contains('done')) {
			interpretBtn.click(); // Only trigger if not already processed
			try {
				await waitForInterpreter(interpretBtn);
			} catch (error) {
				console.error('Interpreter processing failed:', error);
				showError('failedToProcessInterpreter');
				return;
			}
		}
	}

	const properties = Array.from(document.querySelectorAll('.metadata-property input')).map(input => {
		const inputElement = input as HTMLInputElement;
		return {
			id: inputElement.dataset.id || Date.now().toString() + Math.random().toString(36).slice(2, 11),
			name: inputElement.id,
			value: inputElement.type === 'checkbox' ? inputElement.checked : inputElement.value
		};
	}) as Property[];

	let fileContent: string;
	const frontmatter = await generateFrontmatter(properties as Property[]);
	fileContent = frontmatter + noteContent;

	try {
		if (currentTemplate.behavior === 'create' || currentTemplate.behavior === 'overwrite') {
			const updatedProperties = Array.from(document.querySelectorAll('.metadata-property input')).map(input => {
				const inputElement = input as HTMLInputElement;
				return {
					id: inputElement.dataset.id || Date.now().toString() + Math.random().toString(36).slice(2, 11),
					name: inputElement.id,
					value: inputElement.type === 'checkbox' ? inputElement.checked : inputElement.value
				};
			}) as Property[];
			const frontmatter = await memoizedGenerateFrontmatter(updatedProperties as Property[]);
			fileContent = frontmatter + noteContentField.value;
		} else {
			fileContent = noteContentField.value;
		}

		// await saveToObsidian(fileContent, noteName, path, selectedVault, currentTemplate.behavior);
		const currentCloud = (await getLocalStorage("currentCloudDestination")) || "affine-cloud"
		await saveToAFFiNE({
			title: noteName,
			contentMarkdown: noteContentField.value,
			contentHtml: noteContentField.value,
			attachments: {},
			workspace: (await getLocalStorage('workspaceDestination')) || "last-open-workspace",
		}, currentCloud);
		await incrementStat('addToAFFiNE', selectedVault, path);

		// Only update lastSelectedVault if the user explicitly chose a vault
		if (!currentTemplate.vault) {
			lastSelectedVault = selectedVault;
			await setLocalStorage('lastSelectedVault', lastSelectedVault);
		}

		// Only close the window if it's not running in side panel mode
		// if (!isSidePanel) {
		// 	setTimeout(() => window.close(), 500);
		// }
	} catch (error) {
		console.error('Error in handleClip:', error);
		showError('failedToSaveFile');
		throw error;
	}
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

async function refreshFields(tabId: number, checkTemplateTriggers: boolean = true) {
	if (templates.length === 0) {
		console.warn('No templates available');
		showError('noTemplates');
		return;
	}

	try {
		const tab = await browser.tabs.get(tabId);
		if (!tab.url || isBlankPage(tab.url)) {
			showError('pageCannotBeClipped');
			return;
		}
		if (!isValidUrl(tab.url)) {
			showError('onlyHttpSupported');
			return;
		}

		const extractedData = await memoizedExtractPageContent(tabId);
		if (extractedData) {
			const currentUrl = tab.url;

			// Only check for the correct template if checkTemplateTriggers is true
			if (checkTemplateTriggers) {
				const getSchemaOrgData = async () => {
					return extractedData.schemaOrgData;
				};

				const matchedTemplate = await findMatchingTemplate(currentUrl, getSchemaOrgData);
				if (matchedTemplate) {
					console.log('Matched template:', matchedTemplate);
					currentTemplate = matchedTemplate;
					updateTemplateDropdown();
				}
			}

			const initializedContent = await initializePageContent(
				extractedData.content,
				extractedData.selectedHtml,
				extractedData.extractedContent,
				currentUrl,
				extractedData.schemaOrgData,
				extractedData.fullHtml,
				extractedData.highlights || []
			);
			if (initializedContent) {
				setupMetadataToggle();
				currentVariables = initializedContent.currentVariables;
				console.log('Updated currentVariables:', currentVariables);
				await initializeTemplateFields(
					tabId,
					currentTemplate,
					initializedContent.currentVariables,
					initializedContent.noteName,
					extractedData.schemaOrgData
				);

				// Update variables panel if it's open
				updateVariablesPanel(currentTemplate, currentVariables);
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
		templateDropdown.innerHTML = '';
		templates.forEach((template: Template) => {
			const option = document.createElement('option');
			option.value = template.id;
			option.textContent = template.name;
			templateDropdown.appendChild(option);
		});
		templateDropdown.value = currentTemplate.id;
	}
}

async function populateMetadataDropdowns() {
	const destination = (await getLocalStorage('workspaceDestination')) || "last-open-workspace";
	const destinationDropdown = document.getElementById('destination-select') as HTMLSelectElement;
	if (destinationDropdown && destinationDropdown.value !== destination) {
		destinationDropdown.value = destination;
	}

	const cloudDestinations = (await getLocalStorage('cloudDestinations')) || [];
	const cloudDestinationsDropdown = document.getElementById('cloud-destination-select') as HTMLSelectElement;
	if (cloudDestinationsDropdown) {
		cloudDestinations.forEach((destination: string, idx: number) => {
			const option = document.createElement('option');
			option.value = `${destination}`
			option.textContent = destination;
			cloudDestinationsDropdown.appendChild(option);
		})
	}
	const currentCloudDestination = (await getLocalStorage("currentCloudDestination")) || 'affine-cloud';
	if (currentCloudDestination && cloudDestinationsDropdown) {
		cloudDestinationsDropdown.value = currentCloudDestination;
	}
}

async function initializeTemplateFields(currentTabId: number, template: Template | null, variables: { [key: string]: string }, noteName?: string, schemaOrgData?: any) {
	if (!template) {
		logError('No template selected');
		return;
	}

	// Handle vault selection
	const vaultDropdown = document.getElementById('vault-select') as HTMLSelectElement;
	if (vaultDropdown) {
		if (template.vault) {
			vaultDropdown.value = template.vault;
		} else if (lastSelectedVault) {
			vaultDropdown.value = lastSelectedVault;
		}
	}

	currentVariables = variables;
	const existingTemplateProperties = document.querySelector('.metadata-properties') as HTMLElement;

	// Create a new off-screen element
	const newTemplateProperties = createElementWithClass('div', 'metadata-properties');
	newTemplateProperties.style.position = 'absolute';
	newTemplateProperties.style.left = '-9999px';
	document.body.appendChild(newTemplateProperties);

	if (!Array.isArray(template.properties)) {
		logError('Template properties are not an array');
		return;
	}

	for (const property of template.properties) {
		const propertyDiv = createElementWithClass('div', 'metadata-property');
		let value = await memoizedCompileTemplate(currentTabId!, unescapeValue(property.value), variables, currentTabId ? await browser.tabs.get(currentTabId).then(tab => tab.url || '') : '');

		const propertyType = generalSettings.propertyTypes.find(p => p.name === property.name)?.type || 'text';

		// Apply type-specific parsing
		switch (propertyType) {
			case 'number':
				const numericValue = value.replace(/[^\d.-]/g, '');
				value = numericValue ? parseFloat(numericValue).toString() : value;
				break;
			case 'checkbox':
				value = (value.toLowerCase() === 'true' || value === '1').toString();
				break;
			case 'date':
				// Don't override user-specified date format
				if (!property.value.includes('|date:')) {
					value = dayjs(value).isValid() ? dayjs(value).format('YYYY-MM-DD') : value;
				}
				break;
			case 'datetime':
				// Don't override user-specified datetime format
				if (!property.value.includes('|date:')) {
					value = dayjs(value).isValid() ? dayjs(value).format('YYYY-MM-DDTHH:mm:ssZ') : value;
				}
				break;
		}

		propertyDiv.innerHTML = `
			<div class="metadata-property-key">
				<span class="metadata-property-icon"><i data-lucide="${getPropertyTypeIcon(propertyType)}"></i></span>
				<label for="${property.name}">${property.name}</label>
			</div>
			<div class="metadata-property-value">
				${propertyType === 'checkbox' 
					? `<input id="${property.name}" type="checkbox" ${value === 'true' ? 'checked' : ''} data-type="${propertyType}" data-template-value="${escapeHtml(property.value)}" />`
					: `<input id="${property.name}" type="text" value="${escapeHtml(value)}" data-type="${propertyType}" data-template-value="${escapeHtml(property.value)}" />`
				}
			</div>
		`;
		newTemplateProperties.appendChild(propertyDiv);
	}

	// Replace the existing element with the new one
	if (existingTemplateProperties && existingTemplateProperties.parentNode) {
		existingTemplateProperties.parentNode.replaceChild(newTemplateProperties, existingTemplateProperties);
		// Remove the old element from the DOM
		existingTemplateProperties.remove();
	}

	// Remove the temporary styling
	newTemplateProperties.style.position = '';
	newTemplateProperties.style.left = '';

	initializeIcons(newTemplateProperties);

	const noteNameField = document.getElementById('note-name-field') as HTMLTextAreaElement;
	if (noteNameField) {
		let formattedNoteName = await memoizedCompileTemplate(currentTabId!, template.noteNameFormat, variables, currentTabId ? await browser.tabs.get(currentTabId).then(tab => tab.url || '') : '');
		noteNameField.setAttribute('data-template-value', template.noteNameFormat);
		noteNameField.value = formattedNoteName.trim();
		adjustNoteNameHeight(noteNameField);
	}

	const pathField = document.getElementById('path-name-field') as HTMLInputElement;
	const pathContainer = document.querySelector('.vault-path-container') as HTMLElement;
	
	if (pathField && pathContainer) {
		const isDailyNote = template.behavior === 'append-daily' || template.behavior === 'prepend-daily';
		
		if (isDailyNote) {
			pathField.style.display = 'none';
		} else {
			// pathContainer.style.display = 'flex';
			let formattedPath = await memoizedCompileTemplate(currentTabId!, template.path, variables, currentTabId ? await browser.tabs.get(currentTabId).then(tab => tab.url || '') : '');
			pathField.value = formattedPath;
			pathField.setAttribute('data-template-value', template.path);
		}
	}

	const noteContentField = document.getElementById('note-content-field') as HTMLTextAreaElement;
	if (noteContentField) {
		if (template.noteContentFormat) {
			let content = await memoizedCompileTemplate(currentTabId!, template.noteContentFormat, variables, currentTabId ? await browser.tabs.get(currentTabId).then(tab => tab.url || '') : '');
			noteContentField.value = content;
			noteContentField.setAttribute('data-template-value', template.noteContentFormat);
		} else {
			noteContentField.value = '';
			noteContentField.setAttribute('data-template-value', '');
		}
	}

	if (template) {
		if (generalSettings.interpreterEnabled) {
			await initializeInterpreter(template, variables, currentTabId!, currentTabId ? await browser.tabs.get(currentTabId).then(tab => tab.url || '') : '');

			// Check if there are any prompt variables
			const promptVariables = collectPromptVariables(template);

			// If auto-run is enabled and there are prompt variables, use interpreter
			if (generalSettings.interpreterAutoRun && promptVariables.length > 0) {
				try {
					const interpretBtn = document.getElementById('interpret-btn') as HTMLButtonElement;
					const modelSelect = document.getElementById('model-select') as HTMLSelectElement;
					const selectedModelId = modelSelect?.value || generalSettings.interpreterModel;
					const modelConfig = generalSettings.models.find(m => m.id === selectedModelId);
					if (!modelConfig) {
						throw new Error(`Model configuration not found for ${selectedModelId}`);
					}
					await handleInterpreterUI(template, variables, currentTabId!, currentTabId ? await browser.tabs.get(currentTabId).then(tab => tab.url || '') : '', modelConfig);
					
					// Ensure the button shows the completed state after auto-run
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

		const replacedTemplate = await getReplacedTemplate(template, variables, currentTabId!, currentTabId ? await browser.tabs.get(currentTabId).then(tab => tab.url || '') : '');
		debugLog('Variables', 'Current template with replaced variables:', JSON.stringify(replacedTemplate, null, 2));
	}
}

function setupMetadataToggle() {
	const metadataHeader = document.querySelector('.metadata-properties-header') as HTMLElement;
	const metadataProperties = document.querySelector('.metadata-properties') as HTMLElement;
	
	if (metadataHeader && metadataProperties) {
		metadataHeader.removeEventListener('click', toggleMetadataProperties);
		metadataHeader.addEventListener('click', toggleMetadataProperties);

		// Set initial state
		getLocalStorage('propertiesCollapsed').then((isCollapsed) => {
			updateMetadataToggleState(isCollapsed);
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

	vaultDropdown.innerHTML = '';
	
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
	refreshFields(currentTabId!, false);
}

function handleDestinationChange(value: string) {
	browser.storage.local.set({'workspaceDestination': value});
}

function handleCloudDestinationChange(value: string) {
	browser.storage.local.set({'currentCloudDestination': value});
}

function openNewDestinationDialog() {
	const clipperContainer = document.getElementById("destination-dialog-wrapper");
	if (!clipperContainer) return;
	clipperContainer.style.display = 'block';
}

function cloudDestinationIsValid(value: string) {
	return true;
}

async function saveSelfHostedCloud() {
	const currentCloudInput = document.getElementById("cloud-destination-input") as HTMLInputElement;
	if (!currentCloudInput) return;
	const cloudDestinationValue = currentCloudInput.value;
	if (!cloudDestinationIsValid(cloudDestinationValue)) return;

	const currentClouds = (await browser.storage.local.get("cloudDestinations"))?.cloudDestinations as string[] || [];
	await browser.storage.local.set({
		"cloudDestinations": [...currentClouds, cloudDestinationValue],
		"currentCloudDestination": cloudDestinationValue,
	});

	await populateMetadataDropdowns();

	const clipperContainer = document.getElementById("destination-dialog-wrapper");
	if (!clipperContainer) return;
	clipperContainer.style.display = 'none';
}

async function checkHighlighterModeState(tabId: number) {
	try {
		const result = await browser.storage.local.get('isHighlighterMode');
		isHighlighterMode = result.isHighlighterMode as boolean;
		
		loadedSettings = await loadSettings();
		
		updateHighlighterModeUI(isHighlighterMode);
	} catch (error) {
		console.error('Error checking highlighter mode state:', error);
		// If there's an error, assume highlighter mode is off
		isHighlighterMode = false;
		updateHighlighterModeUI(false);
	}
}

async function toggleHighlighterMode(tabId: number) {
	const result = await browser.storage.local.get('isHighlighterMode');
	const wasHighlighterModeActive = result.isHighlighterMode as boolean;
	isHighlighterMode = !wasHighlighterModeActive;
	await setLocalStorage('isHighlighterMode', isHighlighterMode);

	// Send a message to the content script to toggle the highlighter mode
	await browser.tabs.sendMessage(tabId, { 
		action: "setHighlighterMode", 
		isActive: isHighlighterMode 
	});

	// Notify the background script about the change
	browser.runtime.sendMessage({ 
		action: "highlighterModeChanged", 
		isActive: isHighlighterMode 
	});

	// Close the popup if highlighter mode is turned on and not in side panel
	if (isHighlighterMode && !wasHighlighterModeActive && !isSidePanel) {
		window.close();
	} else {
		updateHighlighterModeUI(isHighlighterMode);
	}
}

function updateHighlighterModeUI(isActive: boolean) {
	const highlighterModeButton = document.getElementById('highlighter-mode');
	if (highlighterModeButton) {
		if (generalSettings.highlighterEnabled) {
			highlighterModeButton.style.display = 'flex';
			highlighterModeButton.classList.toggle('active', isActive);
			highlighterModeButton.setAttribute('aria-pressed', isActive.toString());
			highlighterModeButton.title = isActive ? getMessage('disableHighlighter') : getMessage('enableHighlighter');
		} else {
			highlighterModeButton.style.display = 'none';
		}
	}
}

export async function copyToClipboard(content: string) {
	try {
		await navigator.clipboard.writeText(content);
		
		const pathField = document.getElementById('path-name-field') as HTMLInputElement;
		const vaultDropdown = document.getElementById('vault-select') as HTMLSelectElement;
		const path = pathField?.value || '';
		const vault = vaultDropdown?.value || '';
		
		await incrementStat('copyToClipboard', vault, path);

		// Change the main button text temporarily
		const clipButton = document.getElementById('clip-btn');
		if (clipButton) {
			const originalText = clipButton.textContent || getMessage('addToAFFiNE');
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
		
		const properties = Array.from(document.querySelectorAll('.metadata-property input')).map(input => {
			const inputElement = input as HTMLInputElement;
			return {
				id: inputElement.dataset.id || Date.now().toString() + Math.random().toString(36).slice(2, 11),
				name: inputElement.id,
				value: inputElement.type === 'checkbox' ? inputElement.checked : inputElement.value
			};
		}) as Property[];

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

		await incrementStat('saveFile', vault, path);

		const moreDropdown = document.getElementById('more-dropdown');
		if (moreDropdown) {
			moreDropdown.classList.remove('show');
		}
	} catch (error) {
		console.error('Failed to save file:', error);
		showError('failedToSaveFile');
	}
}

// Update the resize event listener to use the debounced version
window.addEventListener('resize', debouncedSetPopupDimensions);