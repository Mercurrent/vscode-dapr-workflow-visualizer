import { BaseWorkflowParser } from './baseParser';
import { 
    ParseResult, 
    WorkflowDefinition, 
    WorkflowNode, 
    DataSource, 
    DataSourceType,
    DataFlowMetadata,
    ActivityDataFlow,
    WorkflowEdge
} from '../types/workflow';

/**
 * Parser for C# Dapr Workflow definitions
 * 
 * Supports patterns like:
 * - ctx.CallActivityAsync<T>("ActivityName", input)
 * - ctx.CallSubOrchestratorAsync<T>("OrchestrationName", input)
 * - ctx.CreateTimer(duration)
 * - ctx.WaitForExternalEvent<T>("EventName")
 * - Task.WhenAll([...]) / Task.WhenAny([...])
 * - Workflow class definitions inheriting from Workflow<TInput, TOutput>
 * 
 * Enhanced with data flow analysis to track:
 * - workflow_input: Data from original workflow input
 * - activity_output: Data from previous activity results
 * - event_data: Data from external events
 * - constructed: Objects built from multiple sources
 */
export class CSharpWorkflowParser extends BaseWorkflowParser {
    private outputVariableMap: Map<string, string> = new Map();
    private workflowInputParam: string = 'input';
    private inputProperties: string[] = [];
    // Track parallel task variable -> node ID mapping
    private parallelTaskMap: Map<string, string> = new Map();
    // Track which nodes are part of parallel groups: nodeId -> parallelGroupId
    private parallelGroupMap: Map<string, string> = new Map();

    constructor() {
        super('csharp');
    }

    canParse(filePath: string): boolean {
        return filePath.endsWith('.cs');
    }

    /**
     * Find all workflows defined in the file with their code ranges
     */
    findAllWorkflows(sourceCode: string): Array<{name: string, startLine: number, endLine: number, startIndex: number, endIndex: number}> {
        const workflows: Array<{name: string, startLine: number, endLine: number, startIndex: number, endIndex: number}> = [];
        const lines = sourceCode.split('\n');
        
        // Match class definitions that inherit from Workflow
        const classPattern = /class\s+(\w+)\s*:\s*Workflow(?:<[^>]+>)?/g;
        
        let match;
        const allMatches: Array<{name: string, startIndex: number, line: number}> = [];
        
        while ((match = classPattern.exec(sourceCode)) !== null) {
            const name = match[1];
            const startIndex = match.index;
            const line = this.getLineNumber(sourceCode, startIndex);
            allMatches.push({ name, startIndex, line });
        }
        
        // For each workflow, find where it ends (at next class or end of file)
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
     * Extract workflow input parameter name from method signature
     */
    private extractWorkflowInputInfo(sourceCode: string): void {
        // Match RunAsync method signature: RunAsync(WorkflowContext ctx, OrderInput input)
        const methodMatch = sourceCode.match(/RunAsync\s*\(\s*WorkflowContext\s+\w+\s*,\s*(\w+)\s+(\w+)\s*\)/);
        if (methodMatch) {
            this.workflowInputParam = methodMatch[2]; // The parameter name
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

        // Check if it's an object initializer with multiple sources
        if (inputExpr.includes('{') && inputExpr.includes('}')) {
            const entries = this.parseObjectInitializer(inputExpr);
            
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
     * Parse C# object initializer entries
     */
    private parseObjectInitializer(content: string): Array<{ key: string; value: string }> {
        const entries: Array<{ key: string; value: string }> = [];
        
        // Extract content inside braces
        const braceStart = content.indexOf('{');
        const braceEnd = content.lastIndexOf('}');
        if (braceStart === -1 || braceEnd === -1) { return entries; }
        
        const innerContent = content.slice(braceStart + 1, braceEnd);
        
        let depth = 0;
        let current = '';
        
        for (const char of innerContent) {
            if (char === '{' || char === '[' || char === '(') { depth++; }
            if (char === '}' || char === ']' || char === ')') { depth--; }
            
            if (char === ',' && depth === 0) {
                const entry = this.parseCSharpAssignment(current.trim());
                if (entry) { entries.push(entry); }
                current = '';
            } else {
                current += char;
            }
        }
        
        if (current.trim()) {
            const entry = this.parseCSharpAssignment(current.trim());
            if (entry) { entries.push(entry); }
        }
        
        return entries;
    }

    /**
     * Parse a C# property assignment (PropertyName = value)
     */
    private parseCSharpAssignment(str: string): { key: string; value: string } | null {
        const eqIdx = str.indexOf('=');
        if (eqIdx === -1) { return null; }
        
        const key = str.slice(0, eqIdx).trim();
        const value = str.slice(eqIdx + 1).trim();
        
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
            (expr.startsWith('@"') && expr.endsWith('"')) ||
            (expr.startsWith('$"') && expr.endsWith('"'))) {
            return {
                sourceType: 'literal',
                sourcePath: expr,
                targetProperty
            };
        }
        
        // Default to workflow_input for variable references
        if (/^\w+(\.\w+)*$/.test(expr)) {
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
        // Try to find class name that extends Workflow
        const classMatch = sourceCode.match(/class\s+(\w+)\s*:\s*Workflow/);
        if (classMatch) {
            return classMatch[1];
        }

        // Fallback to file name
        const fileName = filePath.split('/').pop() || filePath.split('\\').pop() || 'Unknown';
        return fileName.replace('.cs', '');
    }

    private extractMetadata(fullSource: string, scopedSource: string): WorkflowDefinition['metadata'] {
        const metadata: WorkflowDefinition['metadata'] = {
            inputProperties: []
        };

        // Extract input/output types from Workflow<TInput, TOutput>
        const genericMatch = scopedSource.match(/Workflow<(\w+),\s*(\w+)>/);
        if (genericMatch) {
            metadata.inputType = genericMatch[1];
            metadata.outputType = genericMatch[2];
        }

        // Extract description from XML comments
        const descMatch = scopedSource.match(/\/\/\/\s*<summary>\s*\n?\s*\/\/\/\s*(.+?)\s*\n?\s*\/\/\/\s*<\/summary>/);
        if (descMatch) {
            metadata.description = descMatch[1].trim();
        }

        // Extract input properties from record definition
        if (metadata.inputType) {
            const recordPattern = new RegExp(
                `record\\s+${metadata.inputType}\\s*\\(([^)]+)\\)`,
                'm'
            );
            const recordMatch = fullSource.match(recordPattern);
            if (recordMatch) {
                const propPattern = /(\w+)\s+(\w+)/g;
                let propMatch;
                while ((propMatch = propPattern.exec(recordMatch[1])) !== null) {
                    metadata.inputProperties!.push(propMatch[2]);
                }
            }
        }

        return metadata;
    }

    /**
     * Extract return statement info
     */
    private extractReturnInfo(sourceCode: string, workflow: WorkflowDefinition): void {
        // Find return statements with object initializers
        const returnPattern = /return\s+new\s+\w+\s*{([^}]+)}/g;
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
    }

    /**
     * Parse a return expression to extract field names
     */
    private parseReturnExpression(expression: string): string[] {
        const fields: string[] = [];
        
        // Match property assignments: PropertyName = value
        const propPattern = /(\w+)\s*=/g;
        let propMatch;
        while ((propMatch = propPattern.exec(expression)) !== null) {
            fields.push(propMatch[1]);
        }
        
        return fields;
    }

    /**
     * Extract the input expression from a CallActivityAsync call
     */
    private extractInputExpression(sourceCode: string, matchIndex: number): string | undefined {
        const callStart = sourceCode.indexOf('CallActivityAsync', matchIndex);
        if (callStart === -1) { return undefined; }
        
        const parenStart = sourceCode.indexOf('(', callStart);
        if (parenStart === -1) { return undefined; }
        
        // Find the second argument (after the activity name)
        let depth = 1;
        let i = parenStart + 1;
        let argStart = -1;
        let argCount = 0;
        let inString = false;
        let stringChar = '';
        
        while (i < sourceCode.length && depth > 0) {
            const char = sourceCode[i];
            const prevChar = sourceCode[i - 1];
            
            // Handle string literals
            if ((char === '"') && prevChar !== '\\' && !inString) {
                inString = true;
                stringChar = char;
            } else if (char === stringChar && prevChar !== '\\' && inString) {
                inString = false;
            }
            
            if (!inString) {
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
        
        // Pattern for awaited activities with variable assignment
        const awaitedPattern = /(?:var\s+)?(\w+)?\s*=?\s*await\s+(?:ctx|context)\.CallActivityAsync(?:<([^>]+)>)?\s*\(\s*["']([^"']+)["']/g;
        
        // Pattern for non-awaited activities (parallel tasks) - variable = ctx.CallActivityAsync without await
        const taskPattern = /(?:var\s+)?(\w+(?:Task)?)\s*=\s*(?:ctx|context)\.CallActivityAsync(?:<([^>]+)>)?\s*\(\s*["']([^"']+)["']/g;
        
        let match;
        let index = 0;
        const seenLines = new Set<number>();
        
        // First, parse non-awaited task assignments (parallel tasks)
        while ((match = taskPattern.exec(sourceCode)) !== null) {
            const taskVar = match[1];
            const activityName = match[3];
            const lineNum = this.getLineNumber(sourceCode, match.index) + lineOffset;
            
            if (seenLines.has(lineNum)) { continue; }
            seenLines.add(lineNum);
            
            const inputExpr = this.extractInputExpression(sourceCode, match.index);
            const nodeId = `activity-${index++}`;
            
            // Check if this is a parallel task (not immediately awaited)
            const isParallel = !sourceCode.substring(Math.max(0, match.index - 20), match.index).match(/await/);
            
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
                    taskVariable: isParallel ? taskVar : undefined,
                    returnType: match[2]
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
            const activityName = match[3];
            const lineNum = this.getLineNumber(sourceCode, match.index) + lineOffset;
            
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
                    isParallelTask: false,
                    returnType: match[2]
                }
            );
            node.output = outputVar;
            node.input = inputExpr;
            node.dataSources = dataSources;
            nodes.push(node);
        }

        return nodes;
    }

    private parseParallelBlocks(sourceCode: string, lineOffset: number = 0): WorkflowNode[] {
        const nodes: WorkflowNode[] = [];
        
        // Match Task.WhenAll and Task.WhenAny patterns
        const parallelPattern = /(?:var\s+)?(\w+)?\s*=?\s*await\s+Task\.(?:WhenAll|WhenAny)\s*\(([^)]+)\)/g;
        
        let match;
        let index = 0;
        while ((match = parallelPattern.exec(sourceCode)) !== null) {
            const outputVar = match[1];
            const tasksContent = match[2];
            
            // Extract task variable names
            const taskVars = tasksContent.match(/\w+(?:Task)?/g) || [];
            
            const nodeId = `parallel-join-${index++}`;
            
            // Track output variable
            if (outputVar) {
                this.outputVariableMap.set(outputVar, nodeId);
            }
            
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
                    taskNodeIds: taskVars.map(t => this.parallelTaskMap.get(t)).filter(Boolean)
                }
            );
            nodes.push(node);
        }
        
        return nodes;
    }

    private parseSubOrchestrations(sourceCode: string, lineOffset: number = 0): WorkflowNode[] {
        const nodes: WorkflowNode[] = [];
        const subOrchPattern = /(?:var\s+)?(\w+)?\s*=?\s*await\s+(?:ctx|context)\.CallSubOrchestrator(?:Async)?(?:<([^>]+)>)?\s*\(\s*["']([^"']+)["'](?:\s*,\s*([^)]+))?\)/g;
        
        let match;
        let index = 0;
        while ((match = subOrchPattern.exec(sourceCode)) !== null) {
            const outputVar = match[1] || undefined;
            const orchName = match[3];
            const inputExpr = match[4]?.trim();
            
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
                    dataSources: dataSources,
                    returnType: match[2]
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
        const timerPattern = /(?:var\s+)?(\w+)?\s*=?\s*(?:await\s+)?(?:ctx|context)\.CreateTimer\s*\(([^)]+)\)/g;
        
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
                duration ? `Wait: ${duration.substring(0, 25)}` : 'Wait Timer',
                { lineNumber: this.getLineNumber(sourceCode, match.index) + lineOffset }
            );
            node.output = outputVar;
            nodes.push(node);
        }

        return nodes;
    }

    private parseExternalEvents(sourceCode: string, lineOffset: number = 0): WorkflowNode[] {
        const nodes: WorkflowNode[] = [];
        const eventPattern = /(?:var\s+)?(\w+)?\s*=?\s*(?:await\s+)?(?:ctx|context)\.WaitForExternalEvent(?:<([^>]+)>)?\s*\(\s*["']([^"']+)["']/g;
        
        let match;
        let index = 0;
        while ((match = eventPattern.exec(sourceCode)) !== null) {
            const outputVar = match[1] || undefined;
            const eventName = match[3];
            
            const nodeId = `event-${index++}`;
            
            if (outputVar) {
                this.outputVariableMap.set(outputVar, nodeId);
            }
            
            const node = this.createNode(
                nodeId,
                'event',
                eventName,
                `Event: ${eventName}`,
                { 
                    lineNumber: this.getLineNumber(sourceCode, match.index) + lineOffset,
                    returnType: match[2]
                }
            );
            node.output = outputVar;
            node.dataSources = [{ sourceType: 'event_data', sourcePath: eventName }];
            nodes.push(node);
        }

        return nodes;
    }

    private parseDecisions(sourceCode: string, lineOffset: number = 0): WorkflowNode[] {
        const nodes: WorkflowNode[] = [];
        // Look for if statements that control workflow flow
        const ifPattern = /if\s*\(([^)]+)\)\s*{[^}]*(?:CallActivity|CallSubOrchestrator|CreateTimer|WaitForExternalEvent)/g;
        
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
                        type: node.metadata?.returnType as string | undefined
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
