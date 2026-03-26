import * as vscode from 'vscode';
import { PreviewPanel } from './providers/PreviewPanel';
import { createTranslationProvider, TranslationConfig } from './providers/TranslationProvider';

let previewPanel: PreviewPanel | undefined = undefined;
const CONFIG_NAMESPACE = 'TransPreview';

interface SelectionTranslationResult {
  translation: string;
  pinyin: string;
  explanation?: string;
}

const SOFTWARE_TERM_TRANSLATION_PROMPT = `You are a bilingual glossary assistant for software development and computer science.  
You must automatically detect the input language and always translate into the *other* language:
- If the user input is Chinese → respond in English.
- If the user input is English → respond in Simplified Chinese.

Focus on technical meaning first (programming, systems, networking, AI, databases, tooling).  
When there are multiple senses, choose the software‑engineering sense.

Return ONLY strict JSON with this schema when input is English:
{"translation":"简体中文译文","pinyin":"拼音（含声调）","explanation":"一句简短专业解释"}

Return ONLY strict JSON with this schema when input is Chinese:
{"translation":"English translation","explanation":"Short technical explanation in English"}

Rules for English → Chinese:
- translation: concise Simplified Chinese, no punctuation
- pinyin: pinyin for Chinese translation, with tone marks and spaces
- explanation: ≤ 30 Chinese characters，技术语境

Rules for Chinese → English:
- translation: concise technical English, no punctuation
- explanation: ≤ 80 English characters, technical context

Global rules:
- No markdown
- No code block
- No extra keys
- No comments or explanations outside the JSON`;

export function activate(context: vscode.ExtensionContext) {
  console.log('TransPreview extension is now active!');
  vscode.commands.executeCommand('setContext', 'TransPreview.previewVisible', false);

  // Register open preview command
  context.subscriptions.push(
    vscode.commands.registerCommand('TransPreview.openPreview', () => {
      if (!previewPanel) {
        previewPanel = new PreviewPanel(context.extensionUri);
        previewPanel.onDidDispose(() => {
          previewPanel = undefined;
        });
      }
      previewPanel.reveal();
    })
  );

  // Register translate command
  context.subscriptions.push(
    vscode.commands.registerCommand('TransPreview.translateContent', () => {
      previewPanel?.translate();
    })
  );

  // Register close preview command
  context.subscriptions.push(
    vscode.commands.registerCommand('TransPreview.closePreview', () => {
      previewPanel?.dispose();
      previewPanel = undefined;
    })
  );

  // Register quick selection translation command
  context.subscriptions.push(
    vscode.commands.registerCommand('TransPreview.translateSelection', async () => {
      await translateSelectedText();
    })
  );

  // Update preview when active editor changes
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor && previewPanel && previewPanel.isVisible()) {
        previewPanel.updateContent(editor.document);
      }
    })
  );

  // Update preview when document content changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      const activeEditor = vscode.window.activeTextEditor;
      if (activeEditor && event.document === activeEditor.document) {
        if (previewPanel && previewPanel.isVisible()) {
          previewPanel.updateContent(event.document);
        }
      }
    })
  );
}

export function deactivate() {
  vscode.commands.executeCommand('setContext', 'TransPreview.previewVisible', false);
  previewPanel?.dispose();
  console.log('TransPreview extension is now deactivated!');
}

async function translateSelectedText(): Promise<void> {
  const activeEditor = vscode.window.activeTextEditor;
  if (!activeEditor) {
    vscode.window.showInformationMessage('Please open an editor and select a word first.');
    return;
  }

  const selection = activeEditor.selection;
  const selectedText = activeEditor.document.getText(selection).trim();

  if (!selectedText) {
    vscode.window.showInformationMessage('Please select a word or short phrase first.');
    return;
  }

  const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
  const translator = config.get<string>('translator', 'deepseek');
  const apiKey = config.get<string>('apiKey', '').trim();
  const baseUrl = config.get<string>('baseUrl', '').trim();
  const model = config.get<string>('model', '').trim();

  if (!apiKey) {
    vscode.window.showErrorMessage(`Please set your API key in settings (${CONFIG_NAMESPACE}.apiKey)`);
    return;
  }

  const providerConfig: TranslationConfig = {
    apiKey,
    baseUrl: baseUrl || undefined,
    model: model || undefined
  };

  try {
    const provider = createTranslationProvider(translator, providerConfig);

    const rawResult = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Translating "${selectedText}"...`,
        cancellable: false
      },
      async () => provider.translate(selectedText, 'zh-CN', {
        systemPrompt: SOFTWARE_TERM_TRANSLATION_PROMPT,
        temperature: 0.1
      })
    );

    const parsed = parseSelectionTranslation(rawResult);
    const message = `${selectedText} → ${parsed.translation}（${parsed.pinyin}）${parsed.explanation ? `\n${parsed.explanation}` : ''}`;
    vscode.window.showInformationMessage(message);
  } catch (error) {
    vscode.window.showErrorMessage(
      `Selection translation failed: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

function parseSelectionTranslation(rawResult: string): SelectionTranslationResult {
  const normalized = rawResult.trim();
  const jsonCandidate = extractJsonPayload(normalized);

  if (jsonCandidate) {
    try {
      const parsed = JSON.parse(jsonCandidate) as Partial<SelectionTranslationResult>;
      const translation = (parsed.translation ?? '').trim();
      const pinyin = (parsed.pinyin ?? '').trim();
      const explanation = (parsed.explanation ?? '').trim();

      if (translation) {
        return {
          translation,
          pinyin: pinyin || '（无）',
          explanation: explanation || undefined
        };
      }
    } catch {
      // fallback to plain text parsing
    }
  }

  return {
    translation: normalized,
    pinyin: '（未提供）'
  };
}

function extractJsonPayload(text: string): string | undefined {
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenceMatch?.[1] ?? text;
  const firstBrace = candidate.indexOf('{');
  const lastBrace = candidate.lastIndexOf('}');
  if (firstBrace < 0 || lastBrace < 0 || firstBrace >= lastBrace) {
    return undefined;
  }

  return candidate.slice(firstBrace, lastBrace + 1);
}
