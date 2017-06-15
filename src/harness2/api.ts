// This file contains the minimal definitions for TypeScript needed to host the
// compiler for the purpose of running tests.

export interface MapLike<T> {
    [index: string]: T;
}

export interface DiagnosticMessageChain {
    messageText: string;
    category: number;
    code: number;
    next?: DiagnosticMessageChain;
}

export interface Diagnostic {
    file: SourceFile | undefined;
    start: number | undefined;
    length: number | undefined;
    messageText: string | DiagnosticMessageChain;
    category: number;
    code: number;
    source?: string;
}

export interface PluginImport {
    name: string;
}

export type CompilerOptionsValue = string | number | boolean | (string | number)[] | string[] | MapLike<string[]> | PluginImport[];

export interface CompilerOptions {
    declaration?: boolean;
    inlineSourceMap?: boolean;
    noEmitOnError?: boolean;
    noEmit?: boolean;
    out?: string;
    outDir?: string;
    outFile?: string;
    sourceMap?: boolean;
    traceResoluton?: boolean;
    [option: string]: CompilerOptionsValue | undefined;
}

export interface ParsedCommandLine {
    options: CompilerOptions;
    fileNames: string[];
    errors: Diagnostic[];
}

export interface SourceMapSpan {
    emittedLine: number;
    emittedColumn: number;
    sourceLine: number;
    sourceColumn: number;
    sourceIndex: number;
    nameIndex?: number;
}

export interface SourceMapData {
    jsSourceMappingURL: string;
    inputSourceFileNames: string[];
    sourceMapFilePath: string;
    sourceMapFile: string;
    sourceMapSourceRoot: string;
    sourceMapSources: string[];
    sourceMapSourcesContent?: string[];
    sourceMapNames?: string[];
    sourceMapMappings: string;
    sourceMapDecodedMappings: SourceMapSpan[];
}

export interface EmitResult {
    emitSkipped: boolean;
    diagnostics: Diagnostic[];
    emittedFiles: string[];
    sourceMaps: SourceMapData[];
}

export interface ModuleResolutionHost {
    fileExists(fileName: string): boolean;
    readFile(fileName: string): string | undefined;
    trace?(s: string): void;
    directoryExists?(directoryName: string): boolean;
    realpath?(path: string): string;
    getCurrentDirectory?(): string;
    getDirectories?(path: string): string[];
}

export interface ScriptReferenceHost {
    getCompilerOptions(): CompilerOptions;
    getSourceFile(fileName: string): SourceFile;
    getSourceFileByPath(path: string): SourceFile;
    getCurrentDirectory(): string;
}

export interface ParseConfigHost {
    useCaseSensitiveFileNames: boolean;
    readDirectory(rootDir: string, extensions: string[], excludes: string[], includes: string[]): string[];
    fileExists(path: string): boolean;
    readFile(path: string): string | undefined;
}

export interface CompilerHost extends ModuleResolutionHost {
    getSourceFile(fileName: string, languageVersion: number, onError?: (message: string) => void): SourceFile | undefined;
    getDefaultLibFileName(options: CompilerOptions): string;
    getDefaultLibLocation(): string;
    writeFile(fileName: string, data: string, writeByteOrderMark: boolean, onError?: (message: string) => void, sourceFiles?: SourceFile[]): void;
    getCurrentDirectory(): string;
    getDirectories(path: string): string[];
    getCanonicalFileName(fileName: string): string;
    useCaseSensitiveFileNames(): boolean;
    getNewLine(): string;
}

export interface Program extends ScriptReferenceHost {
    getRootFileNames(): string[];
    getSourceFiles(): SourceFile[];
    emit(): EmitResult;
    getOptionsDiagnostics(): Diagnostic[];
    getGlobalDiagnostics(): Diagnostic[];
    getSyntacticDiagnostics(): Diagnostic[];
    getSemanticDiagnostics(): Diagnostic[];
    getDeclarationDiagnostics(): Diagnostic[];
    // getTypeChecker(): TypeChecker;

    getCommonSourceDirectory(): string;
}

export interface SourceFile {
    fileName: string;
}

export interface FormatDiagnosticsHost {
    getCurrentDirectory(): string;
    getCanonicalFileName(fileName: string): string;
    getNewLine(): string;
}

export interface TypeScript {
    computeLineStarts(text: string): number[];
    compareDiagnostics(d1: Diagnostic, d2: Diagnostic): number;
    flattenDiagnosticMessageText(messageText: string | DiagnosticMessageChain, newLine: string): string;
    formatDiagnostics(diagnostics: Diagnostic[], host: FormatDiagnosticsHost): string;
    getDefaultLibFileName(options: CompilerOptions): string;
    parseConfigFileTextToJson(fileName: string, jsonText: string, stripComments?: boolean): { config?: any; error?: Diagnostic };
    parseJsonConfigFileContent(json: any,host: ParseConfigHost, basePath: string, existingOptions?: CompilerOptions, configFileName?: string): ParsedCommandLine;
    createProgram(rootNames: string[], options: CompilerOptions, host?: CompilerHost, oldProgram?: Program): Program;
    getPreEmitDiagnostics(program: Program): Diagnostic[];
    createSourceFile(fileName: string, sourceText: string, languageVersion: number, setParentNodes?: boolean): SourceFile;
    matchFiles(path: string, extensions: string[], excludes: string[], includes: string[], useCaseSensitiveFileNames: boolean, currentDirectory: string, getFileSystemEntries: (path: string) => { files: string[], directories: string[] }): string[]
}