/**
 * Core types for Dapr Workflow visualization
 */

// ============================================
// Data Flow Types
// ============================================

/** Source type indicating where data originates */
export type DataSourceType = 'workflow_input' | 'activity_output' | 'event_data' | 'literal' | 'constructed';

/** Represents a single data source for an activity input */
export interface DataSource {
    /** Where the data comes from */
    sourceType: DataSourceType;
    /** The source variable/path (e.g., "input.payment" or "reservation['reservation_id']") */
    sourcePath: string;
    /** What property name it's assigned to in the activity input */
    targetProperty?: string;
    /** The source activity ID if sourceType is 'activity_output' */
    sourceActivityId?: string;
}

/** Data flow information for a single activity */
export interface ActivityDataFlow {
    /** Activity node ID */
    nodeId: string;
    /** Activity name */
    name: string;
    /** Type of workflow element */
    type: WorkflowNodeType;
    /** What this activity consumes */
    inputs: DataSource[];
    /** What this activity produces */
    output?: {
        variableName: string;
        type?: string;
        properties?: string[];
    };
    /** Condition under which this activity executes */
    condition?: string;
    /** Line number in source code */
    lineNumber?: number;
}

/** Complete data flow metadata for a workflow */
export interface DataFlowMetadata {
    /** Workflow name */
    workflow: string;
    /** Workflow input type and properties */
    workflowInput: {
        type?: string;
        properties: string[];
        parameterName: string; // e.g., "input" in Python
    };
    /** Data flow for each activity */
    activities: ActivityDataFlow[];
    /** Map of variable names to the activity that produces them */
    outputVariableMap: Map<string, string>;
}

// ============================================
// Node Types
// ============================================

export interface WorkflowNode {
    id: string;
    type: WorkflowNodeType;
    name: string;
    label: string;
    metadata?: Record<string, unknown>;
    position?: { x: number; y: number };
    /** Input parameter/variable passed to this node */
    input?: string;
    /** Output variable that captures the result */
    output?: string;
    /** Parsed data sources for this node */
    dataSources?: DataSource[];
    /** For parallel nodes, the child node IDs */
    parallelChildren?: string[];
}

export type WorkflowNodeType = 
    | 'start'
    | 'end'
    | 'activity'
    | 'subOrchestration'
    | 'timer'
    | 'event'
    | 'decision'
    | 'parallel'
    | 'parallelBranch'
    | 'join'
    | 'retry'
    | 'workflowInput';

// ============================================
// Edge Types  
// ============================================

/** Type of edge connection */
export type EdgeType = 'default' | 'control' | 'data_workflow_input' | 'data_activity_output' | 'data_event' | 'conditional' | 'error' | 'timeout' | 'parallel';

export interface WorkflowEdge {
    id: string;
    source: string;
    target: string;
    label?: string;
    type?: EdgeType;
    /** Data being passed on this edge */
    dataFlow?: string;
    /** Source type for data flow edges */
    dataSourceType?: DataSourceType;
    condition?: string;
}

// ============================================
// Workflow Definition
// ============================================

export interface WorkflowDefinition {
    id: string;
    name: string;
    language: SupportedLanguage;
    filePath: string;
    nodes: WorkflowNode[];
    edges: WorkflowEdge[];
    /** Data flow metadata */
    dataFlow?: DataFlowMetadata;
    metadata?: {
        version?: string;
        description?: string;
        inputType?: string;
        outputType?: string;
        inputProperties?: string[];
        /** Parsed return/output fields */
        outputFields?: string[];
        /** Raw return expression */
        returnExpression?: string;
    };
}

export type SupportedLanguage = 'csharp' | 'python' | 'javascript' | 'typescript';

export interface ParseResult {
    success: boolean;
    workflow?: WorkflowDefinition;
    errors?: ParseError[];
}

export interface ParseError {
    message: string;
    line?: number;
    column?: number;
}

export interface VisualizationOptions {
    layout: 'dagre' | 'force' | 'hierarchical';
    theme: 'auto' | 'light' | 'dark';
    showActivityDetails: boolean;
    animated: boolean;
    /** Show data flow edges */
    showDataFlow: boolean;
    /** Show control flow edges */
    showControlFlow: boolean;
    /** Highlight workflow input connections */
    highlightWorkflowInput: boolean;
}
