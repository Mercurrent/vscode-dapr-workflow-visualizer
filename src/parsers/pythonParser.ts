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
 * Parser for Python Dapr Workflow definitions
 * 
 * Supports patterns like:
 * - yield ctx.call_activity(activity_name, input=data)
 * - yield ctx.call_child_workflow(workflow_name, input=data)
 * - yield ctx.create_timer(duration)
 * - yield ctx.wait_for_external_event(event_name)
 * - @workflow decorator
 * - @activity decorator
 * 
 * Enhanced with data flow analysis to track:
 * - workflow_input: Data from original workflow input
 * - activity_output: Data from previous activity results
 * - event_data: Data from external events
 * - constructed: Objects built from multiple sources
 */
export class PythonWorkflowParser extends BaseWorkflowParser {
    private outputVariableMap: Map<string, string> = new Map();
    private workflowInputParam: string = 'input';
    private inputProperties: string[] = [];
    // Track parallel task variable -> node ID mapping
    private parallelTaskMap: Map<string, string> = new Map();
    // Track which nodes are part of parallel groups: nodeId -> parallelGroupId
    private parallelGroupMap: Map<string, string> = new Map();

    constructor() {
        super('python');
    }

    canParse(filePath: string): boolean {
        return filePath.endsWith('.py');
    }

    /**
     * Find all workflows defined in the file with their code ranges
     */
    findAllWorkflows(sourceCode: string): Array<{name: string, startLine: number, endLine: number, startIndex: number, endIndex: number}> {
        const workflows: Array<{name: string, startLine: number, endLine: number, startIndex: number, endIndex: number}> = [];
        
        // Find all @workflow decorated functions
        const workflowPattern = /@(?:dapr_)?workflow[^\n]*\n\s*(?:async\s+)?def\s+(\w+)/g;
        const lines = sourceCode.split('\n');
        
        let match;
        const allMatches: Array<{name: string, startIndex: number, line: number}> = [];
        
        while ((match = workflowPattern.exec(sourceCode)) !== null) {
            const name = match[1];
            const startIndex = match.index;
            const line = this.getLineNumber(sourceCode, startIndex);
            allMatches.push({ name, startIndex, line });
        }
        
        // For each workflow, find where it ends (at next workflow or end of file)
        for (let i = 0; i < allMatches.length; i++) {
            const current = allMatches[i];
            const next = allMatches[i + 1];
            
            let endIndex: number;
            let endLine: number;
            
            if (next) {
                // End at the line before the next @workflow decorator
                endIndex = next.startIndex - 1;
                endLine = next.line - 1;
            } else {
                // End at the last line of file or before @activity decorators
                const activityMatch = sourceCode.slice(current.startIndex).match(/\n@activity\b/);
                if (activityMatch) {
                    endIndex = current.startIndex + activityMatch.index!;
                    endLine = this.getLineNumber(sourceCode, endIndex) - 1;
                } else {
                    endIndex = sourceCode.length;
                    endLine = lines.length;
                }
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
                    lineOffset = targetWorkflow.startLine - 1; // Lines are 1-based
                    workflowName = targetWorkflow.name;
                } else {
                    // Fallback to first workflow if target not found
                    workflowName = this.extractWorkflowName(sourceCode, filePath);
                }
            } else if (allWorkflows.length > 0) {
                // Default to first workflow
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

            // Extract workflow metadata including input properties (from full source for dataclass defs)
            workflow.metadata = this.extractMetadata(sourceCode);
            
            // Extract workflow input parameter name and properties (from scoped code for this workflow)
            this.extractWorkflowInputInfo(scopedSourceCode);
            
            // Extract return/output info and add to metadata
            this.extractReturnInfo(scopedSourceCode, workflow);

            // Parse workflow components (from scoped code only)
            const activities = this.parseActivities(scopedSourceCode, lineOffset);
            const childWorkflows = this.parseChildWorkflows(scopedSourceCode, lineOffset);
            const timers = this.parseTimers(scopedSourceCode, lineOffset);
            const events = this.parseExternalEvents(scopedSourceCode, lineOffset);
            const decisions = this.parseDecisions(scopedSourceCode, lineOffset);
            const retries = this.parseRetryPolicies(scopedSourceCode, lineOffset);
            const parallelBlocks = this.parseParallelBlocks(scopedSourceCode, lineOffset);

            // Add all nodes
            workflow.nodes.push(...activities);
            workflow.nodes.push(...childWorkflows);
            workflow.nodes.push(...timers);
            workflow.nodes.push(...events);
            workflow.nodes.push(...decisions);
            workflow.nodes.push(...retries);
            workflow.nodes.push(...parallelBlocks);

            // Add start and end nodes
            this.addStartEndNodes(workflow);

            // Build data flow metadata
            workflow.dataFlow = this.buildDataFlowMetadata(workflow, scopedSourceCode);

            // Build edges with data flow information
            this.buildEdgesWithDataFlow(workflow, scopedSourceCode);
            
            // Debug: Add parallel mapping info to workflow metadata
            if (!workflow.metadata) { workflow.metadata = {}; }
            (workflow.metadata as any)._debug = {
                parallelTaskMap: [...this.parallelTaskMap.entries()],
                parallelGroupMap: [...this.parallelGroupMap.entries()],
                nodeCount: workflow.nodes.length,
                edgeCount: workflow.edges.length
            };

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
     * Extract workflow input parameter name and dataclass properties
     */
    private extractWorkflowInputInfo(sourceCode: string): void {
        // Find workflow function signature to get input parameter name
        const funcMatch = sourceCode.match(/@(?:dapr_)?workflow[^\n]*\n\s*(?:async\s+)?def\s+\w+\s*\([^,]+,\s*(\w+)\s*:/);
        if (funcMatch) {
            this.workflowInputParam = funcMatch[1];
        }

        // Find the input type's dataclass definition
        const metadata = this.extractMetadata(sourceCode);
        if (metadata?.inputType) {
            const dataclassPattern = new RegExp(
                `@dataclass[\\s\\S]*?class\\s+${metadata.inputType}[^:]*:[\\s\\S]*?(?=\\n(?:@|class|def)|$)`,
                'g'
            );
            const dataclassMatch = sourceCode.match(dataclassPattern);
            if (dataclassMatch) {
                // Extract property names from the dataclass
                const propPattern = /^\s+(\w+)\s*:/gm;
                let propMatch;
                while ((propMatch = propPattern.exec(dataclassMatch[0])) !== null) {
                    if (!propMatch[1].startsWith('_')) {
                        this.inputProperties.push(propMatch[1]);
                    }
                }
            }
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

        // Check if it's a dict literal with multiple sources
        if (inputExpr.startsWith('{') && inputExpr.endsWith('}')) {
            // Parse dict literal: {"key": value, "key2": value2}
            const dictContent = inputExpr.slice(1, -1);
            const entries = this.parseDictEntries(dictContent);
            
            for (const entry of entries) {
                const source = this.classifyExpression(entry.value, entry.key);
                sources.push(source);
            }
            
            // If multiple sources with different types, mark as constructed
            const hasWorkflowInput = sources.some(s => s.sourceType === 'workflow_input');
            const hasActivityOutput = sources.some(s => s.sourceType === 'activity_output');
            
            if (hasWorkflowInput && hasActivityOutput) {
                // Mark as constructed (mixed sources)
                return sources.map(s => ({ ...s, sourceType: sources.length > 1 ? s.sourceType : 'constructed' as DataSourceType }));
            }
            
            return sources;
        }

        // Single expression
        const source = this.classifyExpression(inputExpr);
        return [source];
    }

    /**
     * Parse dict literal entries
     */
    private parseDictEntries(dictContent: string): Array<{ key: string; value: string }> {
        const entries: Array<{ key: string; value: string }> = [];
        
        // Simple parsing - split by comma (outside of nested structures)
        let depth = 0;
        let current = '';
        
        for (const char of dictContent) {
            if (char === '{' || char === '[' || char === '(') {depth++;}
            if (char === '}' || char === ']' || char === ')') {depth--;}
            
            if (char === ',' && depth === 0) {
                const entry = this.parseKeyValue(current.trim());
                if (entry) {entries.push(entry);}
                current = '';
            } else {
                current += char;
            }
        }
        
        if (current.trim()) {
            const entry = this.parseKeyValue(current.trim());
            if (entry) {entries.push(entry);}
        }
        
        return entries;
    }

    /**
     * Parse a key: value pair from dict literal
     */
    private parseKeyValue(str: string): { key: string; value: string } | null {
        const colonIdx = str.indexOf(':');
        if (colonIdx === -1) {return null;}
        
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
            (expr.startsWith("'") && expr.endsWith("'"))) {
            return {
                sourceType: 'literal',
                sourcePath: expr,
                targetProperty
            };
        }
        
        // Default to workflow_input if it looks like a variable reference
        // that might be from the input (heuristic)
        if (/^\w+(\.\w+|\[['"]?\w+['"]?\])*$/.test(expr)) {
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
        // Look for @workflow decorator followed by function definition
        const decoratorMatch = sourceCode.match(/@(?:dapr_)?workflow(?:\([^)]*\))?\s*\n\s*(?:async\s+)?def\s+(\w+)/);
        if (decoratorMatch) {
            return decoratorMatch[1];
        }

        // Look for function with "workflow" in name
        const funcMatch = sourceCode.match(/(?:async\s+)?def\s+(\w*workflow\w*)\s*\(/i);
        if (funcMatch) {
            return funcMatch[1];
        }

        // Fallback to file name
        const fileName = filePath.split('/').pop() || filePath.split('\\').pop() || 'Unknown';
        return fileName.replace('.py', '');
    }

    private extractMetadata(sourceCode: string): WorkflowDefinition['metadata'] {
        const metadata: WorkflowDefinition['metadata'] = {
            inputProperties: []
        };

        // Extract docstring
        const docstringMatch = sourceCode.match(/(?:@(?:dapr_)?workflow[^\n]*\n\s*(?:async\s+)?def\s+\w+[^:]+:\s*\n\s*)("""[\s\S]*?"""|'''[\s\S]*?''')/);
        if (docstringMatch) {
            metadata.description = docstringMatch[1].replace(/"""|'''/g, '').trim();
        }

        // Extract type hints
        const typeHintMatch = sourceCode.match(/def\s+\w+\s*\([^,]+,\s*\w+\s*:\s*(\w+)[^)]*\)\s*->\s*(\w+)/);
        if (typeHintMatch) {
            metadata.inputType = typeHintMatch[1];
            metadata.outputType = typeHintMatch[2];
        }

        // Extract input properties from dataclass if found
        if (metadata.inputType) {
            const dataclassPattern = new RegExp(
                `@dataclass[\\s\\S]*?class\\s+${metadata.inputType}[^:]*:[\\s\\S]*?(?=\\n(?:@|class\\s|def\\s)|$)`,
                'm'
            );
            const dataclassMatch = sourceCode.match(dataclassPattern);
            if (dataclassMatch) {
                const propPattern = /^\s{4}(\w+)\s*:/gm;
                let propMatch;
                while ((propMatch = propPattern.exec(dataclassMatch[0])) !== null) {
                    if (!propMatch[1].startsWith('_')) {
                        metadata.inputProperties!.push(propMatch[1]);
                    }
                }
            }
        }

        return metadata;
    }

    /**
     * Extract return statement info and add to workflow metadata
     */
    private extractReturnInfo(sourceCode: string, workflow: WorkflowDefinition): void {
        // Find all return statements at the workflow function level (4 spaces indent)
        const returnPattern = /^    return\s+(.+)$/gm;
        const returns: string[] = [];
        let match;
        
        while ((match = returnPattern.exec(sourceCode)) !== null) {
            returns.push(match[1].trim());
        }
        
        if (returns.length === 0) {
            return;
        }
        
        // Use the last (main) return or combine all unique fields
        const allFields: string[] = [];
        
        for (const expr of returns) {
            const fields = this.parseReturnExpression(expr);
            for (const f of fields) {
                if (!allFields.includes(f)) {
                    allFields.push(f);
                }
            }
        }
        
        if (!workflow.metadata) {
            workflow.metadata = {};
        }
        
        workflow.metadata.outputFields = allFields;
        workflow.metadata.returnExpression = returns[returns.length - 1]; // Last return
    }
    
    /**
     * Extract the input expression from a call_activity call, handling multi-line dict literals
     */
    private extractInputExpression(sourceCode: string, matchIndex: number): string | undefined {
        // Find the opening parenthesis of call_activity
        const callStart = sourceCode.indexOf('call_activity', matchIndex);
        if (callStart === -1) { return undefined; }
        
        const parenStart = sourceCode.indexOf('(', callStart);
        if (parenStart === -1) { return undefined; }
        
        // Find "input=" within this call
        const inputMatch = sourceCode.substring(parenStart).match(/,\s*input\s*=\s*/);
        if (!inputMatch || inputMatch.index === undefined) { return undefined; }
        
        const inputStart = parenStart + inputMatch.index + inputMatch[0].length;
        
        // Now extract the value with balanced braces/brackets/parens
        const char = sourceCode[inputStart];
        let endIndex: number;
        
        if (char === '{' || char === '[' || char === '(') {
            // Find matching closing bracket
            endIndex = this.findMatchingBracket(sourceCode, inputStart);
            return sourceCode.substring(inputStart, endIndex + 1).trim();
        } else {
            // Simple value - find the closing paren of call_activity (don't include it)
            endIndex = sourceCode.indexOf(')', inputStart);
            if (endIndex === -1) { return undefined; }
            return sourceCode.substring(inputStart, endIndex).trim();
        }
    }
    
    /**
     * Find the matching closing bracket for an opening bracket
     */
    private findMatchingBracket(sourceCode: string, openIndex: number): number {
        const openChar = sourceCode[openIndex];
        const closeChar = openChar === '{' ? '}' : openChar === '[' ? ']' : ')';
        
        let depth = 1;
        let i = openIndex + 1;
        let inString: string | null = null;
        
        while (i < sourceCode.length && depth > 0) {
            const char = sourceCode[i];
            const prevChar = sourceCode[i - 1];
            
            // Handle string literals (skip their contents)
            if ((char === '"' || char === "'") && prevChar !== '\\') {
                if (inString === null) {
                    // Check for triple quotes
                    if (sourceCode.substring(i, i + 3) === '"""' || sourceCode.substring(i, i + 3) === "'''") {
                        inString = sourceCode.substring(i, i + 3);
                        i += 3;
                        continue;
                    }
                    inString = char;
                } else if (inString === char || (inString.length === 3 && sourceCode.substring(i, i + 3) === inString)) {
                    if (inString.length === 3) {
                        i += 3;
                    } else {
                        i++;
                    }
                    inString = null;
                    continue;
                }
            }
            
            if (inString === null) {
                if (char === openChar) {
                    depth++;
                } else if (char === closeChar) {
                    depth--;
                }
            }
            i++;
        }
        
        return i - 1;
    }

    /**
     * Parse a return expression to extract field names
     */
    private parseReturnExpression(expression: string): string[] {
        const fields: string[] = [];
        
        // Dict literal: {"key": value, "key2": value2} or {'key': value}
        if (expression.startsWith('{')) {
            const keyPattern = /["'](\w+)["']\s*:/g;
            let keyMatch;
            while ((keyMatch = keyPattern.exec(expression)) !== null) {
                fields.push(keyMatch[1]);
            }
        }
        // Dataclass/namedtuple constructor: SomeClass(field1=..., field2=...)
        else if (expression.match(/^\w+\s*\(/)) {
            const argPattern = /(\w+)\s*=/g;
            let argMatch;
            while ((argMatch = argPattern.exec(expression)) !== null) {
                fields.push(argMatch[1]);
            }
        }
        
        return fields;
    }

    private parseActivities(sourceCode: string, lineOffset: number = 0): WorkflowNode[] {
        const nodes: WorkflowNode[] = [];
        
        // Pattern for AWAITED activities (sequential) - simpler pattern, we'll extract input separately
        const awaitedPattern = /(?:(\w+)(?:\s*:\s*\w+)?\s*=\s*)?(?:yield|await)\s+ctx\.call_activity\s*\(\s*(\w+)/g;
        
        // Pattern for NON-AWAITED activities (parallel tasks) - e.g., task = ctx.call_activity(...)
        const taskPattern = /(\w+_task|\w+Task)\s*=\s*ctx\.call_activity\s*\(\s*(\w+)/g;
        
        let match;
        let index = 0;
        
        // First, parse non-awaited task assignments (parallel tasks)
        while ((match = taskPattern.exec(sourceCode)) !== null) {
            const taskVar = match[1];
            const activityName = match[2];
            
            // Extract input expression by finding balanced parentheses
            const inputExpr = this.extractInputExpression(sourceCode, match.index);
            
            const nodeId = `activity-${index++}`;
            
            // Track this as a parallel task
            this.parallelTaskMap.set(taskVar, nodeId);
            
            // Analyze data sources
            const dataSources = this.analyzeDataSource(inputExpr);
            
            const node = this.createNode(
                nodeId,
                'activity',
                activityName,
                activityName,
                { 
                    lineNumber: this.getLineNumber(sourceCode, match.index) + lineOffset,
                    dataSources: dataSources,
                    isParallelTask: true,
                    taskVariable: taskVar
                }
            );
            node.output = taskVar;
            node.input = inputExpr;
            node.dataSources = dataSources;
            nodes.push(node);
        }
        
        // Then parse awaited activities (sequential)
        while ((match = awaitedPattern.exec(sourceCode)) !== null) {
            const outputVar = match[1] || undefined;
            const activityName = match[2];
            
            // Extract input expression properly (handles multi-line)
            const inputExpr = this.extractInputExpression(sourceCode, match.index);
            
            // Skip if this activity was already captured as a parallel task
            const lineNum = this.getLineNumber(sourceCode, match.index) + lineOffset;
            const existingNode = nodes.find(n => 
                n.name === activityName && 
                n.metadata?.lineNumber === lineNum
            );
            if (existingNode) { continue; }
            
            const nodeId = `activity-${index++}`;
            
            // Track output variable for data flow analysis
            if (outputVar) {
                this.outputVariableMap.set(outputVar, nodeId);
            }
            
            // Analyze data sources
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

        // Also match string-based activity names (sequential only)
        const stringActivityPattern = /(?:(\w+)(?:\s*:\s*\w+)?\s*=\s*)?(?:yield|await)\s+ctx\.call_activity\s*\(\s*["']([^"']+)["']/g;
        while ((match = stringActivityPattern.exec(sourceCode)) !== null) {
            const outputVar = match[1] || undefined;
            const activityName = match[2];
            
            // Extract input expression properly
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
                    lineNumber: this.getLineNumber(sourceCode, match.index) + lineOffset,
                    dataSources: dataSources,
                    isParallelTask: false
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
        
        // Match when_all patterns for parallel execution
        const whenAllPattern = /(?:(\w+(?:\s*,\s*\w+)*)\s*=\s*)?(?:yield|await)\s+when_all\s*\(\s*\[([^\]]+)\]\s*\)/g;
        
        let match;
        let index = 0;
        while ((match = whenAllPattern.exec(sourceCode)) !== null) {
            const outputs = match[1]?.split(',').map(s => s.trim()) || [];
            const tasksContent = match[2];
            
            // Extract task variable names from the when_all block
            const taskVars = tasksContent.match(/\w+_task|\w+Task/g) || [];
            
            const nodeId = `parallel-join-${index++}`;
            
            // Track output variables - these are the results after the when_all completes
            outputs.forEach((outputVar, idx) => {
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

    private parseChildWorkflows(sourceCode: string, lineOffset: number = 0): WorkflowNode[] {
        const nodes: WorkflowNode[] = [];
        const childPattern = /(?:(\w+)(?:\s*:\s*\w+)?\s*=\s*)?(?:yield|await)\s+ctx\.call_child_workflow\s*\(\s*(\w+|["'][^"']+["'])(?:\s*,\s*input\s*=\s*([^)\n]+))?\s*\)/g;
        
        let match;
        let index = 0;
        while ((match = childPattern.exec(sourceCode)) !== null) {
            const outputVar = match[1] || undefined;
            const workflowName = match[2].replace(/["']/g, '');
            const inputExpr = match[3]?.trim();
            
            const nodeId = `child-${index++}`;
            
            if (outputVar) {
                this.outputVariableMap.set(outputVar, nodeId);
            }
            
            const dataSources = this.analyzeDataSource(inputExpr);
            
            const node = this.createNode(
                nodeId,
                'subOrchestration',
                workflowName,
                `Child: ${workflowName}`,
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
        const timerPattern = /(?:(\w+)\s*=\s*)?(?:yield|await)\s+ctx\.create_timer\s*\(([^)]+)\)/g;
        
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
        const eventPattern = /(?:(\w+)\s*=\s*)?(?:yield|await)\s+ctx\.wait_for_external_event\s*\(\s*["']([^"']+)["']/g;
        
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
        // Look for if statements that affect workflow flow
        const ifPattern = /if\s+([^:]+):\s*\n[^#\n]*(?:yield|await)\s+ctx\./g;
        
        let match;
        let index = 0;
        while ((match = ifPattern.exec(sourceCode)) !== null) {
            const condition = match[1].trim();
            
            // Analyze condition to find data sources
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
     * Analyze a condition expression to find data sources it references
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

    private parseRetryPolicies(sourceCode: string, lineOffset: number = 0): WorkflowNode[] {
        const nodes: WorkflowNode[] = [];
        const retryPattern = /RetryPolicy\s*\([^)]+\)/g;
        
        let match;
        let index = 0;
        while ((match = retryPattern.exec(sourceCode)) !== null) {
            nodes.push(this.createNode(
                `retry-${index++}`,
                'retry',
                'Retry Policy',
                'Retry',
                { lineNumber: this.getLineNumber(sourceCode, match.index) + lineOffset }
            ));
        }

        return nodes;
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
        // Build control flow edges with parallel support
        this.buildControlFlowEdges(workflow);
        
        // Now add data flow edges
        const dataFlowEdges: WorkflowEdge[] = [];
        
        for (const node of workflow.nodes) {
            if (!node.dataSources || node.dataSources.length === 0) {continue;}
            
            for (const source of node.dataSources) {
                if (source.sourceType === 'workflow_input') {
                    // Edge from start node (representing workflow input)
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
                    // Edge from the activity that produces this output
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
        
        // Add data flow edges to workflow
        workflow.edges.push(...dataFlowEdges);
    }

    /**
     * Build control flow edges with proper parallel block handling
     */
    private buildControlFlowEdges(workflow: WorkflowDefinition): void {
        // Sort nodes by line number for proper ordering
        const sortedNodes = [...workflow.nodes].sort((a, b) => {
            const lineA = (a.metadata?.lineNumber as number) || 0;
            const lineB = (b.metadata?.lineNumber as number) || 0;
            return lineA - lineB;
        });

        // Find parallel task nodes and their join nodes
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
            
            // Skip start and end nodes in the main loop
            if (node.type === 'start') {
                lastSequentialNode = node;
                continue;
            }
            
            if (node.type === 'end') {
                continue;
            }

            // Check if this is a parallel task
            if (parallelTaskNodeIds.has(node.id)) {
                // Find the join node for this task
                const joinNodeId = this.parallelGroupMap.get(node.id);
                
                // If no join node mapped, treat as regular sequential node
                if (!joinNodeId) {
                    console.warn(`Parallel task ${node.name} has no join node mapped!`);
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
                
                // Skip if we already processed this parallel group
                if (processedParallelGroups.has(joinNodeId)) {
                    continue;
                }
                
                processedParallelGroups.add(joinNodeId);
                
                // Collect all nodes in this parallel group
                const parallelGroup: WorkflowNode[] = [];
                for (const pNode of sortedNodes) {
                    if (this.parallelGroupMap.get(pNode.id) === joinNodeId) {
                        parallelGroup.push(pNode);
                    }
                }
                
                // Connect from last sequential node to ALL parallel tasks (fan-out)
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
                
                // Find the join node for this group
                const joinNode = sortedNodes.find(n => n.id === joinNodeId);
                
                // Connect ALL parallel tasks to the join node (fan-in)
                if (joinNode) {
                    for (const pNode of parallelGroup) {
                        workflow.edges.push({
                            id: `${pNode.id}-${joinNode.id}`,
                            source: pNode.id,
                            target: joinNode.id,
                            type: 'parallel'
                        });
                    }
                    // The join node becomes the last sequential node
                    lastSequentialNode = joinNode;
                } else {
                    console.warn(`Join node ${joinNodeId} not found in sorted nodes!`);
                }
                
                continue;
            }
            
            // Skip join nodes (they're handled with their parallel tasks above)
            if (joinNodeIds.has(node.id)) {
                // Only update lastSequentialNode if this join wasn't already set
                // (it should have been set when processing the parallel group)
                if (!lastSequentialNode || lastSequentialNode.id !== node.id) {
                    lastSequentialNode = node;
                }
                continue;
            }
            
            // Regular sequential node
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

        // Connect to end node
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
        // Extract the last part of the path
        const parts = path.split('.');
        if (parts.length > 1) {
            return parts.slice(-1)[0];
        }
        // Handle bracket notation
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
