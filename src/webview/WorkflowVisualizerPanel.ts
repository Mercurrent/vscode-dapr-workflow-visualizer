import * as vscode from 'vscode';
import { WorkflowDefinition, VisualizationOptions } from '../types/workflow';

/**
 * Manages the workflow visualization webview panel
 */
export class WorkflowVisualizerPanel {
    public static currentPanel: WorkflowVisualizerPanel | undefined;
    public static readonly viewType = 'daprWorkflowVisualizer';

    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _workflow: WorkflowDefinition | undefined;
    private _currentWorkflowName: string | undefined;  // Track which workflow is being viewed
    private _pendingFocusNodeName: string | undefined;  // Track pending focus for when webview becomes ready
    private _disposables: vscode.Disposable[] = [];

    /**
     * Reveal the panel in a specific column
     */
    public reveal(column?: vscode.ViewColumn): void {
        this._panel.reveal(column);
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this._panel = panel;
        this._extensionUri = extensionUri;

        // Set the webview's initial html content
        this._update();

        // Listen for when the panel is disposed
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        // Handle messages from the webview
        this._panel.webview.onDidReceiveMessage(
            message => this._handleMessage(message),
            null,
            this._disposables
        );

        // Send workflow data when webview signals it's ready (only on fresh load)
        this._panel.webview.onDidReceiveMessage(
            message => {
                if (message.type === 'ready' && this._workflow && !message.hasWorkflow) {
                    // Only send if webview doesn't already have the workflow
                    this._panel.webview.postMessage({
                        type: 'updateWorkflow',
                        workflow: this._workflow,
                        options: this._getOptions(),
                        focusNodeName: this._pendingFocusNodeName
                    });
                    this._pendingFocusNodeName = undefined;  // Clear after sending
                }
            },
            null,
            this._disposables
        );

        // Note: We do NOT update on view state change because:
        // 1. retainContextWhenHidden: true preserves the webview content
        // 2. Calling _update() would regenerate HTML and reset zoom/pan state
    }

    /**
     * Create or show the workflow visualizer panel
     */
    public static createOrShow(extensionUri: vscode.Uri, workflow?: WorkflowDefinition): WorkflowVisualizerPanel {
        const column = vscode.ViewColumn.Beside;

        // If we already have a panel, show it
        if (WorkflowVisualizerPanel.currentPanel) {
            WorkflowVisualizerPanel.currentPanel._panel.reveal(column);
            if (workflow) {
                WorkflowVisualizerPanel.currentPanel.updateWorkflow(workflow);
            }
            return WorkflowVisualizerPanel.currentPanel;
        }

        // Otherwise, create a new panel
        const panel = vscode.window.createWebviewPanel(
            WorkflowVisualizerPanel.viewType,
            'Dapr Workflow Visualizer',
            column,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(extensionUri, 'media'),
                    vscode.Uri.joinPath(extensionUri, 'dist')
                ]
            }
        );

        WorkflowVisualizerPanel.currentPanel = new WorkflowVisualizerPanel(panel, extensionUri);
        
        // For new panels, store the workflow but DON'T send it yet
        // The webview will signal 'ready' and we'll send it then
        if (workflow) {
            WorkflowVisualizerPanel.currentPanel._workflow = workflow;
            WorkflowVisualizerPanel.currentPanel._currentWorkflowName = workflow.name;
            WorkflowVisualizerPanel.currentPanel._panel.title = `Workflow: ${workflow.name}`;
        }

        return WorkflowVisualizerPanel.currentPanel;
    }

    /**
     * Get the name of the currently displayed workflow
     */
    public get currentWorkflowName(): string | undefined {
        return this._currentWorkflowName;
    }

    /**
     * Update the workflow being visualized
     */
    public updateWorkflow(workflow: WorkflowDefinition): void {
        this._workflow = workflow;
        this._currentWorkflowName = workflow.name;  // Track which workflow we're viewing
        this._panel.title = `Workflow: ${workflow.name}`;
        this._sendWorkflowToWebview();
    }

    /**
     * Update workflow and focus on a specific node by name after rendering
     */
    public updateWorkflowAndFocus(workflow: WorkflowDefinition, nodeName: string): void {
        this._workflow = workflow;
        this._currentWorkflowName = workflow.name;  // Track which workflow we're viewing
        this._pendingFocusNodeName = nodeName;  // Store in case webview isn't ready yet
        this._panel.title = `Workflow: ${workflow.name}`;
        this._panel.webview.postMessage({
            type: 'updateWorkflow',
            workflow: this._workflow,
            options: this._getOptions(),
            focusNodeName: nodeName
        });
    }

    /**
     * Refresh the visualization
     */
    public refresh(): void {
        if (this._workflow) {
            this._sendWorkflowToWebview();
        }
    }

    /**
     * Navigate to a node at the given line number
     */
    public navigateToLine(lineNumber: number): void {
        this._panel.webview.postMessage({
            type: 'navigateToLine',
            lineNumber
        });
    }

    /**
     * Get visualization options from settings
     */
    private _getOptions(): VisualizationOptions {
        const config = vscode.workspace.getConfiguration('daprWorkflowVisualizer');
        return {
            layout: config.get('defaultLayout', 'dagre'),
            theme: config.get('theme', 'auto'),
            showActivityDetails: config.get('showActivityDetails', true),
            animated: true,
            showDataFlow: true,
            showControlFlow: true,
            highlightWorkflowInput: true
        };
    }

    /**
     * Send workflow data to webview
     */
    private _sendWorkflowToWebview(): void {
        this._panel.webview.postMessage({
            type: 'updateWorkflow',
            workflow: this._workflow,
            options: this._getOptions()
        });
    }

    /**
     * Handle messages from webview
     */
    private _handleMessage(message: { type: string; [key: string]: unknown }): void {
        switch (message.type) {
            case 'nodeClick':
                this._handleNodeClick(message.nodeId as string);
                break;
            case 'exportSvg':
                this._handleExportSvg(message.svg as string);
                break;
            case 'error':
                vscode.window.showErrorMessage(`Visualization error: ${message.error}`);
                break;
        }
    }

    /**
     * Handle node click event
     */
    private _handleNodeClick(nodeId: string): void {
        if (!this._workflow) {return;}

        const node = this._workflow.nodes.find(n => n.id === nodeId);
        if (node && node.metadata?.lineNumber) {
            const lineNumber = (node.metadata!.lineNumber as number) - 1;
            const targetUri = vscode.Uri.file(this._workflow.filePath);
            
            // Check if the file is already open in an editor
            const existingEditor = vscode.window.visibleTextEditors.find(
                editor => editor.document.uri.fsPath === this._workflow!.filePath
            );
            
            if (existingEditor) {
                // Use existing editor - just reveal and select the line
                const range = new vscode.Range(lineNumber, 0, lineNumber, 0);
                existingEditor.selection = new vscode.Selection(range.start, range.end);
                existingEditor.revealRange(range, vscode.TextEditorRevealType.InCenter);
                // Focus the existing editor without opening a new one
                vscode.window.showTextDocument(existingEditor.document, {
                    viewColumn: existingEditor.viewColumn,
                    preserveFocus: false,
                    selection: range
                });
            } else {
                // File not open - open in the first column (main editor area)
                vscode.workspace.openTextDocument(targetUri).then(doc => {
                    vscode.window.showTextDocument(doc, {
                        viewColumn: vscode.ViewColumn.One,
                        selection: new vscode.Range(lineNumber, 0, lineNumber, 0)
                    });
                });
            }
        }
    }

    /**
     * Handle SVG export
     */
    private async _handleExportSvg(svgContent: string): Promise<void> {
        const uri = await vscode.window.showSaveDialog({
            filters: { 'SVG Files': ['svg'] },
            defaultUri: vscode.Uri.file(`${this._workflow?.name || 'workflow'}.svg`)
        });

        if (uri) {
            await vscode.workspace.fs.writeFile(uri, Buffer.from(svgContent, 'utf-8'));
            vscode.window.showInformationMessage(`Workflow exported to ${uri.fsPath}`);
        }
    }

    /**
     * Update the webview content
     */
    private _update(): void {
        this._panel.webview.html = this._getHtmlForWebview();
    }

    /**
     * Generate the HTML content for the webview
     */
    private _getHtmlForWebview(): string {
        const webview = this._panel.webview;
        const nonce = this._getNonce();

        // Get VS Code theme colors for styling
        const theme = vscode.window.activeColorTheme;
        const isDark = theme.kind === vscode.ColorThemeKind.Dark || 
                      theme.kind === vscode.ColorThemeKind.HighContrast;

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;">
    <title>Dapr Workflow Visualizer</title>
    <style>
        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }

        body {
            font-family: var(--vscode-font-family);
            background: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            overflow: hidden;
            height: 100vh;
        }

        .container {
            display: flex;
            flex-direction: column;
            height: 100vh;
        }

        .toolbar {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 10px;
            background: var(--vscode-titleBar-activeBackground);
            border-bottom: 1px solid var(--vscode-panel-border);
        }

        .toolbar button {
            padding: 5px 10px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 3px;
            cursor: pointer;
        }

        .toolbar button:hover {
            background: var(--vscode-button-hoverBackground);
        }

        .toolbar select {
            padding: 5px;
            background: var(--vscode-dropdown-background);
            color: var(--vscode-dropdown-foreground);
            border: 1px solid var(--vscode-dropdown-border);
            border-radius: 3px;
        }

        .workflow-info {
            margin-left: auto;
            font-size: 14px;
            color: var(--vscode-descriptionForeground);
        }

        #graph-container {
            flex: 1;
            overflow: hidden;
            position: relative;
        }

        #graph {
            width: 100%;
            height: 100%;
        }

        .node {
            cursor: pointer;
        }

        .node rect, .node circle, .node polygon {
            stroke-width: 2px;
            transition: all 0.2s ease;
        }

        .node:hover rect, .node:hover circle, .node:hover polygon {
            filter: brightness(1.2);
        }

        .node-highlighted rect, .node-highlighted circle, .node-highlighted polygon {
            animation: pulse-highlight 1.5s ease-out;
            filter: drop-shadow(0 0 8px var(--vscode-focusBorder));
        }

        @keyframes pulse-highlight {
            0% { filter: drop-shadow(0 0 15px var(--vscode-focusBorder)) brightness(1.4); }
            50% { filter: drop-shadow(0 0 8px var(--vscode-focusBorder)) brightness(1.2); }
            100% { filter: drop-shadow(0 0 0px transparent) brightness(1); }
        }

        .node-label {
            font-size: 14px;
            fill: var(--vscode-editor-foreground);
            pointer-events: none;
        }

        /* Control flow edges */
        .edge {
            fill: none;
            stroke: var(--vscode-editorLineNumber-foreground);
            stroke-width: 2px;
        }

        .edge.edge-control {
            stroke: var(--vscode-editorLineNumber-foreground);
            stroke-width: 2px;
        }

        /* Data flow edges - workflow input (blue) */
        .edge.edge-data-workflow-input {
            stroke: #3B82F6;
            stroke-width: 2px;
            stroke-dasharray: 6, 3;
            opacity: 0.8;
        }

        /* Data flow edges - activity output (green) */
        .edge.edge-data-activity-output {
            stroke: #10B981;
            stroke-width: 2px;
            stroke-dasharray: 6, 3;
            opacity: 0.8;
        }

        /* Data flow edges - event data (orange) */
        .edge.edge-data-event {
            stroke: #F59E0B;
            stroke-width: 2px;
            stroke-dasharray: 6, 3;
            opacity: 0.8;
        }

        .edge-label {
            font-size: 12px;
            fill: var(--vscode-editor-foreground);
        }

        /* Background for edge labels - solid color for readability */
        .edge-label-bg {
            fill: var(--vscode-editor-background);
        }

        .edge-label.data-label {
            font-size: 11px;
            font-family: var(--vscode-editor-font-family);
        }

        /* Data flow labels - use bright colors that work on any theme */
        .edge-label-data {
            font-size: 11px;
            font-style: italic;
        }

        .edge-label.workflow-input-label {
            fill: #60A5FA !important;  /* Bright blue - works on dark and light */
            font-weight: 600;
        }

        .edge-label.activity-output-label {
            fill: #34D399 !important;  /* Bright green - works on dark and light */
            font-weight: 600;
        }
        
        /* Fallback for data labels without specific type */
        .edge-label-data:not(.workflow-input-label):not(.activity-output-label) {
            fill: #FBBF24 !important;  /* Bright amber - visible on both themes */
            font-weight: 600;
        }

        .edge marker {
            fill: var(--vscode-editorLineNumber-foreground);
        }

        /* Data source indicator badges */
        .data-source-badge {
            font-size: 10px;
            font-weight: bold;
        }

        .data-source-badge.workflow-input {
            fill: #3B82F6;
        }

        .data-source-badge.activity-output {
            fill: #10B981;
        }

        .data-source-badge.event-data {
            fill: #F59E0B;
        }

        .data-source-badge.constructed {
            fill: #8B5CF6;
        }

        /* Node type colors - muted palette */
        .node-start rect { fill: #5a9a6e; stroke: #4a8a5e; }
        .node-end rect { fill: #b86a6a; stroke: #a85a5a; }
        .node-activity rect { fill: #6a9fcf; stroke: #5a8fbf; }
        .node-subOrchestration rect { fill: #9a7aaf; stroke: #8a6a9f; }
        .node-timer rect { fill: #cf9f6a; stroke: #bf8f5a; }
        .node-event polygon { fill: #F59E0B; stroke: #D97706; }  /* Orange for events to stand out */
        .node-decision polygon { fill: #cfcf7a; stroke: #bfbf6a; }
        .node-parallel rect { fill: #8a7a6f; stroke: #7a6a5f; }
        .node-retry rect { fill: #7a8a9a; stroke: #6a7a8a; }

        /* Text colors for nodes - ensure good contrast */
        .node-start .node-label { fill: #ffffff; }
        .node-end .node-label { fill: #ffffff; }
        .node-activity .node-label { fill: #ffffff; }
        .node-subOrchestration .node-label { fill: #ffffff; }
        .node-timer .node-label { fill: #1a1a1a; }        /* Dark text on tan/orange */
        .node-event .node-label { fill: #1a1a1a; }        /* Dark text on orange */
        .node-decision .node-label { fill: #1a1a1a; }     /* Dark text on yellow */
        .node-parallel .node-label { fill: #ffffff; }
        .node-retry .node-label { fill: #ffffff; }

        .tooltip {
            position: absolute;
            background: var(--vscode-editorHoverWidget-background);
            border: 1px solid var(--vscode-editorHoverWidget-border);
            border-radius: 4px;
            padding: 8px 12px;
            font-size: 14px;
            pointer-events: none;
            z-index: 1000;
            max-width: 350px;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
        }

        .tooltip-title {
            font-weight: bold;
            margin-bottom: 4px;
        }

        .tooltip-type {
            color: var(--vscode-descriptionForeground);
            font-size: 12px;
            text-transform: uppercase;
            margin-bottom: 4px;
        }

        .tooltip-io {
            margin: 4px 0;
            font-size: 13px;
        }

        .tooltip-io-label {
            color: var(--vscode-descriptionForeground);
            font-weight: 500;
        }

        .tooltip-io code {
            background: var(--vscode-textCodeBlock-background);
            padding: 1px 4px;
            border-radius: 3px;
            font-family: var(--vscode-editor-font-family);
            font-size: 12px;
        }

        .tooltip-fields {
            margin: 6px 0;
            font-size: 13px;
        }

        .tooltip-field-list {
            margin: 4px 0 0 16px;
            padding: 0;
            list-style: none;
        }

        .tooltip-field-list li {
            color: var(--vscode-symbolIcon-fieldForeground, #75BEFF);
            font-family: var(--vscode-editor-font-family);
            font-size: 12px;
            padding: 1px 0;
        }

        .tooltip-field-list li::before {
            content: "• ";
            color: var(--vscode-descriptionForeground);
        }

        .tooltip-condition, .tooltip-tasks, .tooltip-line {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            margin-top: 4px;
        }

        .edge-parallel {
            stroke-dasharray: 5, 3;
        }

        .io-badge {
            opacity: 0;
            transition: opacity 0.2s ease;
        }

        .node:hover .io-badge {
            opacity: 1;
        }

        .node-parallel rect {
            fill: #7a6a8a;
            stroke: #6a5a7a;
        }

        .node-join rect {
            fill: #6a7a8a;
            stroke: #5a6a7a;
        }

        .empty-state {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            height: 100%;
            color: var(--vscode-descriptionForeground);
        }

        .empty-state svg {
            width: 64px;
            height: 64px;
            margin-bottom: 16px;
            opacity: 0.5;
        }

        .legend {
            position: absolute;
            bottom: 10px;
            left: 10px;
            background: var(--vscode-editorWidget-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            padding: 10px;
            font-size: 13px;
            max-width: 200px;
        }

        .legend-section {
            margin-bottom: 8px;
        }

        .legend-section-title {
            font-weight: bold;
            font-size: 12px;
            text-transform: uppercase;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 4px;
        }

        .legend-item {
            display: flex;
            align-items: center;
            gap: 6px;
            margin-bottom: 4px;
        }

        .legend-color {
            width: 14px;
            height: 14px;
            border-radius: 2px;
        }

        .legend-line {
            width: 20px;
            height: 3px;
            border-radius: 1px;
        }

        .legend-line.dashed {
            background: repeating-linear-gradient(
                90deg,
                currentColor 0px,
                currentColor 4px,
                transparent 4px,
                transparent 7px
            );
            height: 2px;
        }

        .toggle-group {
            display: flex;
            gap: 10px;
            align-items: center;
            margin-left: 10px;
            padding-left: 10px;
            border-left: 1px solid var(--vscode-panel-border);
        }

        .toggle-item {
            display: flex;
            align-items: center;
            gap: 4px;
            font-size: 13px;
        }

        .toggle-item input {
            margin: 0;
        }

        .toggle-item label {
            cursor: pointer;
            user-select: none;
        }

        /* Signature header for workflow I/O */
        .signature-header {
            padding: 10px 15px;
            background: var(--vscode-editorWidget-background);
            border-bottom: 1px solid var(--vscode-panel-border);
            font-family: var(--vscode-editor-font-family), monospace;
            font-size: 13px;
        }

        .signature-line {
            display: flex;
            align-items: baseline;
            gap: 8px;
            margin-bottom: 4px;
        }

        .signature-line:last-child {
            margin-bottom: 0;
        }

        .sig-keyword {
            color: var(--vscode-symbolIcon-keywordForeground, #569CD6);
        }

        .sig-function {
            color: var(--vscode-symbolIcon-functionForeground, #DCDCAA);
            font-weight: 500;
        }

        .sig-type {
            color: var(--vscode-symbolIcon-classForeground, #4EC9B0);
        }

        .sig-label {
            color: var(--vscode-descriptionForeground);
            font-size: 12px;
            min-width: 55px;
        }

        .sig-fields {
            color: var(--vscode-editor-foreground);
            opacity: 0.9;
        }

        .sig-arrow {
            color: var(--vscode-descriptionForeground);
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="toolbar">
            <button id="btn-zoom-in" title="Zoom In">➕</button>
            <button id="btn-zoom-out" title="Zoom Out">➖</button>
            <button id="btn-fit" title="Fit to View">📐</button>
            <select id="layout-select" title="Layout">
                <option value="dagre">Dagre (Hierarchical)</option>
                <option value="force">Force Directed</option>
            </select>
            <div class="toggle-group">
                <div class="toggle-item">
                    <input type="checkbox" id="toggle-control-flow" checked>
                    <label for="toggle-control-flow">Control Flow</label>
                </div>
                <div class="toggle-item">
                    <input type="checkbox" id="toggle-data-flow" checked>
                    <label for="toggle-data-flow">Data Flow</label>
                </div>
            </div>
            <button id="btn-export" title="Export SVG">💾 Export</button>
            <div class="workflow-info">
                <span id="workflow-name"></span>
            </div>
        </div>
        <div id="signature-header" class="signature-header" style="display: none;">
            <div class="signature-line">
                <span class="sig-label">Signature:</span>
                <span class="sig-keyword">def</span>
                <span class="sig-function" id="sig-func-name"></span>(<span class="sig-type" id="sig-input-type"></span>)
                <span class="sig-arrow">→</span>
                <span class="sig-type" id="sig-output-type"></span>
            </div>
            <div class="signature-line" id="sig-input-line" style="display: none;">
                <span class="sig-label">Input:</span>
                <span class="sig-fields" id="sig-input-fields"></span>
            </div>
            <div class="signature-line" id="sig-output-line" style="display: none;">
                <span class="sig-label">Output:</span>
                <span class="sig-fields" id="sig-output-fields"></span>
            </div>
        </div>
        <div id="graph-container">
            <svg id="graph"></svg>
            <div id="tooltip" class="tooltip" style="display: none;"></div>
            <div class="legend">
                <div class="legend-section">
                    <div class="legend-section-title">Nodes</div>
                    <div class="legend-item"><div class="legend-color" style="background: #5a9a6e;"></div>Start</div>
                    <div class="legend-item"><div class="legend-color" style="background: #b86a6a;"></div>End</div>
                    <div class="legend-item"><div class="legend-color" style="background: #6a9fcf;"></div>Activity</div>
                    <div class="legend-item"><div class="legend-color" style="background: #9a7aaf;"></div>Sub-Orchestration</div>
                    <div class="legend-item"><div class="legend-color" style="background: #cf9f6a;"></div>Timer</div>
                    <div class="legend-item"><div class="legend-color" style="background: #F59E0B;"></div>Event</div>
                    <div class="legend-item"><div class="legend-color" style="background: #cfcf7a;"></div>Decision</div>
                </div>
                <div class="legend-section">
                    <div class="legend-section-title">Data Flow</div>
                    <div class="legend-item"><div class="legend-line" style="background: #3B82F6;"></div>🟦 Workflow Input</div>
                    <div class="legend-item"><div class="legend-line" style="background: #10B981;"></div>🟩 Activity Output</div>
                    <div class="legend-item"><div class="legend-line" style="background: #F59E0B;"></div>🟧 Event Data</div>
                </div>
            </div>
        </div>
    </div>
    <script nonce="${nonce}">
        ${this._getVisualizationScript()}
    </script>
</body>
</html>`;
    }

    /**
     * Get the visualization JavaScript code
     */
    private _getVisualizationScript(): string {
        return `
(function() {
    const vscode = acquireVsCodeApi();
    
    let workflow = null;
    let options = {};
    let zoom = null;
    let svg = null;
    let showControlFlow = true;
    let showDataFlow = true;
    let pendingFocusNodeName = null;  // Track if we need to focus after render
    let g = null;

    // Initialize
    function init() {
        svg = document.getElementById('graph');
        setupEventListeners();
        
        // Signal to extension that webview is ready
        vscode.postMessage({ type: 'ready', hasWorkflow: !!workflow });
    }

    function setupEventListeners() {
        document.getElementById('btn-zoom-in').addEventListener('click', () => zoomBy(1.2));
        document.getElementById('btn-zoom-out').addEventListener('click', () => zoomBy(0.8));
        document.getElementById('btn-fit').addEventListener('click', fitToView);
        document.getElementById('btn-export').addEventListener('click', exportSvg);
        document.getElementById('layout-select').addEventListener('change', (e) => {
            options.layout = e.target.value;
            if (workflow) renderWorkflow();
        });

        // Toggle event listeners for data flow visualization
        const controlFlowToggle = document.getElementById('toggle-control-flow');
        const dataFlowToggle = document.getElementById('toggle-data-flow');
        
        if (controlFlowToggle) {
            controlFlowToggle.addEventListener('change', (e) => {
                showControlFlow = e.target.checked;
                if (workflow) renderWorkflow();
            });
        }
        
        if (dataFlowToggle) {
            dataFlowToggle.addEventListener('change', (e) => {
                showDataFlow = e.target.checked;
                if (workflow) renderWorkflow();
            });
        }
    }

    // Handle messages from extension
    window.addEventListener('message', event => {
        const message = event.data;
        switch (message.type) {
            case 'updateWorkflow':
                workflow = message.workflow;
                options = message.options || {};
                document.getElementById('workflow-name').textContent = workflow?.name || '';
                document.getElementById('layout-select').value = options.layout || 'dagre';
                updateSignatureHeader();
                // Set focus BEFORE rendering so renderWorkflow can use it
                if (message.focusNodeName) {
                    pendingFocusNodeName = message.focusNodeName;
                }
                renderWorkflow();
                break;
            case 'navigateToLine':
                navigateToNodeAtLine(message.lineNumber);
                break;
        }
    });

    // Update the signature header with workflow I/O info
    function updateSignatureHeader() {
        const header = document.getElementById('signature-header');
        if (!workflow || !workflow.metadata) {
            header.style.display = 'none';
            return;
        }
        
        const meta = workflow.metadata;
        const dataFlow = workflow.dataFlow;
        
        // Check if we have any useful info to show
        const hasInputType = meta.inputType;
        const hasOutputType = meta.outputType;
        const hasInputFields = meta.inputProperties && meta.inputProperties.length > 0;
        const hasOutputFields = meta.outputFields && meta.outputFields.length > 0;
        
        if (!hasInputType && !hasOutputType && !hasInputFields && !hasOutputFields) {
            header.style.display = 'none';
            return;
        }
        
        header.style.display = 'block';
        
        // Set function name
        document.getElementById('sig-func-name').textContent = workflow.name;
        
        // Set input type
        document.getElementById('sig-input-type').textContent = hasInputType ? meta.inputType : 'input';
        
        // Set output type  
        document.getElementById('sig-output-type').textContent = hasOutputType ? meta.outputType : 'result';
        
        // Set input fields
        const inputLine = document.getElementById('sig-input-line');
        if (hasInputFields) {
            inputLine.style.display = 'flex';
            document.getElementById('sig-input-fields').textContent = '{ ' + meta.inputProperties.join(', ') + ' }';
        } else {
            inputLine.style.display = 'none';
        }
        
        // Set output fields
        const outputLine = document.getElementById('sig-output-line');
        if (hasOutputFields) {
            outputLine.style.display = 'flex';
            document.getElementById('sig-output-fields').textContent = '{ ' + meta.outputFields.join(', ') + ' }';
        } else {
            outputLine.style.display = 'none';
        }
    }

    // Navigate to node by name (activity name, event name, etc.)
    function navigateToNodeByName(nodeName) {
        if (!workflow || !workflow.nodes.length) return;

        // Find node by name - try multiple matching strategies
        const searchName = nodeName.toLowerCase();
        let targetNode = workflow.nodes.find(node => {
            const nameMatch = node.name?.toLowerCase() === searchName;
            const labelMatch = node.label?.toLowerCase() === searchName;
            const labelContains = node.label?.toLowerCase().includes(searchName);
            const nameContains = node.name?.toLowerCase().includes(searchName);
            return nameMatch || labelMatch || labelContains || nameContains;
        });

        // If no match or start node, scroll to top
        if (!targetNode || targetNode.type === 'start') {
            scrollToTop();
            return;
        }

        // Pan to the target node
        panToNode(targetNode.id);
    }

    // Navigate to node at given line number (for keyboard shortcut)
    function navigateToNodeAtLine(lineNumber) {
        if (!workflow || !workflow.nodes.length) return;

        // Find node closest to this line
        let targetNode = null;
        let minDistance = Infinity;

        for (const node of workflow.nodes) {
            const nodeLine = node.metadata?.lineNumber;
            if (nodeLine !== undefined) {
                const distance = Math.abs(nodeLine - lineNumber);
                // Only match if line is within 10 lines of the node
                if (distance < minDistance && distance <= 10) {
                    minDistance = distance;
                    targetNode = node;
                }
            }
        }

        // If start node or no match, scroll to top
        if (!targetNode || targetNode.type === 'start') {
            scrollToTop();
            return;
        }

        // Pan to the target node
        panToNode(targetNode.id);
    }

    // Scroll to top of the graph (start node)
    function scrollToTop() {
        if (window.setTranslate) {
            window.setTranslate(0, 0);
            if (window.zoomTo) {
                window.zoomTo(1);
            }
        }
    }

    // Pan to center a specific node
    function panToNode(nodeId) {
        const nodeElement = document.querySelector(\`[data-node-id="\${nodeId}"]\`);
        if (!nodeElement) return;

        const container = document.getElementById('graph-container');
        const containerWidth = container.clientWidth;
        const containerHeight = container.clientHeight;

        // Get node position from transform
        const transform = nodeElement.getAttribute('transform');
        if (!transform) return;
        
        const match = transform.match(/translate\\(([^,]+),\\s*([^)]+)\\)/);
        if (!match) return;

        const nodeX = parseFloat(match[1]) + 100; // Add half node width
        const nodeY = parseFloat(match[2]) + 25; // Add half node height
        
        if (isNaN(nodeX) || isNaN(nodeY)) return;

        // Calculate translation to center node
        const currentScale = window.getScale ? window.getScale() : 1;
        const translateX = containerWidth / 2 - nodeX * currentScale;
        const translateY = containerHeight / 2 - nodeY * currentScale;

        if (window.setTranslate) {
            window.setTranslate(translateX, translateY);
        }

        // Highlight the node briefly
        highlightNode(nodeId);
    }

    // Highlight a node temporarily
    function highlightNode(nodeId) {
        const nodeElement = document.querySelector(\`[data-node-id="\${nodeId}"]\`);
        if (!nodeElement) return;

        // Add highlight class
        nodeElement.classList.add('node-highlighted');

        // Remove after animation
        setTimeout(() => {
            nodeElement.classList.remove('node-highlighted');
        }, 1500);
    }

    function renderWorkflow() {
        if (!workflow || !workflow.nodes.length) {
            showEmptyState();
            return;
        }

        // Clear previous content
        svg.innerHTML = '';

        const container = document.getElementById('graph-container');
        const width = container.clientWidth;
        const height = container.clientHeight;

        // Create main group for zoom/pan
        const mainGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        mainGroup.id = 'main-group';
        svg.appendChild(mainGroup);

        // Add arrow markers
        const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
        defs.innerHTML = \`
            <marker id="arrowhead" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
                <polygon points="0 0, 10 3.5, 0 7" fill="var(--vscode-editorLineNumber-foreground)" />
            </marker>
            <marker id="arrowhead-data" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
                <polygon points="0 0, 8 3, 0 6" fill="#3B82F6" />
            </marker>
            <marker id="arrowhead-workflow-input" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
                <polygon points="0 0, 8 3, 0 6" fill="#3B82F6" />
            </marker>
            <marker id="arrowhead-activity-output" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
                <polygon points="0 0, 8 3, 0 6" fill="#10B981" />
            </marker>
        \`;
        svg.appendChild(defs);

        // Layout nodes
        const layout = options.layout === 'force' ? forceLayout() : dagreLayout();
        
        // Hide SVG during render to prevent flash of unpositioned content
        svg.style.visibility = 'hidden';
        
        // Create layer groups for proper z-ordering
        const edgesGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        edgesGroup.setAttribute('id', 'edges-layer');
        mainGroup.appendChild(edgesGroup);
        
        const nodesGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        nodesGroup.setAttribute('id', 'nodes-layer');
        mainGroup.appendChild(nodesGroup);
        
        const labelsGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        labelsGroup.setAttribute('id', 'labels-layer');
        mainGroup.appendChild(labelsGroup);
        
        // Render edges (lines only) first, labels collected separately
        renderEdges(edgesGroup, labelsGroup, layout);
        
        // Render nodes on top of edge lines
        renderNodes(nodesGroup, layout);

        // Setup zoom/pan
        setupZoomPan(width, height);
        
        // If there's a pending focus, navigate to that node; otherwise fit to view
        // Use requestAnimationFrame to ensure DOM is ready, then show SVG
        requestAnimationFrame(() => {
            if (pendingFocusNodeName) {
                navigateToNodeByName(pendingFocusNodeName);
                pendingFocusNodeName = null;
            } else {
                fitToView();
            }
            svg.style.visibility = 'visible';
        });
    }

    function dagreLayout() {
        const nodeWidth = 200;  // Wider to fit longer names
        const nodeHeight = 50;
        const rankSep = 80;
        const nodeSep = 50;

        // Build adjacency for incoming/outgoing edges
        const incoming = {};
        const outgoing = {};
        workflow.nodes.forEach(n => {
            incoming[n.id] = [];
            outgoing[n.id] = [];
        });
        workflow.edges.forEach(e => {
            if (!e.type?.startsWith('data_')) { // Only control flow edges for layout
                if (incoming[e.target]) incoming[e.target].push(e.source);
                if (outgoing[e.source]) outgoing[e.source].push(e.target);
            }
        });

        // Assign ranks (levels) using topological sort with BFS
        const ranks = {};
        const visited = new Set();
        const queue = [];
        
        // Find start node
        const startNode = workflow.nodes.find(n => n.type === 'start');
        if (startNode) {
            ranks[startNode.id] = 0;
            queue.push(startNode.id);
            visited.add(startNode.id);
        }

        while (queue.length > 0) {
            const nodeId = queue.shift();
            const currentRank = ranks[nodeId];
            
            for (const targetId of (outgoing[nodeId] || [])) {
                if (!visited.has(targetId)) {
                    ranks[targetId] = currentRank + 1;
                    visited.add(targetId);
                    queue.push(targetId);
                } else {
                    // Update rank if we found a longer path
                    ranks[targetId] = Math.max(ranks[targetId], currentRank + 1);
                }
            }
        }

        // Handle any unvisited nodes (assign them sequential ranks at the end)
        let maxVisitedRank = Math.max(0, ...Object.values(ranks).filter(r => r !== undefined));
        workflow.nodes.forEach((node, i) => {
            if (ranks[node.id] === undefined) {
                ranks[node.id] = maxVisitedRank + 1 + i;
            }
        });

        // Group nodes by rank
        const rankGroups = {};
        workflow.nodes.forEach(node => {
            const rank = ranks[node.id];
            if (!rankGroups[rank]) rankGroups[rank] = [];
            rankGroups[rank].push(node);
        });

        // Position nodes
        const positions = {};
        
        Object.entries(rankGroups).forEach(([rank, nodes]) => {
            const rankNum = parseInt(rank);
            if (isNaN(rankNum)) {
                console.error('Invalid rank:', rank, 'for nodes:', nodes.map(n => n.name));
                return;
            }
            const nodesInRank = nodes.length;
            const totalWidth = nodesInRank * nodeWidth + (nodesInRank - 1) * nodeSep;
            const startX = 300 - totalWidth / 2 + nodeWidth / 2;
            
            nodes.forEach((node, idx) => {
                positions[node.id] = {
                    x: startX + idx * (nodeWidth + nodeSep),
                    y: 50 + rankNum * (nodeHeight + rankSep)
                };
            });
        });

        return { positions, nodeWidth, nodeHeight };
    }

    function forceLayout() {
        const nodeWidth = 200;  // Wider to fit longer names
        const nodeHeight = 50;
        const positions = {};
        
        // Simple force-directed simulation
        const nodes = workflow.nodes.map((node, i) => ({
            id: node.id,
            x: 300 + Math.random() * 100,
            y: 50 + i * 80
        }));

        // Run simple force simulation
        for (let iter = 0; iter < 100; iter++) {
            // Repulsion between nodes
            for (let i = 0; i < nodes.length; i++) {
                for (let j = i + 1; j < nodes.length; j++) {
                    const dx = nodes[j].x - nodes[i].x;
                    const dy = nodes[j].y - nodes[i].y;
                    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
                    const force = 5000 / (dist * dist);
                    nodes[i].x -= dx / dist * force;
                    nodes[i].y -= dy / dist * force;
                    nodes[j].x += dx / dist * force;
                    nodes[j].y += dy / dist * force;
                }
            }
            
            // Attraction along edges
            workflow.edges.forEach(edge => {
                const source = nodes.find(n => n.id === edge.source);
                const target = nodes.find(n => n.id === edge.target);
                if (source && target) {
                    const dx = target.x - source.x;
                    const dy = target.y - source.y;
                    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
                    const force = dist * 0.01;
                    source.x += dx * force;
                    source.y += dy * force;
                    target.x -= dx * force;
                    target.y -= dy * force;
                }
            });
        }

        nodes.forEach(n => {
            positions[n.id] = { x: n.x, y: n.y };
        });

        return { positions, nodeWidth, nodeHeight };
    }

    function renderNodes(parent, layout) {
        const { positions, nodeWidth, nodeHeight } = layout;

        workflow.nodes.forEach(node => {
            const pos = positions[node.id];
            if (!pos || isNaN(pos.x) || isNaN(pos.y)) {
                console.warn('Node has invalid position, skipping:', node.name, pos);
                return;
            }
            
            const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
            group.classList.add('node', \`node-\${node.type}\`);
            group.setAttribute('transform', \`translate(\${pos.x - nodeWidth/2}, \${pos.y - nodeHeight/2})\`);
            group.dataset.nodeId = node.id;

            // Determine node dimensions based on type
            const nWidth = node.type === 'parallel' ? nodeWidth * 1.2 : nodeWidth;
            const nHeight = nodeHeight;

            // Create shape based on type
            let shape;
            if (node.type === 'decision') {
                shape = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
                const hw = nWidth / 2;
                const hh = nHeight / 2;
                shape.setAttribute('points', \`\${hw},0 \${nWidth},\${hh} \${hw},\${nHeight} 0,\${hh}\`);
            } else if (node.type === 'start' || node.type === 'end') {
                shape = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
                shape.setAttribute('width', nWidth);
                shape.setAttribute('height', nHeight);
                shape.setAttribute('rx', nHeight / 2);
            } else if (node.type === 'event') {
                // Event node - hexagon-like shape to stand out
                shape = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
                const inset = 12;
                shape.setAttribute('points', \`\${inset},0 \${nWidth - inset},0 \${nWidth},\${nHeight/2} \${nWidth - inset},\${nHeight} \${inset},\${nHeight} 0,\${nHeight/2}\`);
                
                // Add event icon (lightning bolt style indicator)
                const icon = document.createElementNS('http://www.w3.org/2000/svg', 'text');
                icon.setAttribute('x', 8);
                icon.setAttribute('y', nHeight / 2 + 5);
                icon.setAttribute('font-size', '14px');
                icon.setAttribute('fill', '#1a1a1a');  // Dark to match text on orange
                icon.textContent = '⚡';
                group.appendChild(icon);
            } else if (node.type === 'parallel') {
                // Parallel node with double border
                shape = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
                shape.setAttribute('width', nWidth);
                shape.setAttribute('height', nHeight);
                shape.setAttribute('rx', 5);
                shape.setAttribute('stroke-width', '4');
                
                // Add inner rect for double-border effect
                const innerRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
                innerRect.setAttribute('x', 4);
                innerRect.setAttribute('y', 4);
                innerRect.setAttribute('width', nWidth - 8);
                innerRect.setAttribute('height', nHeight - 8);
                innerRect.setAttribute('rx', 3);
                innerRect.setAttribute('fill', 'none');
                innerRect.setAttribute('stroke', 'var(--vscode-editor-background)');
                innerRect.setAttribute('stroke-width', '2');
                group.appendChild(innerRect);
            } else {
                shape = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
                shape.setAttribute('width', nWidth);
                shape.setAttribute('height', nHeight);
                shape.setAttribute('rx', 5);
            }
            group.insertBefore(shape, group.firstChild);

            // Add label - for events, show just the name (icon already indicates type)
            const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            text.classList.add('node-label');
            
            const labelText = node.type === 'event' ? node.name : node.label;
            const xOffset = node.type === 'event' ? 8 : 0;  // Offset for event icon
            
            // Check if we need multi-line (for long names like send_email_notification)
            if (labelText.length > 22) {
                // Split into two lines
                const midPoint = Math.ceil(labelText.length / 2);
                // Try to break at underscore near middle
                let breakIdx = labelText.lastIndexOf('_', midPoint + 5);
                if (breakIdx < midPoint - 5 || breakIdx === -1) {
                    breakIdx = midPoint;
                }
                const line1 = labelText.substring(0, breakIdx + 1);
                const line2 = labelText.substring(breakIdx + 1);
                
                text.setAttribute('x', nWidth / 2 + xOffset);
                text.setAttribute('y', nHeight / 2 - 4);
                text.setAttribute('text-anchor', 'middle');
                text.setAttribute('font-size', '12px');
                text.textContent = line1;
                
                const text2 = document.createElementNS('http://www.w3.org/2000/svg', 'text');
                text2.classList.add('node-label');
                text2.setAttribute('x', nWidth / 2 + xOffset);
                text2.setAttribute('y', nHeight / 2 + 10);
                text2.setAttribute('text-anchor', 'middle');
                text2.setAttribute('font-size', '12px');
                text2.textContent = line2;
                group.appendChild(text);
                group.appendChild(text2);
            } else {
                text.setAttribute('x', nWidth / 2 + xOffset);
                text.setAttribute('y', nHeight / 2 + 4);
                text.setAttribute('text-anchor', 'middle');
                text.textContent = labelText;
                group.appendChild(text);
            }

            // Add input/output badges if present
            if (node.input || node.output) {
                const badgeGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
                badgeGroup.classList.add('io-badges');
                
                if (node.input) {
                    const inputBadge = createIOBadge('in', truncateText(node.input, 12), -8, nHeight / 2 - 8);
                    badgeGroup.appendChild(inputBadge);
                }
                if (node.output) {
                    const outputBadge = createIOBadge('out', truncateText(node.output, 12), nWidth - 8, nHeight / 2 - 8);
                    badgeGroup.appendChild(outputBadge);
                }
                group.appendChild(badgeGroup);
            }

            // Add event listeners
            group.addEventListener('click', () => handleNodeClick(node));
            group.addEventListener('mouseenter', (e) => showTooltip(e, node));
            group.addEventListener('mouseleave', hideTooltip);

            parent.appendChild(group);
        });
    }

    function createIOBadge(type, text, x, y) {
        const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        g.setAttribute('transform', \`translate(\${x}, \${y})\`);
        g.classList.add('io-badge', \`io-badge-\${type}\`);
        
        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('rx', 3);
        rect.setAttribute('width', text.length * 6 + 8);
        rect.setAttribute('height', 16);
        rect.setAttribute('fill', type === 'in' ? '#4a6a8a' : '#6a8a5a');
        rect.setAttribute('opacity', '0.9');
        
        const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        label.setAttribute('x', 4);
        label.setAttribute('y', 12);
        label.setAttribute('font-size', '12px');
        label.setAttribute('fill', '#fff');
        label.textContent = text;
        
        g.appendChild(rect);
        g.appendChild(label);
        return g;
    }

    function renderEdges(parent, labelsParent, layout) {
        const { positions, nodeWidth, nodeHeight } = layout;

        workflow.edges.forEach(edge => {
            const sourcePos = positions[edge.source];
            const targetPos = positions[edge.target];
            
            if (!sourcePos || !targetPos) return;

            // Determine if this is a data flow edge
            const isDataFlowEdge = edge.type && edge.type.startsWith('data_');
            const isControlFlowEdge = !isDataFlowEdge;

            // Skip rendering based on toggle state
            if (isControlFlowEdge && !showControlFlow) return;
            if (isDataFlowEdge && !showDataFlow) return;

            const edgeGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
            edgeGroup.classList.add('edge-group');
            if (isDataFlowEdge) {
                edgeGroup.classList.add('data-flow-edge');
            } else {
                edgeGroup.classList.add('control-flow-edge');
            }

            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.classList.add('edge');
            
            // Apply type-specific classes
            if (edge.type === 'parallel') {
                path.classList.add('edge-parallel');
            } else if (edge.type === 'data_workflow_input') {
                path.classList.add('edge-data-workflow-input');
            } else if (edge.type === 'data_activity_output') {
                path.classList.add('edge-data-activity-output');
            } else if (edge.type === 'data_event') {
                path.classList.add('edge-data-event');
            }
            
            // Calculate edge path - offset data flow edges horizontally
            const xOffset = isDataFlowEdge ? (edge.type === 'data_workflow_input' ? -15 : 15) : 0;
            const startY = sourcePos.y + nodeHeight / 2;
            const endY = targetPos.y - nodeHeight / 2;
            const midY = (startY + endY) / 2;
            
            const startX = sourcePos.x + xOffset;
            const endX = targetPos.x + xOffset;
            
            const d = \`M \${startX} \${startY} 
                       C \${startX} \${midY}, 
                         \${endX} \${midY}, 
                         \${endX} \${endY}\`;
            
            path.setAttribute('d', d);
            
            // Use different arrowhead for data flow
            if (isDataFlowEdge) {
                path.setAttribute('marker-end', 'url(#arrowhead-data)');
            } else {
                path.setAttribute('marker-end', 'url(#arrowhead)');
            }
            
            edgeGroup.appendChild(path);

            // Add data source indicator for data flow edges (rendered with edge line)
            if (isDataFlowEdge && edge.dataSourceType) {
                const indicator = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
                indicator.setAttribute('cx', endX);
                indicator.setAttribute('cy', endY - 10);
                indicator.setAttribute('r', 4);
                if (edge.dataSourceType === 'workflow_input') {
                    indicator.setAttribute('fill', '#3B82F6');
                } else if (edge.dataSourceType === 'activity_output') {
                    indicator.setAttribute('fill', '#10B981');
                } else if (edge.dataSourceType === 'event_data') {
                    indicator.setAttribute('fill', '#F59E0B');
                }
                edgeGroup.appendChild(indicator);
            }

            parent.appendChild(edgeGroup);

            // Only show labels for control flow edges (like True/False on conditionals)
            // Data flow is shown in tooltips instead - cleaner visualization
            if (edge.label && !isDataFlowEdge) {
                const labelGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
                labelGroup.classList.add('edge-label-group');
                
                const textWidth = edge.label.length * 8 + 16;
                const gapMidY = (startY + endY) / 2;
                const labelX = (startX + endX) / 2 + 20;  // Offset to right of edge
                
                const labelBg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
                labelBg.setAttribute('x', labelX - textWidth / 2);
                labelBg.setAttribute('y', gapMidY - 9);
                labelBg.setAttribute('width', textWidth);
                labelBg.setAttribute('height', 18);
                labelBg.classList.add('edge-label-bg');
                labelBg.setAttribute('rx', 4);
                labelGroup.appendChild(labelBg);

                const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
                text.classList.add('edge-label');
                text.setAttribute('x', labelX);
                text.setAttribute('y', gapMidY + 4);
                text.setAttribute('text-anchor', 'middle');
                text.textContent = edge.label;
                labelGroup.appendChild(text);
                
                labelsParent.appendChild(labelGroup);
            }
        });
    }

    function setupZoomPan(width, height) {
        let scale = 1;
        let translateX = 0;
        let translateY = 0;
        let isDragging = false;
        let startX, startY;
        let spacePressed = false;

        const mainGroup = document.getElementById('main-group');

        function updateTransform() {
            mainGroup.setAttribute('transform', \`translate(\${translateX}, \${translateY}) scale(\${scale})\`);
        }

        // Track space key for pan mode
        document.addEventListener('keydown', (e) => {
            if (e.code === 'Space' && !e.repeat) {
                spacePressed = true;
                svg.style.cursor = 'grab';
            }
        });
        document.addEventListener('keyup', (e) => {
            if (e.code === 'Space') {
                spacePressed = false;
                svg.style.cursor = 'default';
            }
        });

        svg.addEventListener('wheel', (e) => {
            e.preventDefault();
            const delta = e.deltaY > 0 ? 0.9 : 1.1;
            scale *= delta;
            scale = Math.max(0.1, Math.min(5, scale));
            updateTransform();
        });

        svg.addEventListener('mousedown', (e) => {
            // Allow drag with space+click, or from SVG background, or middle mouse
            if (spacePressed || e.target === svg || e.button === 1) {
                isDragging = true;
                startX = e.clientX - translateX;
                startY = e.clientY - translateY;
                svg.style.cursor = 'grabbing';
                e.preventDefault();
            }
        });

        svg.addEventListener('mousemove', (e) => {
            if (isDragging) {
                translateX = e.clientX - startX;
                translateY = e.clientY - startY;
                updateTransform();
            }
        });

        svg.addEventListener('mouseup', () => {
            isDragging = false;
            svg.style.cursor = spacePressed ? 'grab' : 'default';
        });
        svg.addEventListener('mouseleave', () => {
            isDragging = false;
            svg.style.cursor = 'default';
        });

        // Store zoom functions for buttons
        window.zoomTo = (newScale) => {
            scale = Math.max(0.1, Math.min(5, newScale));
            updateTransform();
        };
        window.getScale = () => scale;
        window.setTranslate = (x, y) => {
            translateX = x;
            translateY = y;
            updateTransform();
        };
    }

    function zoomBy(factor) {
        if (window.zoomTo && window.getScale) {
            window.zoomTo(window.getScale() * factor);
        }
    }

    function fitToView() {
        const mainGroup = document.getElementById('main-group');
        if (!mainGroup) return;

        const bbox = mainGroup.getBBox();
        const container = document.getElementById('graph-container');
        const width = container.clientWidth;
        const height = container.clientHeight;

        const scale = Math.min(
            (width - 100) / bbox.width,
            (height - 100) / bbox.height,
            1.5
        );

        const translateX = (width - bbox.width * scale) / 2 - bbox.x * scale;
        const translateY = (height - bbox.height * scale) / 2 - bbox.y * scale;

        if (window.zoomTo) window.zoomTo(scale);
        if (window.setTranslate) window.setTranslate(translateX, translateY);
    }

    function handleNodeClick(node) {
        vscode.postMessage({
            type: 'nodeClick',
            nodeId: node.id
        });
    }

    function showTooltip(event, node) {
        const tooltip = document.getElementById('tooltip');
        let inputHtml = '';
        let outputHtml = '';
        let extraHtml = '';
        
        // Enhanced tooltip for Start node
        if (node.type === 'start' && workflow.metadata) {
            const meta = workflow.metadata;
            if (meta.inputType) {
                inputHtml = \`<div class="tooltip-io"><span class="tooltip-io-label">Input Type:</span> <code>\${meta.inputType}</code></div>\`;
            }
            if (meta.inputProperties && meta.inputProperties.length > 0) {
                extraHtml = \`<div class="tooltip-fields">
                    <span class="tooltip-io-label">Available as <code>input.*</code>:</span>
                    <ul class="tooltip-field-list">\${meta.inputProperties.map(f => '<li>input.' + f + '</li>').join('')}</ul>
                </div>\`;
            }
        }
        // Enhanced tooltip for End node
        else if (node.type === 'end' && workflow.metadata) {
            const meta = workflow.metadata;
            if (meta.outputType) {
                outputHtml = \`<div class="tooltip-io"><span class="tooltip-io-label">Output Type:</span> <code>\${meta.outputType}</code></div>\`;
            }
            if (meta.outputFields && meta.outputFields.length > 0) {
                extraHtml = \`<div class="tooltip-fields">
                    <span class="tooltip-io-label">Returns:</span>
                    <ul class="tooltip-field-list">\${meta.outputFields.map(f => '<li>' + f + '</li>').join('')}</ul>
                </div>\`;
            }
            if (meta.returnExpression && !extraHtml) {
                extraHtml = \`<div class="tooltip-io"><span class="tooltip-io-label">Returns:</span> <code>\${meta.returnExpression.substring(0, 60)}...</code></div>\`;
            }
        }
        // Standard tooltip for other nodes
        else {
            if (node.input) {
                inputHtml = \`<div class="tooltip-io"><span class="tooltip-io-label">Input:</span> <code>\${node.input}</code></div>\`;
            }
            if (node.output) {
                outputHtml = \`<div class="tooltip-io"><span class="tooltip-io-label">Output:</span> <code>\${node.output}</code></div>\`;
            }
        }
        
        tooltip.innerHTML = \`
            <div class="tooltip-type">\${node.type}</div>
            <div class="tooltip-title">\${node.name}</div>
            \${inputHtml}
            \${outputHtml}
            \${extraHtml}
            \${node.metadata?.fullCondition ? '<div class="tooltip-condition">Condition: ' + node.metadata.fullCondition + '</div>' : ''}
            \${node.metadata?.tasks ? '<div class="tooltip-tasks">Tasks: ' + node.metadata.tasks.join(', ') + '</div>' : ''}
            \${node.metadata?.lineNumber ? '<div class="tooltip-line">Line: ' + node.metadata.lineNumber + '</div>' : ''}
        \`;
        tooltip.style.display = 'block';
        tooltip.style.left = (event.pageX + 10) + 'px';
        tooltip.style.top = (event.pageY + 10) + 'px';
    }

    function hideTooltip() {
        document.getElementById('tooltip').style.display = 'none';
    }

    function exportSvg() {
        const svgClone = svg.cloneNode(true);
        const serializer = new XMLSerializer();
        const svgString = serializer.serializeToString(svgClone);
        
        vscode.postMessage({
            type: 'exportSvg',
            svg: svgString
        });
    }

    function showEmptyState() {
        svg.innerHTML = \`
            <g transform="translate(50%, 50%)">
                <text text-anchor="middle" fill="var(--vscode-descriptionForeground)">
                    Open a Dapr workflow file and click "Visualize Dapr Workflow"
                </text>
            </g>
        \`;
    }

    function truncateText(text, maxLength) {
        return text.length > maxLength ? text.substring(0, maxLength - 3) + '...' : text;
    }

    // Initialize on load
    init();
})();
        `;
    }

    /**
     * Generate a nonce for CSP
     */
    private _getNonce(): string {
        let text = '';
        const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        for (let i = 0; i < 32; i++) {
            text += possible.charAt(Math.floor(Math.random() * possible.length));
        }
        return text;
    }

    /**
     * Dispose of the panel
     */
    public dispose(): void {
        WorkflowVisualizerPanel.currentPanel = undefined;

        this._panel.dispose();

        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }
}
