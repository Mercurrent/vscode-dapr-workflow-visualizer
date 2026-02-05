import { BaseWorkflowParser } from './baseParser';
import { 
    ParseResult, 
    WorkflowDefinition, 
    WorkflowNode, 
    DataSource, 
    DataSourceType,
    DataFlowMetadata,
    ActivityDataFlow,
    WorkflowEdge,
    SupportedLanguage
} from '../types/workflow';

/**
 * Parser for JavaScript/TypeScript Dapr Workflow definitions
 * 
 * Supports patterns like:
 * - yield ctx.callActivity("activityName", input)
 * - yield ctx.callSubOrchestration("orchestrationName", input)
 * - yield ctx.createTimer(duration)
 * - yield ctx.waitForExternalEvent("eventName")
 * - await ctx.callActivity(...)
 * - Promise.all([...]) / ctx.whenAll([...])
 * 
 * Enhanced with data flow analysis to track:
 * - workflow_input: Data from original workflow input
 * - activity_output: Data from previous activity results
 * - event_data: Data from external events
 * - constructed: Objects built from multiple sources
 */
export class JavaScriptWorkflowParser extends BaseWorkflowParser {
    private outputVariableMap: Map<string, string> = new Map();
    private workflowInputParam: string = 'input';
    private inputProperties: string[] = [];
    // Track parallel task variable -> node ID mapping
    private parallelTaskMap: Map<string, string> = new Map();
    // Track which nodes are part of parallel groups: nodeId -> parallelGroupId
    private parallelGroupMap: Map<string, string> = new Map();

    constructor(language: SupportedLanguage = 'javascript') {
        super(language);
    }

    canParse(filePath: string): boolean {
        return filePath.endsWith('.js') || 
               filePath.endsWith('.ts') || 
               filePath.endsWith('.mjs') ||
               filePath.endsWith('.mts');
    }

    /**
     * Find all workflows defined in the file with their code ranges
     */
    findAllWorkflows(sourceCode: string): Array<{name: string, startLine: number, endLine: number, startIndex: number, endIndex: number}> {
        const workflows: Array<{name: string, startLine: number, endLine: number, startIndex: number, endIndex: number}> = [];
        const lines = sourceCode.split('\n');
        
        // Match generator functions (function* or async function*)
        const generatorPattern = /(?:export\s+)?(?:async\s+)?function\s*\*\s*(\w+)/g;
        // Match arrow functions assigned to const with workflow-like signature
        const arrowPattern = /(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*ctx\s*:\s*WorkflowContext/g;
        
        let match;
        const allMatches: Array<{name: string, startIndex: number, line: number}> = [];
        
        while ((match = generatorPattern.exec(sourceCode)) !== null) {
            const name = match[1];
            const startIndex = match.index;
            const line = this.getLineNumber(sourceCode, startIndex);
            allMatches.push({ name, startIndex, line });
        }
        
        while ((match = arrowPattern.exec(sourceCode)) !== null) {
            const name = match[1];
            const startIndex = match.index;
            const line = this.getLineNumber(sourceCode, startIndex);
            // Avoid duplicates
            if (!allMatches.some(m => m.name === name)) {
                allMatches.push({ name, startIndex, line });
            }
        }
        
        // Sort by startIndex
        allMatches.sort((a, b) => a.startIndex - b.startIndex);
        
        // For each workflow, find where it ends
        for (let i = 0; i < allMatches.length; i++) {
            const current = allMatches[i];
            const next = allMatches[i + 1];
            
            let endIndex: number;
            let endLine: number;
            
            if (next) {
                endIndex = next.startIndex - 1;
                endLine = next.line - 1;
            } else {
                endIndex = sourceCode.length;
                endLine = lines.length;
            }
            
            workflows.push({
                name: current.name,
                startLine: current.line,
                endLine,
                startIndex: current.startIndex,
                endIndex
            });
        }
        
        return workflows;
    }

    parse(sourceCode: string, filePath: string, targetWorkflowName?: string): ParseResult {
        try {
            // Reset state
            this.outputVariableMap = new Map();
            this.parallelTaskMap = new Map();
            this.parallelGroupMap = new Map();
            
            // Find all workflows in the file
            const allWorkflows = this.findAllWorkflows(sourceCode);
            
            // If a specific workflow is requested, extract only its code
            let scopedSourceCode = sourceCode;
            let lineOffset = 0;
            let workflowName: string;
            
            if (targetWorkflowName && allWorkflows.length > 0) {
                const targetWorkflow = allWorkflows.find(w => w.name === targetWorkflowName);
                if (targetWorkflow) {
                    scopedSourceCode = sourceCode.slice(targetWorkflow.startIndex, targetWorkflow.endIndex);
                    lineOffset = targetWorkflow.startLine - 1;
                    workflowName = targetWorkflow.name;
                } else {
                    workflowName = this.extractWorkflowName(sourceCode, filePath);
                }
            } else if (allWorkflows.length > 0) {
                const firstWorkflow = allWorkflows[0];
                scopedSourceCode = sourceCode.slice(firstWorkflow.startIndex, firstWorkflow.endIndex);
                lineOffset = firstWorkflow.startLine - 1;
                workflowName = firstWorkflow.name;
            } else {
                workflowName = this.extractWorkflowName(sourceCode, filePath);
            }
            
            const workflow = this.createEmptyWorkflow(workflowName, filePath);
            
            // Store line offset for later adjustment
            (workflow as any)._lineOffset = lineOffset;

            // Extract workflow metadata
            workflow.metadata = this.extractMetadata(sourceCode, scopedSourceCode);
            
            // Extract workflow input parameter name
            this.extractWorkflowInputInfo(scopedSourceCode);
            
            // Extract return/output info
            this.extractReturnInfo(scopedSourceCode, workflow);

            // Parse workflow components
            const activities = this.parseActivities(scopedSourceCode, lineOffset);
            const subOrchestrations = this.parseSubOrchestrations(scopedSourceCode, lineOffset);
            const timers = this.parseTimers(scopedSourceCode, lineOffset);
            const events = this.parseExternalEvents(scopedSourceCode, lineOffset);
            const decisions = this.parseDecisions(scopedSourceCode, lineOffset);
            const parallelBlocks = this.parseParallelBlocks(scopedSourceCode, lineOffset);

            // Add all nodes
            workflow.nodes.push(...activities);
            workflow.nodes.push(...subOrchestrations);
            workflow.nodes.push(...timers);
            workflow.nodes.push(...events);
            workflow.nodes.push(...decisions);
            workflow.nodes.push(...parallelBlocks);

            // Add start and end nodes
            this.addStartEndNodes(workflow);

            // Build data flow metadata
            workflow.dataFlow = this.buildDataFlowMetadata(workflow, scopedSourceCode);

            // Build edges with data flow information
            this.buildEdgesWithDataFlow(workflow, scopedSourceCode);

            return { success: true, workflow };
        } catch (error) {
            return {
                success: false,
                errors: [{
                    message: error instanceof Error ? error.message : 'Unknown parsing error'
                }]
            };
        }
    }

    /**
     * Extract workflow input parameter name
     */
    private extractWorkflowInputInfo(sourceCode: string): void {
        // Generator function: function* workflowName(ctx, input)
        const generatorMatch = sourceCode.match(/function\s*\*\s*\w+\s*\([^,]+,\s*(\w+)/);
        if (generatorMatch) {
            this.workflowInputParam = generatorMatch[1];
            return;
        }
        
        // Arrow function with typed params: (ctx: WorkflowContext, input: OrderInput)
        const arrowMatch = sourceCode.match(/\(\s*\w+\s*:\s*WorkflowContext[^,]*,\s*(\w+)\s*:/);
        if (arrowMatch) {
            this.workflowInputParam = arrowMatch[1];
            return;
        }
        
        // Regular function: async function workflowName(ctx, input)
        const funcMatch = sourceCode.match(/async\s+function\s+\w+\s*\([^,]+,\s*(\w+)/);
        if (funcMatch) {
            this.workflowInputParam = funcMatch[1];
        }
    }

    /**
     * Analyze an input expression to determine its data source
     */
    private analyzeDataSource(inputExpr: string | undefined): DataSource[] {
        if (!inputExpr) {
            return [];
        }

        const sources: DataSource[] = [];
        const inputParam = this.workflowInputParam;

        // Check if it's an object literal with multiple sources
        if (inputExpr.startsWith('{') && inputExpr.endsWith('}')) {
            const entries = this.parseObjectEntries(inputExpr.slice(1, -1));
            
            for (const entry of entries) {
                const source = this.classifyExpression(entry.value, entry.key);
                sources.push(source);
            }
            
            return sources;
        }

        // Single expression
        const source = this.classifyExpression(inputExpr);
        return [source];
    }

    /**
     * Parse object literal entries
     */
    private parseObjectEntries(content: string): Array<{ key: string; value: string }> {
        const entries: Array<{ key: string; value: string }> = [];
        
        let depth = 0;
        let current = '';
        
        for (const char of content) {
            if (char === '{' || char === '[' || char === '(') { depth++; }
            if (char === '}' || char === ']' || char === ')') { depth--; }
            
            if (char === ',' && depth === 0) {
                const entry = this.parseKeyValue(current.trim());
                if (entry) { entries.push(entry); }
                current = '';
            } else {
                current += char;
            }
        }
        
        if (current.trim()) {
            const entry = this.parseKeyValue(current.trim());
            if (entry) { entries.push(entry); }
        }
        
        return entries;
    }

    /**
     * Parse a key: value pair from object literal
     */
    private parseKeyValue(str: string): { key: string; value: string } | null {
        const colonIdx = str.indexOf(':');
        if (colonIdx === -1) {
            // Shorthand property: { input } -> { input: input }
            const trimmed = str.trim();
            return { key: trimmed, value: trimmed };
        }
        
        const key = str.slice(0, colonIdx).trim().replace(/["']/g, '');
        const value = str.slice(colonIdx + 1).trim();
        
        return { key, value };
    }

    /**
     * Classify a single expression as workflow_input or activity_output
     */
    private classifyExpression(expr: string, targetProperty?: string): DataSource {
        const inputParam = this.workflowInputParam;
        
        // Check if it references the workflow input parameter
        if (expr === inputParam || expr.startsWith(`${inputParam}.`) || expr.startsWith(`${inputParam}[`)) {
            return {
                sourceType: 'workflow_input',
                sourcePath: expr,
                targetProperty
            };
        }
        
        // Check if it references a known activity output variable
        for (const [varName, activityId] of this.outputVariableMap.entries()) {
            if (expr === varName || expr.startsWith(`${varName}.`) || expr.startsWith(`${varName}[`)) {
                return {
                    sourceType: 'activity_output',
                    sourcePath: expr,
                    sourceActivityId: activityId,
                    targetProperty
                };
            }
        }
        
        // Check for string literals
        if ((expr.startsWith('"') && expr.endsWith('"')) || 
            (expr.startsWith("'") && expr.endsWith("'")) ||
            (expr.startsWith('`') && expr.endsWith('`'))) {
            return {
                sourceType: 'literal',
                sourcePath: expr,
                targetProperty
            };
        }
        
        // Default to workflow_input for variable references
        if (/^\w+(\.\w+|\[\w+\])*$/.test(expr)) {
            return {
                sourceType: 'workflow_input',
                sourcePath: expr,
                targetProperty
            };
        }
        
        return {
            sourceType: 'literal',
            sourcePath: expr,
            targetProperty
        };
    }

    private extractWorkflowName(sourceCode: string, filePath: string): string {
        // Look for exported workflow function
        const exportMatch = sourceCode.match(/export\s+(?:const|function\s*\*?|async\s+function\s*\*?)\s+(\w+)/);
        if (exportMatch) {
            return exportMatch[1];
        }

        // Look for DaprWorkflowClient registration
        const registerMatch = sourceCode.match(/registerWorkflow\s*\(\s*(\w+)/);
        if (registerMatch) {
            return registerMatch[1];
        }

        // Look for function* or async function* (generator-based workflows)
        const generatorMatch = sourceCode.match(/(?:async\s+)?function\s*\*\s*(\w+)/);
        if (generatorMatch) {
            return generatorMatch[1];
        }

        // Look for arrow function assigned to const
        const arrowMatch = sourceCode.match(/const\s+(\w*[Ww]orkflow\w*)\s*=/);
        if (arrowMatch) {
            return arrowMatch[1];
        }

        // Fallback to file name
        const fileName = filePath.split('/').pop() || filePath.split('\\').pop() || 'Unknown';
        return fileName.replace(/\.(js|ts|mjs|mts)$/, '');
    }

    private extractMetadata(fullSource: string, scopedSource: string): WorkflowDefinition['metadata'] {
        const metadata: WorkflowDefinition['metadata'] = {
            inputProperties: []
        };

        // Extract JSDoc description
        const jsdocMatch = scopedSource.match(/\/\*\*\s*\n([^*]*(?:\*[^/][^*]*)*)\*\//);
        if (jsdocMatch) {
            const description = jsdocMatch[1]
                .split('\n')
                .map(line => line.replace(/^\s*\*\s?/, '').trim())
                .filter(line => !line.startsWith('@'))
                .join(' ')
                .trim();
            if (description) {
                metadata.description = description;
            }
        }

        // Extract TypeScript input/output types from function signature
        const typeMatch = scopedSource.match(/(?:ctx|context)\s*:\s*WorkflowContext(?:<[^>]*>)?\s*,\s*\w+\s*:\s*(\w+)[^)]*\)\s*(?::\s*(?:AsyncGenerator<[^,]+,\s*)?(\w+))?/);
        if (typeMatch) {
            metadata.inputType = typeMatch[1];
            if (typeMatch[2]) {
                metadata.outputType = typeMatch[2];
            }
        }

        // Extract input properties from interface definition
        if (metadata.inputType) {
            const interfacePattern = new RegExp(
                `interface\\s+${metadata.inputType}\\s*{([^}]+)}`,
                'm'
            );
            const interfaceMatch = fullSource.match(interfacePattern);
            if (interfaceMatch) {
                const propPattern = /(\w+)\s*[?]?\s*:/g;
                let propMatch;
                while ((propMatch = propPattern.exec(interfaceMatch[1])) !== null) {
                    metadata.inputProperties!.push(propMatch[1]);
                }
            }
        }

        return metadata;
    }

    /**
     * Extract return statement info
     */
    private extractReturnInfo(sourceCode: string, workflow: WorkflowDefinition): void {
        // Find return statements
        const returnPattern = /return\s+({[^}]+}|\w+)/g;
        const returns: string[] = [];
        let match;
        
        while ((match = returnPattern.exec(sourceCode)) !== null) {
            returns.push(match[1].trim());
        }
        
        if (returns.length === 0) { return; }
        
        const allFields: string[] = [];
        
        for (const expr of returns) {
            const fields = this.parseReturnExpression(expr);
            for (const f of fields) {
                if (!allFields.includes(f)) {
                    allFields.push(f);
                }
            }
        }
        
        if (!workflow.metadata) { workflow.metadata = {}; }
        workflow.metadata.outputFields = allFields;
        workflow.metadata.returnExpression = returns[returns.length - 1];
    }

    /**
     * Parse a return expression to extract field names
     */
    private parseReturnExpression(expression: string): string[] {
        const fields: string[] = [];
        
        if (expression.startsWith('{')) {
            // Object literal: { key: value, key2: value2 }
            const keyPattern = /(\w+)\s*:/g;
            let keyMatch;
            while ((keyMatch = keyPattern.exec(expression)) !== null) {
                fields.push(keyMatch[1]);
            }
        }
        
        return fields;
    }

    /**
     * Extract the input expression from a callActivity call
     */
    private extractInputExpression(sourceCode: string, matchIndex: number): string | undefined {
        const callStart = sourceCode.indexOf('callActivity', matchIndex);
        if (callStart === -1) { return undefined; }
        
        const parenStart = sourceCode.indexOf('(', callStart);
        if (parenStart === -1) { return undefined; }
        
        // Find the second argument (after the activity name)
        let depth = 1;
        let i = parenStart + 1;
        let argStart = -1;
        let argCount = 0;
        let inString: string | null = null;
        
        while (i < sourceCode.length && depth > 0) {
            const char = sourceCode[i];
            const prevChar = sourceCode[i - 1];
            
            // Handle string literals
            if ((char === '"' || char === "'" || char === '`') && prevChar !== '\\') {
                if (inString === null) {
                    inString = char;
                } else if (inString === char) {
                    inString = null;
                }
            }
            
            if (inString === null) {
                if (char === '(' || char === '{' || char === '[') { depth++; }
                if (char === ')' || char === '}' || char === ']') { depth--; }
                
                if (char === ',' && depth === 1) {
                    argCount++;
                    if (argCount === 1) {
                        argStart = i + 1;
                    }
                }
            }
            i++;
        }
        
        if (argStart > 0) {
            return sourceCode.substring(argStart, i - 1).trim();
        }
        
        return undefined;
    }

    private parseActivities(sourceCode: string, lineOffset: number = 0): WorkflowNode[] {
        const nodes: WorkflowNode[] = [];
        
        // Pattern for awaited/yielded activities
        const awaitedPattern = /(?:const\s+)?(\w+)?\s*=?\s*(?:yield|await)\s+ctx\.callActivity(?:<[^>]+>)?\s*\(\s*["']([^"']+)["']/g;
        
        // Pattern for non-awaited activities (parallel tasks)
        const taskPattern = /(?:const\s+)?(\w+(?:Promise|Task)?)\s*=\s*ctx\.callActivity(?:<[^>]+>)?\s*\(\s*["']([^"']+)["']/g;
        
        let match;
        let index = 0;
        const seenLines = new Set<number>();
        
        // First, parse non-awaited task assignments (parallel tasks)
        while ((match = taskPattern.exec(sourceCode)) !== null) {
            const taskVar = match[1];
            const activityName = match[2];
            const lineNum = this.getLineNumber(sourceCode, match.index) + lineOffset;
            
            // Skip if already seen
            if (seenLines.has(lineNum)) { continue; }
            seenLines.add(lineNum);
            
            const inputExpr = this.extractInputExpression(sourceCode, match.index);
            const nodeId = `activity-${index++}`;
            
            // Check if this looks like a parallel task (not immediately awaited)
            const isParallel = !sourceCode.substring(Math.max(0, match.index - 20), match.index).match(/yield|await/);
            
            if (isParallel) {
                this.parallelTaskMap.set(taskVar, nodeId);
            }
            
            const dataSources = this.analyzeDataSource(inputExpr);
            
            const node = this.createNode(
                nodeId,
                'activity',
                activityName,
                activityName,
                { 
                    lineNumber: lineNum,
                    dataSources: dataSources,
                    isParallelTask: isParallel,
                    taskVariable: isParallel ? taskVar : undefined
                }
            );
            node.output = taskVar;
            node.input = inputExpr;
            node.dataSources = dataSources;
            
            if (!isParallel) {
                this.outputVariableMap.set(taskVar, nodeId);
            }
            
            nodes.push(node);
        }
        
        // Then parse awaited activities
        while ((match = awaitedPattern.exec(sourceCode)) !== null) {
            const outputVar = match[1] || undefined;
            const activityName = match[2];
            const lineNum = this.getLineNumber(sourceCode, match.index) + lineOffset;
            
            // Skip if already processed
            if (seenLines.has(lineNum)) { continue; }
            seenLines.add(lineNum);
            
            const inputExpr = this.extractInputExpression(sourceCode, match.index);
            const nodeId = `activity-${index++}`;
            
            if (outputVar) {
                this.outputVariableMap.set(outputVar, nodeId);
            }
            
            const dataSources = this.analyzeDataSource(inputExpr);
            
            const node = this.createNode(
                nodeId,
                'activity',
                activityName,
                activityName,
                { 
                    lineNumber: lineNum,
                    dataSources: dataSources,
                    isParallelTask: false
                }
            );
            node.output = outputVar;
            node.input = inputExpr;
            node.dataSources = dataSources;
            nodes.push(node);
        }

        // Also match variable-based activity calls
        const varActivityPattern = /(?:yield|await)\s+ctx\.callActivity(?:<[^>]+>)?\s*\(\s*(\w+)(?:\s*,|\s*\))/g;
        while ((match = varActivityPattern.exec(sourceCode)) !== null) {
            const activityName = match[1];
            const lineNum = this.getLineNumber(sourceCode, match.index) + lineOffset;
            
            if (seenLines.has(lineNum)) { continue; }
            seenLines.add(lineNum);
            
            if (!activityName.startsWith('"') && !activityName.startsWith("'")) {
                nodes.push(this.createNode(
                    `activity-${index++}`,
                    'activity',
                    activityName,
                    `${activityName} (var)`,
                    { lineNumber: lineNum }
                ));
            }
        }

        return nodes;
    }

    private parseParallelBlocks(sourceCode: string, lineOffset: number = 0): WorkflowNode[] {
        const nodes: WorkflowNode[] = [];
        
        // Match Promise.all, Promise.race, ctx.whenAll patterns
        const parallelPattern = /(?:const\s+)?(?:\[([^\]]+)\]|(\w+))\s*=\s*(?:yield|await)\s+(?:Promise\.(?:all|race)|ctx\.(?:allOf|whenAll))\s*\(\s*\[([^\]]+)\]/g;
        
        let match;
        let index = 0;
        while ((match = parallelPattern.exec(sourceCode)) !== null) {
            const destructuredVars = match[1]?.split(',').map(s => s.trim()) || [];
            const singleVar = match[2];
            const tasksContent = match[3];
            
            const outputs = singleVar ? [singleVar] : destructuredVars;
            
            // Extract task variable names
            const taskVars = tasksContent.match(/\w+(?:Promise|Task)?/g) || [];
            
            const nodeId = `parallel-join-${index++}`;
            
            // Track output variables
            outputs.forEach((outputVar) => {
                if (outputVar) {
                    this.outputVariableMap.set(outputVar, nodeId);
                }
            });
            
            // Map each task variable to this parallel join node
            taskVars.forEach(taskVar => {
                const activityNodeId = this.parallelTaskMap.get(taskVar);
                if (activityNodeId) {
                    this.parallelGroupMap.set(activityNodeId, nodeId);
                }
            });
            
            const node = this.createNode(
                nodeId,
                'parallel',
                'Join',
                `⫴ Join (${taskVars.length} tasks)`,
                { 
                    lineNumber: this.getLineNumber(sourceCode, match.index) + lineOffset,
                    tasks: taskVars,
                    outputs: outputs,
                    taskNodeIds: taskVars.map(t => this.parallelTaskMap.get(t)).filter(Boolean)
                }
            );
            nodes.push(node);
        }
        
        return nodes;
    }

    private parseSubOrchestrations(sourceCode: string, lineOffset: number = 0): WorkflowNode[] {
        const nodes: WorkflowNode[] = [];
        const subOrchPattern = /(?:const\s+)?(\w+)?\s*=?\s*(?:yield|await)\s+ctx\.(?:callSubOrchestration|callChildWorkflow)(?:<[^>]+>)?\s*\(\s*["']([^"']+)["'](?:\s*,\s*([^)]+))?\)/g;
        
        let match;
        let index = 0;
        while ((match = subOrchPattern.exec(sourceCode)) !== null) {
            const outputVar = match[1] || undefined;
            const orchName = match[2];
            const inputExpr = match[3]?.trim();
            
            const nodeId = `suborch-${index++}`;
            
            if (outputVar) {
                this.outputVariableMap.set(outputVar, nodeId);
            }
            
            const dataSources = this.analyzeDataSource(inputExpr);
            
            const node = this.createNode(
                nodeId,
                'subOrchestration',
                orchName,
                `Child: ${orchName}`,
                { 
                    lineNumber: this.getLineNumber(sourceCode, match.index) + lineOffset,
                    dataSources: dataSources
                }
            );
            node.output = outputVar;
            node.input = inputExpr;
            node.dataSources = dataSources;
            nodes.push(node);
        }

        return nodes;
    }

    private parseTimers(sourceCode: string, lineOffset: number = 0): WorkflowNode[] {
        const nodes: WorkflowNode[] = [];
        const timerPattern = /(?:const\s+)?(\w+)?\s*=?\s*(?:yield|await)\s+ctx\.createTimer\s*\(([^)]+)\)/g;
        
        let match;
        let index = 0;
        while ((match = timerPattern.exec(sourceCode)) !== null) {
            const outputVar = match[1] || undefined;
            const duration = match[2]?.trim();
            
            const nodeId = `timer-${index++}`;
            
            if (outputVar) {
                this.outputVariableMap.set(outputVar, nodeId);
            }
            
            const node = this.createNode(
                nodeId,
                'timer',
                'Timer',
                duration ? `Wait: ${duration.substring(0, 20)}` : 'Wait Timer',
                { lineNumber: this.getLineNumber(sourceCode, match.index) + lineOffset }
            );
            node.output = outputVar;
            nodes.push(node);
        }

        return nodes;
    }

    private parseExternalEvents(sourceCode: string, lineOffset: number = 0): WorkflowNode[] {
        const nodes: WorkflowNode[] = [];
        const eventPattern = /(?:const\s+)?(\w+)?\s*=?\s*(?:yield|await)?\s*ctx\.waitForExternalEvent(?:<[^>]+>)?\s*\(\s*["']([^"']+)["']/g;
        
        let match;
        let index = 0;
        while ((match = eventPattern.exec(sourceCode)) !== null) {
            const outputVar = match[1] || undefined;
            const eventName = match[2];
            
            const nodeId = `event-${index++}`;
            
            if (outputVar) {
                this.outputVariableMap.set(outputVar, nodeId);
            }
            
            const node = this.createNode(
                nodeId,
                'event',
                eventName,
                `Event: ${eventName}`,
                { lineNumber: this.getLineNumber(sourceCode, match.index) + lineOffset }
            );
            node.output = outputVar;
            node.dataSources = [{ sourceType: 'event_data', sourcePath: eventName }];
            nodes.push(node);
        }

        return nodes;
    }

    private parseDecisions(sourceCode: string, lineOffset: number = 0): WorkflowNode[] {
        const nodes: WorkflowNode[] = [];
        // Look for if statements with workflow operations
        const ifPattern = /if\s*\(([^)]+)\)\s*{[^}]*(?:yield|await)\s+ctx\./g;
        
        let match;
        let index = 0;
        while ((match = ifPattern.exec(sourceCode)) !== null) {
            const condition = match[1].trim();
            
            const dataSources = this.analyzeConditionSources(condition);
            
            const node = this.createNode(
                `decision-${index++}`,
                'decision',
                `Decision ${index}`,
                condition.length > 30 ? condition.substring(0, 30) + '...' : condition,
                { 
                    lineNumber: this.getLineNumber(sourceCode, match.index) + lineOffset,
                    fullCondition: condition,
                    dataSources: dataSources
                }
            );
            node.dataSources = dataSources;
            nodes.push(node);
        }

        return nodes;
    }

    /**
     * Analyze a condition expression to find data sources
     */
    private analyzeConditionSources(condition: string): DataSource[] {
        const sources: DataSource[] = [];
        const inputParam = this.workflowInputParam;
        
        // Check for workflow input references
        const inputPattern = new RegExp(`${inputParam}(?:\\.|\\[)[\\w"'\\[\\].]+`, 'g');
        let match;
        while ((match = inputPattern.exec(condition)) !== null) {
            sources.push({
                sourceType: 'workflow_input',
                sourcePath: match[0]
            });
        }
        
        // Check for activity output references
        for (const [varName] of this.outputVariableMap.entries()) {
            const varPattern = new RegExp(`${varName}(?:\\.|\\[)[\\w"'\\[\\].]+|${varName}(?![\\w])`, 'g');
            while ((match = varPattern.exec(condition)) !== null) {
                sources.push({
                    sourceType: 'activity_output',
                    sourcePath: match[0],
                    sourceActivityId: this.outputVariableMap.get(varName)
                });
            }
        }
        
        return sources;
    }

    /**
     * Build comprehensive data flow metadata
     */
    private buildDataFlowMetadata(workflow: WorkflowDefinition, sourceCode: string): DataFlowMetadata {
        const activities: ActivityDataFlow[] = [];
        
        for (const node of workflow.nodes) {
            if (node.type === 'activity' || node.type === 'subOrchestration' || node.type === 'event') {
                activities.push({
                    nodeId: node.id,
                    name: node.name,
                    type: node.type,
                    inputs: node.dataSources || [],
                    output: node.output ? {
                        variableName: node.output,
                        type: undefined
                    } : undefined,
                    lineNumber: node.metadata?.lineNumber as number
                });
            }
        }
        
        return {
            workflow: workflow.name,
            workflowInput: {
                type: workflow.metadata?.inputType,
                properties: workflow.metadata?.inputProperties || this.inputProperties,
                parameterName: this.workflowInputParam
            },
            activities,
            outputVariableMap: this.outputVariableMap
        };
    }

    /**
     * Build edges with data flow information and proper parallel support
     */
    private buildEdgesWithDataFlow(workflow: WorkflowDefinition, sourceCode: string): void {
        this.buildControlFlowEdges(workflow);
        
        // Add data flow edges
        const dataFlowEdges: WorkflowEdge[] = [];
        
        for (const node of workflow.nodes) {
            if (!node.dataSources || node.dataSources.length === 0) { continue; }
            
            for (const source of node.dataSources) {
                if (source.sourceType === 'workflow_input') {
                    dataFlowEdges.push({
                        id: `df-start-${node.id}-${source.sourcePath}`,
                        source: 'start',
                        target: node.id,
                        type: 'data_workflow_input',
                        dataFlow: source.sourcePath,
                        dataSourceType: 'workflow_input',
                        label: source.targetProperty || this.getShortPath(source.sourcePath)
                    });
                } else if (source.sourceType === 'activity_output' && source.sourceActivityId) {
                    dataFlowEdges.push({
                        id: `df-${source.sourceActivityId}-${node.id}-${source.sourcePath}`,
                        source: source.sourceActivityId,
                        target: node.id,
                        type: 'data_activity_output',
                        dataFlow: source.sourcePath,
                        dataSourceType: 'activity_output',
                        label: source.targetProperty || this.getShortPath(source.sourcePath)
                    });
                } else if (source.sourceType === 'event_data') {
                    dataFlowEdges.push({
                        id: `df-event-${node.id}`,
                        source: node.id,
                        target: node.id,
                        type: 'data_event',
                        dataFlow: source.sourcePath,
                        dataSourceType: 'event_data'
                    });
                }
            }
        }
        
        workflow.edges.push(...dataFlowEdges);
    }

    /**
     * Build control flow edges with proper parallel block handling
     */
    private buildControlFlowEdges(workflow: WorkflowDefinition): void {
        const sortedNodes = [...workflow.nodes].sort((a, b) => {
            const lineA = (a.metadata?.lineNumber as number) || 0;
            const lineB = (b.metadata?.lineNumber as number) || 0;
            return lineA - lineB;
        });

        const parallelTaskNodeIds = new Set<string>();
        const joinNodeIds = new Set<string>();
        const processedParallelGroups = new Set<string>();
        
        for (const node of sortedNodes) {
            if (node.metadata?.isParallelTask) {
                parallelTaskNodeIds.add(node.id);
            }
            if (node.type === 'parallel' && node.id.startsWith('parallel-join')) {
                joinNodeIds.add(node.id);
            }
        }

        let lastSequentialNode: WorkflowNode | null = null;
        
        for (let i = 0; i < sortedNodes.length; i++) {
            const node = sortedNodes[i];
            
            if (node.type === 'start') {
                lastSequentialNode = node;
                continue;
            }
            
            if (node.type === 'end') {
                continue;
            }

            if (parallelTaskNodeIds.has(node.id)) {
                const joinNodeId = this.parallelGroupMap.get(node.id);
                
                if (!joinNodeId) {
                    if (lastSequentialNode && lastSequentialNode.id !== node.id) {
                        workflow.edges.push({
                            id: `${lastSequentialNode.id}-${node.id}`,
                            source: lastSequentialNode.id,
                            target: node.id,
                            type: 'default'
                        });
                    }
                    lastSequentialNode = node;
                    continue;
                }
                
                if (processedParallelGroups.has(joinNodeId)) {
                    continue;
                }
                
                processedParallelGroups.add(joinNodeId);
                
                const parallelGroup: WorkflowNode[] = [];
                for (const pNode of sortedNodes) {
                    if (this.parallelGroupMap.get(pNode.id) === joinNodeId) {
                        parallelGroup.push(pNode);
                    }
                }
                
                if (lastSequentialNode) {
                    for (const pNode of parallelGroup) {
                        workflow.edges.push({
                            id: `${lastSequentialNode.id}-${pNode.id}`,
                            source: lastSequentialNode.id,
                            target: pNode.id,
                            type: 'parallel'
                        });
                    }
                }
                
                const joinNode = sortedNodes.find(n => n.id === joinNodeId);
                
                if (joinNode) {
                    for (const pNode of parallelGroup) {
                        workflow.edges.push({
                            id: `${pNode.id}-${joinNode.id}`,
                            source: pNode.id,
                            target: joinNode.id,
                            type: 'parallel'
                        });
                    }
                    lastSequentialNode = joinNode;
                }
                
                continue;
            }
            
            if (joinNodeIds.has(node.id)) {
                if (!lastSequentialNode || lastSequentialNode.id !== node.id) {
                    lastSequentialNode = node;
                }
                continue;
            }
            
            if (lastSequentialNode && lastSequentialNode.id !== node.id) {
                workflow.edges.push({
                    id: `${lastSequentialNode.id}-${node.id}`,
                    source: lastSequentialNode.id,
                    target: node.id,
                    type: 'default'
                });
            }
            lastSequentialNode = node;
        }

        const endNode = sortedNodes.find(n => n.type === 'end');
        if (lastSequentialNode && endNode && lastSequentialNode.id !== endNode.id) {
            workflow.edges.push({
                id: `${lastSequentialNode.id}-${endNode.id}`,
                source: lastSequentialNode.id,
                target: endNode.id,
                type: 'default'
            });
        }
    }

    /**
     * Get a shortened version of a path for display
     */
    private getShortPath(path: string): string {
        const parts = path.split('.');
        if (parts.length > 1) {
            return parts.slice(-1)[0];
        }
        const bracketMatch = path.match(/\[['"]?(\w+)['"]?\]$/);
        if (bracketMatch) {
            return bracketMatch[1];
        }
        return path.length > 15 ? path.substring(0, 12) + '...' : path;
    }

    private getLineNumber(sourceCode: string, index: number): number {
        return sourceCode.substring(0, index).split('\n').length;
    }
}
