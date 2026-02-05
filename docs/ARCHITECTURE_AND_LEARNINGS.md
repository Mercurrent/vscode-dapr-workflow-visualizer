# Dapr Workflow Visualizer - Architecture & Learnings

> Reference document for building the Dapr Dashboard live visualization tool

## Project Overview

**Purpose:** VS Code extension that parses Dapr workflow source code and renders interactive SVG graphs showing workflow structure, control flow, and data dependencies.

**Tech Stack:**
- TypeScript for extension code
- VS Code Webview API for rendering
- Pure SVG + Dagre.js algorithm for graph layout
- Regex-based parsers for Python, C#, JavaScript/TypeScript

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      VS Code Extension                          │
├─────────────────────────────────────────────────────────────────┤
│  extension.ts                                                   │
│  ├── Command registration (visualize, refresh, etc.)            │
│  ├── CodeLens provider (inline annotations)                     │
│  ├── Document change listeners (auto-refresh on save)           │
│  └── Coordinates parsing → visualization flow                   │
├─────────────────────────────────────────────────────────────────┤
│  parsers/                                                       │
│  ├── baseParser.ts      - Abstract base with shared logic       │
│  ├── pythonParser.ts    - Python @workflow decorator parsing    │
│  ├── csharpParser.ts    - C# [Workflow] attribute parsing       │
│  ├── javascriptParser.ts - JS/TS parsing                        │
│  └── index.ts           - Factory pattern for parser selection  │
├─────────────────────────────────────────────────────────────────┤
│  webview/                                                       │
│  ├── WorkflowVisualizerPanel.ts - Panel management + HTML/JS    │
│  └── index.ts                   - Exports                       │
├─────────────────────────────────────────────────────────────────┤
│  types/                                                         │
│  └── workflow.ts        - TypeScript interfaces                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Data Model

### Core Types (types/workflow.ts)

```typescript
interface WorkflowNode {
    id: string;              // Unique: 'start', 'end', 'activity-0', 'event-1', etc.
    type: NodeType;          // 'start'|'end'|'activity'|'event'|'decision'|'parallel'|...
    name: string;            // Activity/event function name
    label: string;           // Display label
    input?: string;          // Input expression (for tooltips)
    output?: string;         // Output variable name
    dataSources?: string[];  // Where input data comes from
    metadata?: {
        lineNumber?: number;
        isParallelTask?: boolean;
        taskVariable?: string;
        condition?: string;
        // ... more
    };
}

interface WorkflowEdge {
    source: string;          // Node ID
    target: string;          // Node ID
    type: 'control' | 'data';
    label?: string;          // 'True'/'False' for conditionals
    dataType?: string;       // For data flow: 'workflow-input', 'activity-output'
}

interface WorkflowDefinition {
    name: string;
    nodes: WorkflowNode[];
    edges: WorkflowEdge[];
    metadata?: {
        language?: string;
        inputType?: string;
        outputType?: string;
        inputFields?: string[];
        outputFields?: string[];
        returnExpression?: string;
    };
}
```

---

## Parsing Logic

### Multi-Workflow Support

**Problem:** A single file can contain multiple workflow functions. Need to parse them independently.

**Solution:** 
1. First pass: Find all `@workflow` decorators and their line ranges
2. Extract source code for each workflow function
3. Parse activities/events only within that function's scope
4. Track line offsets for accurate source navigation

```typescript
// Find workflow boundaries
const workflowPattern = /@workflow\s*\n\s*(?:async\s+)?def\s+(\w+)/g;

// Extract function body using indentation analysis
private extractFunctionBody(sourceCode: string, startIndex: number): string {
    // Find base indentation, continue until dedent
}
```

### Activity Detection Patterns

**Sequential activities (awaited):**
```python
result = await ctx.call_activity(my_activity, input=data)
```

**Parallel tasks (non-awaited):**
```python
task1 = ctx.call_activity(activity1, input=data)
task2 = ctx.call_activity(activity2, input=data)
results = await wf.when_all([task1, task2])
```

**Key insight:** Parallel tasks are assigned to variables WITHOUT `await`, then collected with `when_all`.

### Multi-Line Input Extraction

**Problem:** Regex patterns like `([^)\n]+)` stop at newlines, missing multi-line dict literals:
```python
email_task = ctx.call_activity(send_email, input={
    "to": customer.email,
    "subject": "Order confirmed"
})
```

**Solution:** Balanced bracket extraction:
```typescript
private extractInputExpression(sourceCode: string, matchIndex: number): string | undefined {
    // Find "input=" then extract with balanced braces
    const char = sourceCode[inputStart];
    if (char === '{' || char === '[' || char === '(') {
        return this.findMatchingBracket(sourceCode, inputStart);
    }
}

private findMatchingBracket(sourceCode: string, openIndex: number): number {
    // Track depth, skip string literals, handle nested brackets
}
```

### Parallel Block Detection (Fan-out/Fan-in)

**Pattern recognized:**
```python
# Fan-out
task1 = ctx.call_activity(...)
task2 = ctx.call_activity(...)

# Fan-in (join)
results = await wf.when_all([task1, task2])
```

**Data structures:**
- `parallelTaskMap`: Map<taskVariable, nodeId> - tracks task assignments
- `parallelGroupMap`: Map<nodeId, joinNodeId> - links tasks to their join node

**Edge building:**
```typescript
// For each parallel task, create edge: task → join
for (const [taskNodeId, joinNodeId] of this.parallelGroupMap) {
    edges.push({ source: taskNodeId, target: joinNodeId, type: 'control' });
}
```

### Event Detection

```python
await ctx.wait_for_external_event("event_name")
```

Creates node with `type: 'event'`, rendered as hexagon with ⚡ icon.

### Conditional Detection

```python
if condition:
    # branch A
else:
    # branch B
```

Creates diamond-shaped decision node with True/False edge labels.

---

## Visualization

### Layout Algorithm (Dagre)

```typescript
function dagreLayout() {
    // 1. Build adjacency maps (incoming/outgoing edges per node)
    // 2. Assign layers (ranks) based on dependencies
    // 3. Order nodes within layers to minimize edge crossings
    // 4. Calculate x,y positions with configurable spacing
    
    const rankSep = 80;  // Vertical spacing between layers
    const nodeSep = 60;  // Horizontal spacing between nodes
}
```

### Node Shapes by Type

| Type | Shape | Color | Text Color |
|------|-------|-------|------------|
| start | Pill (rounded rect) | Green #5a9a6e | White |
| end | Pill | Red #b86a6a | White |
| activity | Rectangle | Blue #6a9fcf | White |
| event | Hexagon | Orange #F59E0B | **Dark #1a1a1a** |
| decision | Diamond | Yellow #cfcf7a | **Dark #1a1a1a** |
| parallel | Double-border rect | Brown #8a7a6f | White |
| timer | Rectangle | Tan #cf9f6a | **Dark #1a1a1a** |

**Contrast fix:** Light backgrounds (yellow, orange, tan) need dark text, not white.

### SVG Rendering

```typescript
function renderNodes(container, layout) {
    for (const node of workflow.nodes) {
        const group = document.createElementNS(SVG_NS, 'g');
        group.classList.add('node', `node-${node.type}`);
        group.setAttribute('transform', `translate(${pos.x}, ${pos.y})`);
        group.dataset.nodeId = node.id;
        
        // Create shape based on type
        // Add label text
        // Add click handler
    }
}
```

### Edge Rendering

```typescript
function renderEdges(container, layout) {
    for (const edge of workflow.edges) {
        const path = document.createElementNS(SVG_NS, 'path');
        path.classList.add('edge', `edge-${edge.type}`);
        
        // Calculate path with curves
        const d = `M ${x1} ${y1} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${x2} ${y2}`;
        path.setAttribute('d', d);
        
        // Add arrowhead marker
    }
}
```

### Zoom/Pan Implementation

```typescript
let scale = 1, translateX = 0, translateY = 0;

function setupZoomPan(width, height) {
    container.addEventListener('wheel', (e) => {
        const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
        scale *= zoomFactor;
        scale = Math.max(0.1, Math.min(5, scale));  // Clamp
        applyTransform();
    });
    
    // Drag to pan
    container.addEventListener('mousedown', startDrag);
    container.addEventListener('mousemove', drag);
    container.addEventListener('mouseup', endDrag);
}

window.setTranslate = (x, y) => { translateX = x; translateY = y; applyTransform(); };
window.getScale = () => scale;
```

---

## Bugs Fixed & Lessons Learned

### 1. Focus on Click Toggle Bug

**Symptom:** Clicking "Show X in graph" alternated between focused and overview states.

**Root cause:** Race condition in message handling:
```javascript
// WRONG: renderWorkflow() checks pendingFocusNodeName, but it's set AFTER
renderWorkflow();
if (message.focusNodeName) {
    pendingFocusNodeName = message.focusNodeName;
}

// FIXED: Set focus BEFORE rendering
if (message.focusNodeName) {
    pendingFocusNodeName = message.focusNodeName;
}
renderWorkflow();
```

### 2. Auto-Refresh Switches Workflow

**Symptom:** Editing `shipping_workflow` and saving caused view to switch to `order_processing_workflow`.

**Root cause:** Auto-refresh didn't preserve current workflow context.

**Fix:** Track `_currentWorkflowName` in panel, pass to `visualizeDocument()` on save.

### 3. Parallel Tasks Not Detected

**Symptom:** "Join (3 tasks)" node floating disconnected.

**Root cause:** Regex `([^)\n]+)` stopped at newline, missing multi-line dict inputs.

**Fix:** Balanced bracket extraction instead of inline regex capture.

### 4. Node Click Opens New Editor

**Symptom:** Each click opened a new editor tab.

**Fix:** Check for existing editor first:
```typescript
const existingEditor = vscode.window.visibleTextEditors.find(
    e => e.document.uri.fsPath === targetUri.fsPath
);
if (existingEditor) {
    existingEditor.revealRange(range);
} else {
    vscode.window.showTextDocument(targetUri, { selection: range });
}
```

### 5. Text Contrast on Light Backgrounds

**Symptom:** White text on yellow/orange backgrounds unreadable.

**Fix:** CSS rules for specific node types:
```css
.node-event .node-label { fill: #1a1a1a; }
.node-decision .node-label { fill: #1a1a1a; }
.node-timer .node-label { fill: #1a1a1a; }
```

---

## CodeLens Integration

Provides inline annotations in editor:

```typescript
class WorkflowCodeLensProvider implements vscode.CodeLensProvider {
    provideCodeLenses(document): vscode.CodeLens[] {
        // For each @workflow decorator: "Visualize Workflow"
        // For each activity call: "Show X in graph"
        // For each event wait: "Show X in graph"
    }
}
```

---

## Webview ↔ Extension Communication

**Extension → Webview:**
```typescript
this._panel.webview.postMessage({
    type: 'updateWorkflow',
    workflow: this._workflow,
    options: this._getOptions(),
    focusNodeName: nodeName
});
```

**Webview → Extension:**
```typescript
// In webview JS
vscode.postMessage({ type: 'nodeClick', nodeId: node.id });

// In extension
this._panel.webview.onDidReceiveMessage(message => {
    if (message.type === 'nodeClick') {
        this._handleNodeClick(message.nodeId);
    }
});
```

---

## Differences for Live Dashboard Tool

| Aspect | This Extension (Static) | Dashboard (Live) |
|--------|------------------------|------------------|
| **Data source** | Source code parsing | Dapr sidecar API / OpenTelemetry traces |
| **Updates** | On file save | Real-time streaming |
| **Node state** | Structure only | Running/completed/failed states |
| **Timing** | N/A | Execution duration per node |
| **Instance tracking** | N/A | Multiple concurrent workflow instances |
| **UI framework** | VS Code Webview | Standalone web app (React?) |

### Key Adaptations Needed

1. **Data model additions:**
   ```typescript
   interface LiveWorkflowNode extends WorkflowNode {
       state: 'pending' | 'running' | 'completed' | 'failed';
       startTime?: Date;
       endTime?: Date;
       duration?: number;
       error?: string;
       retryCount?: number;
   }
   
   interface WorkflowInstance {
       instanceId: string;
       workflowName: string;
       state: 'running' | 'completed' | 'failed' | 'suspended';
       input: any;
       output?: any;
       nodes: LiveWorkflowNode[];
       currentNode?: string;  // For highlighting active node
   }
   ```

2. **Real-time updates:**
   - WebSocket connection to backend
   - Or poll Dapr workflow API: `GET /v1.0/workflows/{workflowComponent}/{instanceId}`
   - Animate node transitions (pulse effect on active node)

3. **Visual state indicators:**
   ```css
   .node-running { animation: pulse 1s infinite; }
   .node-completed { opacity: 0.7; border-color: green; }
   .node-failed { border-color: red; background: #ffeeee; }
   ```

4. **Timeline view:**
   - Gantt-chart style showing parallel execution
   - Duration bars on nodes

5. **Instance selector:**
   - Dropdown/list to switch between workflow instances
   - Filter by state, time range, workflow type

6. **Tracing integration:**
   - Link nodes to OpenTelemetry spans
   - Drill-down to see detailed traces

---

## File Reference

| File | Lines | Purpose |
|------|-------|---------|
| `src/extension.ts` | ~475 | Commands, CodeLens, document listeners |
| `src/parsers/pythonParser.ts` | ~1180 | Python workflow parsing (most complex) |
| `src/parsers/csharpParser.ts` | ~350 | C# parsing |
| `src/parsers/javascriptParser.ts` | ~400 | JS/TS parsing |
| `src/webview/WorkflowVisualizerPanel.ts` | ~1760 | Panel + embedded HTML/CSS/JS |
| `src/types/workflow.ts` | ~100 | Type definitions |

---

## Testing Checklist

- [ ] Single workflow file parses correctly
- [ ] Multi-workflow file shows separate CodeLens per workflow
- [ ] Parallel blocks render with fan-out/fan-in edges
- [ ] Multi-line input expressions detected
- [ ] Events render as hexagons with ⚡ icon
- [ ] Conditionals show diamond with True/False edges
- [ ] Node click navigates to source line
- [ ] Auto-refresh on save preserves current workflow view
- [ ] "Show X in graph" always focuses (no toggle)
- [ ] Text readable on all node colors
- [ ] Zoom/pan works smoothly
- [ ] Fit-to-view on initial render

---

*Document created: January 2026*
*Extension version: 0.0.1*
