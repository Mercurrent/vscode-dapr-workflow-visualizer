import { ParseResult, WorkflowDefinition, WorkflowNode, WorkflowEdge, SupportedLanguage } from '../types/workflow';

/**
 * Base class for workflow parsers
 */
export abstract class BaseWorkflowParser {
    protected language: SupportedLanguage;

    constructor(language: SupportedLanguage) {
        this.language = language;
    }

    /**
     * Parse the source code and extract workflow definition
     * @param sourceCode The source code to parse
     * @param filePath The file path
     * @param targetWorkflowName Optional - if specified, only parse this workflow (for files with multiple workflows)
     */
    abstract parse(sourceCode: string, filePath: string, targetWorkflowName?: string): ParseResult;

    /**
     * Check if this parser can handle the given file
     */
    abstract canParse(filePath: string): boolean;

    /**
     * Create a workflow node
     */
    protected createNode(
        id: string,
        type: WorkflowNode['type'],
        name: string,
        label?: string,
        metadata?: Record<string, unknown>
    ): WorkflowNode {
        return {
            id,
            type,
            name,
            label: label || name,
            metadata
        };
    }

    /**
     * Create a workflow edge
     */
    protected createEdge(
        source: string,
        target: string,
        label?: string,
        type: WorkflowEdge['type'] = 'default'
    ): WorkflowEdge {
        return {
            id: `${source}-${target}`,
            source,
            target,
            label,
            type
        };
    }

    /**
     * Create an empty workflow definition
     */
    protected createEmptyWorkflow(name: string, filePath: string): WorkflowDefinition {
        return {
            id: this.generateId(name),
            name,
            language: this.language,
            filePath,
            nodes: [],
            edges: []
        };
    }

    /**
     * Generate a unique ID
     */
    protected generateId(prefix: string): string {
        return `${prefix}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }

    /**
     * Add start and end nodes to workflow
     */
    protected addStartEndNodes(workflow: WorkflowDefinition): void {
        const startNode = this.createNode('start', 'start', 'Start', 'Start');
        const endNode = this.createNode('end', 'end', 'End', 'End');
        
        workflow.nodes.unshift(startNode);
        workflow.nodes.push(endNode);
    }

    /**
     * Connect nodes sequentially
     */
    protected connectNodesSequentially(workflow: WorkflowDefinition): void {
        for (let i = 0; i < workflow.nodes.length - 1; i++) {
            const edge = this.createEdge(
                workflow.nodes[i].id,
                workflow.nodes[i + 1].id
            );
            workflow.edges.push(edge);
        }
    }
}
