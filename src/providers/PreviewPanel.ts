import * as vscode from 'vscode';
import * as path from 'path';
import { createTranslationProvider, TranslationConfig } from './TranslationProvider';

const CONFIG_NAMESPACE = 'TransPreview';
const PREVIEW_VISIBLE_CONTEXT_KEY = 'TransPreview.previewVisible';

interface CachedTranslation {
  translatedContent: string;
  sourceVersion: number;
  targetLanguage: string;
  updatedAt: number;
}

export class PreviewPanel {
  public static readonly viewType = 'PTvo.previewPanel';
  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];
  private _currentDocument?: vscode.TextDocument;
  private _disposeCallback?: () => void;
  private _translationCache = new Map<string, CachedTranslation>();

  constructor(extensionUri: vscode.Uri) {
    // Create and show panel
    this._panel = vscode.window.createWebviewPanel(
      PreviewPanel.viewType,
      'Preview',
      {
        viewColumn: vscode.ViewColumn.Beside, // Open beside the current editor
        preserveFocus: true
      },
      {
        enableScripts: true,
        localResourceRoots: [extensionUri],
        retainContextWhenHidden: true
      }
    );

    // Set the webview's initial HTML content
    this._panel.webview.html = this._getHtmlForWebview(this._panel.webview);

    // Handle messages from the webview
    this._panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.command) {
          case 'translate':
            await this.translate();
            break;
          case 'ready':
            // Send current content when webview is ready
            this._sendCurrentContent();
            if (this._isAutoTranslateEnabled()) {
              void this.translate();
            }
            break;
        }
      },
      null,
      this._disposables
    );

    // Update the preview when the panel becomes visible
    this._panel.onDidChangeViewState(
      () => {
        if (this._panel.visible) {
          this._updateContextKey(true);
          this._sendCurrentContent();
        } else {
          this._updateContextKey(false);
        }
      },
      null,
      this._disposables
    );

    // Handle the panel being disposed
    this._panel.onDidDispose(
      () => {
        this._updateContextKey(false);
        while (this._disposables.length) {
          const disposable = this._disposables.pop();
          if (disposable) {
            disposable.dispose();
          }
        }
        this._disposeCallback?.();
      },
      null,
      this._disposables
    );

    // Load current document content
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor) {
      this.updateContent(activeEditor.document);
    }

    this._updateContextKey(true);
  }

  public onDidDispose(callback: () => void) {
    this._disposeCallback = callback;
  }

  public reveal() {
    this._panel.reveal();
  }

  public isVisible(): boolean {
    return this._panel.visible;
  }

  public dispose() {
    this._panel.dispose();
    while (this._disposables.length) {
      const disposable = this._disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }

  public updateContent(document: vscode.TextDocument) {
    this._currentDocument = document;
    if (this._panel.visible) {
      this._sendContentToWebview(document);
    }
  }

  public async translate() {
    const sourceDocument = this._currentDocument;
    if (!sourceDocument) {
      this._panel.webview.postMessage({
        command: 'translateComplete'
      });
      return;
    }

    const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
    const translator = config.get<string>('translator', 'deepseek');
    const apiKey = config.get<string>('apiKey', '').trim();
    const baseUrl = config.get<string>('baseUrl', '').trim();
    const model = config.get<string>('model', '').trim();

    if (!apiKey) {
      vscode.window.showErrorMessage(`Please set your API key in settings (${CONFIG_NAMESPACE}.apiKey)`);
      this._panel.webview.postMessage({
        command: 'translateComplete'
      });
      return;
    }

    const documentCacheKey = this._getDocumentCacheKey(sourceDocument);
    const sourceVersion = sourceDocument.version;
    const targetLanguage = this._detectTargetLanguage(sourceDocument.languageId);
    const content = sourceDocument.getText();

    // Show progress indicator
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Translating...',
        cancellable: false
      },
      async () => {
        try {
          const translatedText = await this._callTranslationAPI(
            translator,
            apiKey,
            content,
            baseUrl,
            model,
            targetLanguage
          );

          this._translationCache.set(documentCacheKey, {
            translatedContent: translatedText,
            sourceVersion,
            targetLanguage,
            updatedAt: Date.now()
          });

          if (this._currentDocument && this._getDocumentCacheKey(this._currentDocument) === documentCacheKey) {
            this._sendContentToWebview(this._currentDocument);
          }
        } catch (error) {
          vscode.window.showErrorMessage(
            `Translation failed: ${error instanceof Error ? error.message : 'Unknown error'}`
          );
        } finally {
          this._panel.webview.postMessage({
            command: 'translateComplete'
          });
        }
      }
    );
  }

  private async _callTranslationAPI(
    translator: string,
    apiKey: string,
    content: string,
    baseUrl?: string,
    model?: string,
    targetLanguage = 'zh-CN'
  ): Promise<string> {
    const config: TranslationConfig = {
      apiKey: apiKey,
      baseUrl: baseUrl || undefined,
      model: model || undefined
    };

    const provider = createTranslationProvider(translator, config);
    return await provider.translate(content, targetLanguage);
  }

  private _detectTargetLanguage(languageId: string): string {
    // If the file is already in a Chinese-like context, translate to English
    // Otherwise translate to Chinese
    const normalized = languageId.toLowerCase();
    const chineseLikePatterns = ['zh', 'zh-cn', 'zh-hans', 'zh-hant', 'chinese'];
    const isChineseLike = chineseLikePatterns.some((pattern) => normalized.includes(pattern));

    return isChineseLike ? 'en' : 'zh-CN';
  }

  private _sendCurrentContent() {
    if (this._currentDocument) {
      this._sendContentToWebview(this._currentDocument);
    }
  }

  private _isAutoTranslateEnabled(): boolean {
    return vscode.workspace.getConfiguration(CONFIG_NAMESPACE).get<boolean>('autoTranslate', false);
  }

  private _sendContentToWebview(document: vscode.TextDocument) {
    const cached = this._getCachedTranslation(document);
    const content = cached ? cached.entry.translatedContent : document.getText();
    const fileName = path.basename(document.fileName) || 'Untitled';

    this._panel.webview.postMessage({
      command: 'updateContent',
      content: content,
      fileName: fileName,
      language: document.languageId,
      isTranslated: !!cached,
      isStale: cached?.isStale ?? false
    });
  }

  private _getDocumentCacheKey(document: vscode.TextDocument): string {
    return document.uri.toString();
  }

  private _getCachedTranslation(document: vscode.TextDocument): { entry: CachedTranslation; isStale: boolean } | undefined {
    const cacheKey = this._getDocumentCacheKey(document);
    const entry = this._translationCache.get(cacheKey);
    if (!entry) {
      return undefined;
    }

    return {
      entry,
      isStale: entry.sourceVersion !== document.version
    };
  }

  private _updateContextKey(visible: boolean) {
    vscode.commands.executeCommand('setContext', PREVIEW_VISIBLE_CONTEXT_KEY, visible);
  }

  private _getHtmlForWebview(_webview: vscode.Webview): string {
    const fontFamily = vscode.workspace.getConfiguration('editor').get<string>('fontFamily', 'Consolas, Monaco, "Courier New", monospace');
    const fontSize = vscode.workspace.getConfiguration('editor').get<number>('fontSize', 14);
    const lineHeight = vscode.workspace.getConfiguration('editor').get<number>('lineHeight', 0);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
  <title>TransPreview Preview</title>
  <style>
    /* Use VS Code's built-in CSS variables with fallbacks */
    :root {
      --ptvo-bg: var(--vscode-editor-background, #1e1e1e);
      --ptvo-fg: var(--vscode-editorForeground, #cccccc);
      --ptvo-font-family: ${fontFamily};
      --ptvo-font-size: ${fontSize}px;
      --ptvo-line-height: ${lineHeight > 0 ? lineHeight : 1.6};
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    html, body {
      height: 100%;
      width: 100%;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      font-size: 14px;
      line-height: 1.6;
      color: var(--ptvo-fg);
      background-color: var(--ptvo-bg);
      margin: 0;
      padding: 0;
      overflow: hidden;
    }

    .container {
      display: flex;
      flex-direction: column;
      height: 100%;
    }

    .header {
      padding: 12px 16px;
      background-color: var(--vscode-editorGroupHeader-tabsBackground);
      border-bottom: 1px solid var(--vscode-panelSection-border);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .header-left {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .file-name {
      font-weight: 600;
      color: var(--ptvo-fg);
    }

    .language-badge {
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 3px;
      background-color: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }

    .header-right {
      display: flex;
      gap: 8px;
    }

    button {
      padding: 6px 12px;
      border: none;
      border-radius: 3px;
      cursor: pointer;
      font-size: 13px;
      background-color: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .btn-icon {
      fill: currentColor;
      flex-shrink: 0;
    }

    .btn-text {
      flex-shrink: 0;
    }

    button:hover {
      background-color: var(--vscode-button-hoverBackground);
    }

    button:disabled {
      background-color: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      cursor: not-allowed;
    }

    .content {
      flex: 1;
      overflow: auto;
      padding: 16px;
      background-color: var(--ptvo-bg);
      color: var(--ptvo-fg);
    }

    .content pre {
      white-space: pre-wrap;
      word-wrap: break-word;
      font-family: var(--ptvo-font-family);
      font-size: var(--ptvo-font-size);
      line-height: var(--ptvo-line-height);
      color: var(--ptvo-fg);
      background-color: transparent;
      margin: 0;
    }

    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: var(--vscode-descriptionForeground);
      text-align: center;
      padding: 20px;
    }

    .empty-state svg {
      width: 64px;
      height: 64px;
      margin-bottom: 16px;
      opacity: 0.5;
    }

    .translated-indicator {
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 3px;
      background-color: #28a745;
      color: white;
      display: none;
    }

    .translated-indicator.show {
      display: inline-block;
    }

    .stale-indicator {
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 3px;
      background-color: var(--vscode-editorWarning-foreground, #d29922);
      color: var(--vscode-editor-background, #1e1e1e);
      display: none;
    }

    .stale-indicator.show {
      display: inline-block;
    }

    button.secondary {
      background-color: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      display: none;
    }

    button.secondary:hover {
      background-color: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-secondaryBackground));
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="header-left">
        <span class="file-name" id="fileName">No file open</span>
        <span class="language-badge" id="languageBadge" style="display: none;"></span>
        <span class="translated-indicator" id="translatedIndicator">Translated</span>
        <span class="stale-indicator" id="staleIndicator">Translation may be outdated</span>
      </div>
      <div class="header-right">
        <button id="translateBtn" title="Translate content">
          <svg class="btn-icon" width="16" height="16" viewBox="0 0 16 16">
            <path d="M8.5 1.5A1.5 1.5 0 0 0 7 0h-4A1.5 1.5 0 0 0 1.5 1.5v7A1.5 1.5 0 0 0 3 10h4a1.5 1.5 0 0 0 1.5-1.5v-7zM7 1H3a.5.5 0 0 0-.5.5v7a.5.5 0 0 0 .5.5h4a.5.5 0 0 0 .5-.5v-7A.5.5 0 0 0 7 1zm2.5 2.5a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 0 1h-5a.5.5 0 0 1-.5-.5zm0 4a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 0 1h-5a.5.5 0 0 1-.5-.5zm0 4a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 0 1h-5a.5.5 0 0 1-.5-.5z"/>
          </svg>
          <span class="btn-text">Translate</span>
        </button>
        <button id="retranslateBtn" class="secondary" title="Retranslate with latest content">
          <span class="btn-text">Retranslate</span>
        </button>
      </div>
    </div>
    <div class="content" id="content">
      <div class="empty-state">
        <svg viewBox="0 0 16 16" fill="currentColor">
          <path d="M14 4.5V14a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V2a2 2 0 0 1 2-2h5.5L14 4.5zm-3 0A1.5 1.5 0 0 1 9.5 3V1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V4.5h-2z"/>
        </svg>
        <p>Open a file to see its preview here</p>
      </div>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    const contentEl = document.getElementById('content');
    const fileNameEl = document.getElementById('fileName');
    const languageBadgeEl = document.getElementById('languageBadge');
    const translatedIndicatorEl = document.getElementById('translatedIndicator');
    const staleIndicatorEl = document.getElementById('staleIndicator');
    const translateBtn = document.getElementById('translateBtn');
    const retranslateBtn = document.getElementById('retranslateBtn');
    const btnText = translateBtn.querySelector('.btn-text');
    let hasStaleTranslation = false;

    // Send ready message to extension
    window.addEventListener('load', () => {
      vscode.postMessage({ command: 'ready' });
    });

    // Listen for messages from extension
    window.addEventListener('message', (event) => {
      const message = event.data;

      switch (message.command) {
        case 'updateContent':
          updateContent(message.content, message.fileName, message.language, message.isTranslated, message.isStale);
          break;
        case 'translateComplete':
          setTranslating(false);
          break;
      }
    });

    function requestTranslate() {
      setTranslating(true);
      vscode.postMessage({ command: 'translate' });
    }

    function setTranslating(translating) {
      translateBtn.disabled = translating;
      retranslateBtn.disabled = translating;
      btnText.textContent = translating ? 'Translating...' : 'Translate';
    }

    translateBtn.addEventListener('click', requestTranslate);
    retranslateBtn.addEventListener('click', requestTranslate);

    function updateContent(content, fileName, language, isTranslated, isStale) {
      fileNameEl.textContent = fileName || 'No file open';
      hasStaleTranslation = Boolean(isStale);

      if (language) {
        languageBadgeEl.textContent = language;
        languageBadgeEl.style.display = 'inline-block';
      } else {
        languageBadgeEl.style.display = 'none';
      }

      if (isTranslated) {
        translatedIndicatorEl.classList.add('show');
      } else {
        translatedIndicatorEl.classList.remove('show');
      }

      if (isTranslated && hasStaleTranslation) {
        staleIndicatorEl.classList.add('show');
        retranslateBtn.style.display = 'inline-flex';
      } else {
        staleIndicatorEl.classList.remove('show');
        retranslateBtn.style.display = 'none';
      }

      if (content) {
        // Clear and create new pre element
        contentEl.innerHTML = '';
        const pre = document.createElement('pre');
        pre.textContent = content;
        contentEl.appendChild(pre);
      } else {
        contentEl.innerHTML = '<div class="empty-state"><svg viewBox="0 0 16 16" fill="currentColor"><path d="M14 4.5V14a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V2a2 2 0 0 1 2-2h5.5L14 4.5zm-3 0A1.5 1.5 0 0 1 9.5 3V1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V4.5h-2z"/></svg><p>This file has no content</p></div>';
      }

      setTranslating(false);
    }
  </script>
</body>
</html>`;
  }
}
