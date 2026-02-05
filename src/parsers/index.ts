import { BaseWorkflowParser } from './baseParser';
import { CSharpWorkflowParser } from './csharpParser';
import { PythonWorkflowParser } from './pythonParser';
import { JavaScriptWorkflowParser } from './javascriptParser';
import { ParseResult, SupportedLanguage } from '../types/workflow';

/**
 * Parser registry and factory
 */
export class WorkflowParserFactory {
    private static parsers: BaseWorkflowParser[] = [
        new CSharpWorkflowParser(),
        new PythonWorkflowParser(),
        new JavaScriptWorkflowParser('javascript'),
        new JavaScriptWorkflowParser('typescript'),
    ];

    /**
     * Get the appropriate parser for a file
     */
    static getParser(filePath: string): BaseWorkflowParser | undefined {
        return this.parsers.find(parser => parser.canParse(filePath));
    }

    /**
     * Parse a workflow file
     * @param sourceCode The source code to parse
     * @param filePath The file path
     * @param targetWorkflowName Optional - if specified, only parse this workflow (for files with multiple workflows)
     */
    static parse(sourceCode: string, filePath: string, targetWorkflowName?: string): ParseResult {
        const parser = this.getParser(filePath);
        
        if (!parser) {
            return {
                success: false,
                errors: [{
                    message: `No parser available for file: ${filePath}. Supported languages: C#, Python, JavaScript, TypeScript`
                }]
            };
        }

        return parser.parse(sourceCode, filePath, targetWorkflowName);
    }

    /**
     * Check if a file can be parsed
     */
    static canParse(filePath: string): boolean {
        return this.parsers.some(parser => parser.canParse(filePath));
    }

    /**
     * Get supported file extensions
     */
    static getSupportedExtensions(): string[] {
        return ['.cs', '.py', '.js', '.ts', '.mjs', '.mts'];
    }

    /**
     * Get language from file path
     */
    static getLanguage(filePath: string): SupportedLanguage | undefined {
        if (filePath.endsWith('.cs')) {return 'csharp';}
        if (filePath.endsWith('.py')) {return 'python';}
        if (filePath.endsWith('.ts') || filePath.endsWith('.mts')) {return 'typescript';}
        if (filePath.endsWith('.js') || filePath.endsWith('.mjs')) {return 'javascript';}
        return undefined;
    }
}

export { BaseWorkflowParser } from './baseParser';
export { CSharpWorkflowParser } from './csharpParser';
export { PythonWorkflowParser } from './pythonParser';
export { JavaScriptWorkflowParser } from './javascriptParser';
