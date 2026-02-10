import * as vscode from 'vscode';
import { WorkflowParserFactory } from './parsers';
import { WorkflowVisualizerPanel } from './webview';

/**
 * Activates the Dapr Workflow Visualizer extension
 */
export function activate(context: vscode.ExtensionContext) {

    // Register the visualize command (from active editor)
    const visualizeCommand = vscode.commands.registerCommand(
        'dapr-workflow-visualizer.visualize',
        async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showWarningMessage('No active editor. Please open a workflow file first.');
                return;
            }

            await visualizeDocument(editor.document, context.extensionUri);
        }
    );

    // Register the visualize file command (from explorer context menu)
    const visualizeFileCommand = vscode.commands.registerCommand(
        'dapr-workflow-visualizer.visualizeFile',
        async (uri: vscode.Uri) => {
            if (!uri) {
                const files = await vscode.window.showOpenDialog({
                    canSelectFiles: true,
                    canSelectFolders: false,
                    filters: {
                        'Workflow Files': ['cs', 'py', 'js', 'ts']
                    }
                });
                if (!files || files.length === 0) {
                    return;
                }
                uri = files[0];
            }

            const document = await vscode.workspace.openTextDocument(uri);
            await visualizeDocument(document, context.extensionUri);
        }
    );

    // Register the refresh command
    const refreshCommand = vscode.commands.registerCommand(
        'dapr-workflow-visualizer.refresh',
        async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showWarningMessage('No active editor.');
                return;
            }

            if (WorkflowVisualizerPanel.currentPanel) {
                await visualizeDocument(editor.document, context.extensionUri);
            } else {
                vscode.window.showInformationMessage('No visualization open. Use "Visualize Dapr Workflow" first.');
            }
        }
    );

    // Register a CodeLens provider for workflow files
    const codeLensProvider = new WorkflowCodeLensProvider();
    const codeLensDisposable = vscode.languages.registerCodeLensProvider(
        [
            { language: 'csharp' },
            { language: 'python' },
            { language: 'javascript' },
            { language: 'typescript' }
        ],
        codeLensProvider
    );

    // Watch for document changes to auto-refresh
    const documentChangeListener = vscode.workspace.onDidSaveTextDocument(
        async (document) => {
            if (WorkflowVisualizerPanel.currentPanel && isWorkflowFile(document)) {
                // Auto-refresh on save if the panel is open
                const config = vscode.workspace.getConfiguration('daprWorkflowVisualizer');
                const autoRefresh = config.get('autoRefreshOnSave', true);
                
                if (autoRefresh) {
                    // Keep viewing the same workflow after refresh
                    const currentWorkflowName = WorkflowVisualizerPanel.currentPanel.currentWorkflowName;
                    await visualizeDocument(document, context.extensionUri, currentWorkflowName);
                }
            }
        }
    );

    // Command to navigate to node at current cursor position
    const navigateToNodeCommand = vscode.commands.registerCommand(
        'dapr-workflow-visualizer.navigateToNode',
        () => {
            const editor = vscode.window.activeTextEditor;
            if (editor && WorkflowVisualizerPanel.currentPanel && isWorkflowFile(editor.document)) {
                const lineNumber = editor.selection.active.line + 1;
                WorkflowVisualizerPanel.currentPanel.navigateToLine(lineNumber);
            }
        }
    );

    // Command to visualize a specific workflow by name (used by workflow decorator CodeLens)
    const visualizeWorkflowCommand = vscode.commands.registerCommand(
        'dapr-workflow-visualizer.visualizeWorkflow',
        async (workflowName: string) => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                return;
            }
            
            await visualizeDocument(editor.document, context.extensionUri, workflowName);
        }
    );

    // Command to visualize and focus on a specific node (used by activity CodeLens)
    const visualizeAndFocusCommand = vscode.commands.registerCommand(
        'dapr-workflow-visualizer.visualizeAndFocus',
        async (nodeName: string, workflowName?: string) => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                return;
            }
            
            await visualizeDocumentAndFocus(editor.document, context.extensionUri, nodeName, workflowName);
        }
    );

    context.subscriptions.push(
        visualizeCommand,
        visualizeFileCommand,
        refreshCommand,
        codeLensDisposable,
        documentChangeListener,
        navigateToNodeCommand,
        visualizeWorkflowCommand,
        visualizeAndFocusCommand
    );
}

/**
 * Visualize a document as a workflow graph
 * @param document The document to visualize
 * @param extensionUri Extension URI for resources
 * @param targetWorkflowName Optional - if specified, only visualize this workflow (for files with multiple workflows)
 */
async function visualizeDocument(
    document: vscode.TextDocument,
    extensionUri: vscode.Uri,
    targetWorkflowName?: string
): Promise<void> {
    const filePath = document.uri.fsPath;

    // Check if the file can be parsed
    if (!WorkflowParserFactory.canParse(filePath)) {
        vscode.window.showWarningMessage(
            `Cannot parse ${filePath}. Supported file types: ${WorkflowParserFactory.getSupportedExtensions().join(', ')}`
        );
        return;
    }

    // Parse the workflow (optionally scoped to a specific workflow)
    const sourceCode = document.getText();
    const result = WorkflowParserFactory.parse(sourceCode, filePath, targetWorkflowName);

    if (!result.success || !result.workflow) {
        const errorMessage = result.errors?.map(e => e.message).join('\n') || 'Unknown error';
        vscode.window.showErrorMessage(`Failed to parse workflow: ${errorMessage}`);
        return;
    }

    // Check if workflow has any activities
    if (result.workflow.nodes.length <= 2) { // Only start and end nodes
        vscode.window.showInformationMessage(
            'No Dapr workflow activities found in this file. Make sure the file contains Dapr workflow definitions.'
        );
    }

    // Create or update the visualization panel
    WorkflowVisualizerPanel.createOrShow(extensionUri, result.workflow);
}

/**
 * Visualize a document and focus on a specific node by name
 * @param document The document to visualize
 * @param extensionUri Extension URI for resources
 * @param nodeName The node name to focus on
 * @param targetWorkflowName Optional - if specified, only visualize this workflow
 */
async function visualizeDocumentAndFocus(
    document: vscode.TextDocument,
    extensionUri: vscode.Uri,
    nodeName: string,
    targetWorkflowName?: string
): Promise<void> {
    const filePath = document.uri.fsPath;

    // Check if the file can be parsed
    if (!WorkflowParserFactory.canParse(filePath)) {
        vscode.window.showWarningMessage(
            `Cannot parse ${filePath}. Supported file types: ${WorkflowParserFactory.getSupportedExtensions().join(', ')}`
        );
        return;
    }

    // Parse the workflow (optionally scoped to a specific workflow)
    const sourceCode = document.getText();
    const result = WorkflowParserFactory.parse(sourceCode, filePath, targetWorkflowName);

    if (!result.success || !result.workflow) {
        const errorMessage = result.errors?.map(e => e.message).join('\n') || 'Unknown error';
        vscode.window.showErrorMessage(`Failed to parse workflow: ${errorMessage}`);
        return;
    }

    // Create or show the visualization panel, then update with focus
    const column = vscode.ViewColumn.Beside;
    
    if (WorkflowVisualizerPanel.currentPanel) {
        WorkflowVisualizerPanel.currentPanel.reveal(column);
        WorkflowVisualizerPanel.currentPanel.updateWorkflowAndFocus(result.workflow, nodeName);
    } else {
        // Create new panel - it will handle the focus after ready signal
        const panel = WorkflowVisualizerPanel.createOrShow(extensionUri);
        panel.updateWorkflowAndFocus(result.workflow, nodeName);
    }
}

/**
 * Check if a document is a potential workflow file
 */
function isWorkflowFile(document: vscode.TextDocument): boolean {
    const text = document.getText();
    const filePath = document.uri.fsPath;

    // Check file extension
    if (!WorkflowParserFactory.canParse(filePath)) {
        return false;
    }

    // Check for workflow-related patterns
    const workflowPatterns = [
        /CallActivity/i,
        /call_activity/i,
        /callActivity/i,
        /Workflow/i,
        /orchestrat/i,
        /@(?:\w+\.)?workflow/i,
        /DaprWorkflow/i
    ];

    return workflowPatterns.some(pattern => pattern.test(text));
}

/**
 * CodeLens provider for workflow files
 */
class WorkflowCodeLensProvider implements vscode.CodeLensProvider {
    provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
        if (!isWorkflowFile(document)) {
            return [];
        }

        const codeLenses: vscode.CodeLens[] = [];
        const text = document.getText();

        // Find workflow class/function definitions
        const workflowPatterns = [
            // C# workflow class
            { pattern: /class\s+(\w+)\s*:\s*Workflow/g, nameGroup: 1 },
            // Python workflow decorator - capture function name on next line
            // Matches: @workflow, @dapr_workflow, @wfr.workflow, @runtime.workflow, etc.
            { pattern: /@(?:\w+\.)?(?:dapr_)?workflow[^\n]*\n\s*(?:async\s+)?def\s+(\w+)/g, nameGroup: 1 },
            // JS/TS workflow function
            { pattern: /(?:export\s+)?(?:async\s+)?function\s*\*?\s*(\w*[Ww]orkflow\w*)/g, nameGroup: 1 },
            { pattern: /registerWorkflow\s*\(\s*["']?(\w+)["']?/g, nameGroup: 1 }
        ];

        for (const { pattern, nameGroup } of workflowPatterns) {
            let match;
            while ((match = pattern.exec(text)) !== null) {
                const position = document.positionAt(match.index);
                const range = new vscode.Range(position, position);
                const workflowName = match[nameGroup];
                
                codeLenses.push(new vscode.CodeLens(range, {
                    title: '$(graph) Visualize Workflow',
                    command: 'dapr-workflow-visualizer.visualizeWorkflow',
                    arguments: [workflowName],
                    tooltip: `Open visualization for ${workflowName}`
                }));
            }
        }

        // Build a map of workflow ranges to determine which workflow an activity belongs to
        const workflowRanges = this.findWorkflowRanges(text);

        // Helper to find which workflow a position belongs to
        const getWorkflowForPosition = (charIndex: number): string | undefined => {
            for (const wr of workflowRanges) {
                if (charIndex >= wr.startIndex && charIndex < wr.endIndex) {
                    return wr.name;
                }
            }
            return workflowRanges[0]?.name; // Fallback to first workflow
        };

        // Find all activity calls and add CodeLens for each
        const activityPatterns = [
            // Python: ctx.call_activity(activity_name, ...) or await ctx.call_activity(...)
            /(?:yield|await)\s+ctx\.call_activity\s*\(\s*(\w+)/g,
            // Python: task = ctx.call_activity(...) - parallel tasks
            /(\w+)\s*=\s*ctx\.call_activity\s*\(\s*(\w+)/g,
            // C#: await ctx.CallActivityAsync("ActivityName", ...)
            /await\s+ctx\.CallActivityAsync[^(]*\(\s*["'](\w+)["']/g,
            // C#: ctx.CallActivityAsync<T>("ActivityName", ...)
            /ctx\.CallActivityAsync[^(]*\(\s*["'](\w+)["']/g,
            // JS/TS: yield ctx.callActivity(activityName, ...)
            /(?:yield|await)\s+ctx\.callActivity\s*\(\s*["']?(\w+)["']?/g
        ];

        for (const pattern of activityPatterns) {
            let match;
            while ((match = pattern.exec(text)) !== null) {
                const position = document.positionAt(match.index);
                const range = new vscode.Range(position, position);
                
                // Get activity name from match groups
                const activityName = match[2] || match[1];
                
                // Determine which workflow this activity belongs to
                const owningWorkflow = getWorkflowForPosition(match.index);
                
                codeLenses.push(new vscode.CodeLens(range, {
                    title: `$(target) Show ${activityName} in graph`,
                    command: 'dapr-workflow-visualizer.visualizeAndFocus',
                    arguments: [activityName, owningWorkflow],
                    tooltip: `Visualize ${owningWorkflow || 'workflow'} and focus on ${activityName}`
                }));
            }
        }

        // Find child workflow calls
        const childWorkflowPatterns = [
            // Python
            /(?:yield|await)\s+ctx\.call_child_workflow\s*\(\s*(\w+)/g,
            // C#
            /ctx\.CallChildWorkflowAsync[^(]*\(\s*["'](\w+)["']/g,
            // JS/TS
            /(?:yield|await)\s+ctx\.callChildWorkflow\s*\(\s*["']?(\w+)["']?/g
        ];

        for (const pattern of childWorkflowPatterns) {
            let match;
            while ((match = pattern.exec(text)) !== null) {
                const position = document.positionAt(match.index);
                const range = new vscode.Range(position, position);
                const childName = match[1];
                
                // Determine which workflow this child call belongs to
                const owningWorkflow = getWorkflowForPosition(match.index);
                
                codeLenses.push(new vscode.CodeLens(range, {
                    title: `$(target) Show ${childName} in graph`,
                    command: 'dapr-workflow-visualizer.visualizeAndFocus',
                    arguments: [childName, owningWorkflow],
                    tooltip: `Visualize ${owningWorkflow || 'workflow'} and focus on child workflow ${childName}`
                }));
            }
        }

        // Find timer/event calls
        const otherPatterns = [
            // Python timers
            { pattern: /(?:yield|await)\s+ctx\.create_timer\s*\(/g, name: 'Timer' },
            // Python external events
            { pattern: /(?:yield|await)\s+ctx\.wait_for_external_event\s*\(["']?(\w+)["']?/g, name: 'Event' },
            // C# timers
            { pattern: /ctx\.CreateTimer\s*\(/g, name: 'Timer' },
            // C# external events  
            { pattern: /ctx\.WaitForExternalEvent[^(]*\(/g, name: 'Event' }
        ];

        for (const { pattern, name } of otherPatterns) {
            let match;
            while ((match = pattern.exec(text)) !== null) {
                const position = document.positionAt(match.index);
                const range = new vscode.Range(position, position);
                const itemName = match[1] || name;
                
                // Determine which workflow this belongs to
                const owningWorkflow = getWorkflowForPosition(match.index);
                
                codeLenses.push(new vscode.CodeLens(range, {
                    title: `$(target) Show ${itemName} in graph`,
                    command: 'dapr-workflow-visualizer.visualizeAndFocus',
                    arguments: [itemName, owningWorkflow],
                    tooltip: `Visualize ${owningWorkflow || 'workflow'} and focus on ${itemName}`
                }));
            }
        }

        return codeLenses;
    }

    /**
     * Find all workflow definitions and their ranges in the source code
     */
    private findWorkflowRanges(text: string): Array<{name: string, startIndex: number, endIndex: number}> {
        const workflows: Array<{name: string, startIndex: number, endIndex: number}> = [];
        
        // Python workflow pattern
        const pythonPattern = /@(?:\w+\.)?(?:dapr_)?workflow[^\n]*\n\s*(?:async\s+)?def\s+(\w+)/g;
        // C# workflow pattern
        const csharpPattern = /class\s+(\w+)\s*:\s*Workflow/g;
        // JS/TS workflow pattern  
        const jsPattern = /(?:export\s+)?(?:async\s+)?function\s*\*?\s*(\w*[Ww]orkflow\w*)/g;
        
        const allMatches: Array<{name: string, startIndex: number}> = [];
        
        let match;
        // Collect all workflow starts
        for (const pattern of [pythonPattern, csharpPattern, jsPattern]) {
            while ((match = pattern.exec(text)) !== null) {
                allMatches.push({
                    name: match[1],
                    startIndex: match.index
                });
            }
        }
        
        // Sort by position
        allMatches.sort((a, b) => a.startIndex - b.startIndex);
        
        // Calculate end indices
        for (let i = 0; i < allMatches.length; i++) {
            const current = allMatches[i];
            const next = allMatches[i + 1];
            
            // End at start of next workflow or at @activity decorator or end of file
            let endIndex: number;
            if (next) {
                endIndex = next.startIndex;
            } else {
                // Check for @activity decorator as boundary
                const activityMatch = text.slice(current.startIndex).match(/\n@(?:\w+\.)?activity\b/);
                if (activityMatch && activityMatch.index) {
                    endIndex = current.startIndex + activityMatch.index;
                } else {
                    endIndex = text.length;
                }
            }
            
            workflows.push({
                name: current.name,
                startIndex: current.startIndex,
                endIndex
            });
        }
        
        return workflows;
    }
}

/**
 * Deactivates the extension
 */
export function deactivate() {
    // Clean up resources
}

