import { VirtualFileSystem } from "./vfs";
import { TextDocument, isJavaScriptDocument, isDeclarationDocument, isSourceMapDocument } from "./documents";
import * as vpath from "./vpath";
import * as ts from "./api";

export class CompilerHost {
    private _setParentNodes: boolean;
    private _sourceFiles = new Map<string, ts.SourceFile>();
    private _newLine: string;

    public readonly ts: ts.TypeScript;
    public readonly vfs: VirtualFileSystem;
    public readonly defaultLibLocation: string;
    public readonly outputs: TextDocument[] = [];
    public readonly traces: string[] = [];

    constructor(ts: ts.TypeScript, vfs: VirtualFileSystem, defaultLibLocation: string, newLine: "crlf" | "lf", setParentNodes = false) {
        this.ts = ts;
        this.vfs = vfs;
        this.defaultLibLocation = defaultLibLocation;
        this._newLine = newLine === "crlf" ? "\r\n" : "\n";
        this._setParentNodes = setParentNodes;
    }

    public getCurrentDirectory(): string {
        return this.vfs.currentDirectory;
    }

    public useCaseSensitiveFileNames(): boolean {
        return this.vfs.useCaseSensitiveFileNames;
    }

    public getNewLine(): string {
        return this._newLine;
    }

    public getCanonicalFileName(fileName: string): string {
        return this.vfs.useCaseSensitiveFileNames ? fileName : fileName.toLowerCase();
    }

    public fileExists(fileName: string): boolean {
        return this.vfs.fileExists(fileName);
    }

    public directoryExists(directoryName: string): boolean {
        return this.vfs.directoryExists(directoryName);
    }

    public getDirectories(path: string): string[] {
        const entry = this.vfs.getDirectory(path);
        return entry ? entry.getDirectories(/*recursive*/ true).map(dir => dir.relative) : [];
    }

    public readFile(path: string): string | undefined {
        const entry = this.vfs.getFile(path);
        return entry && entry.getContent();
    }

    public writeFile(fileName: string, content: string, writeByteOrderMark: boolean) {
        if (writeByteOrderMark) content = "\uFEFF" + content;
        const entry = this.vfs.addFile(fileName);
        if (entry) {
            entry.setContent(content);
            const document = new TextDocument(entry.path, content);
            const index = this.outputs.findIndex(doc => this.vfs.sameName(document.file, doc.file));
            if (index < 0) {
                this.outputs.push(document);
            }
            else {
                this.outputs[index] = document;
            }
        }
    }

    public trace(s: string): void {
        this.traces.push(s);
    }

    public realpath(path: string): string {
        const entry = this.vfs.getEntry(path, { followSymlinks: true });
        return entry && entry.path || path;
    }

    public getDefaultLibLocation(): string {
        return vpath.resolve(this.vfs.currentDirectory, this.defaultLibLocation);
    }

    public getDefaultLibFileName(options: ts.CompilerOptions): string {
        return vpath.resolve(this.getDefaultLibLocation(), this.ts.getDefaultLibFileName(options));
    }

    public getSourceFile(fileName: string, languageVersion: number): ts.SourceFile | undefined {
        fileName = this.getCanonicalFileName(vpath.resolve(this.vfs.currentDirectory, fileName));

        const existing = this._sourceFiles.get(fileName);
        if (existing) return existing;

        const content = this.readFile(fileName);
        if (content === undefined) return undefined;

        const parsed = this.ts.createSourceFile(fileName, content, languageVersion, this._setParentNodes);
        this._sourceFiles.set(fileName, parsed);
        return parsed;
    }
}

export class ParseConfigHost {
    public readonly ts: ts.TypeScript;
    public readonly vfs: VirtualFileSystem;

    constructor(ts: ts.TypeScript, vfs: VirtualFileSystem) {
        this.ts = ts;
        this.vfs = vfs;
    }

    public get useCaseSensitiveFileNames() {
        return this.vfs.useCaseSensitiveFileNames;
    }

    public readDirectory(path: string, extensions: string[], excludes: string[], includes: string[]): string[] {
        return this.ts.matchFiles(path, extensions, excludes, includes, this.vfs.useCaseSensitiveFileNames, this.vfs.currentDirectory, path => this.vfs.getAccessibleFileSystemEntries(path));
    }

    public fileExists(path: string) {
        return this.vfs.fileExists(path);
    }

    public readFile(path: string) {
        const entry = this.vfs.getFile(path);
        return entry && entry.getContent();
    }
}

export class CompilationResult {
    public readonly host: CompilerHost;
    public readonly program: ts.Program;
    public readonly result: ts.EmitResult;
    public readonly diagnostics: ts.Diagnostic[];

    private _js: TextDocument[] | undefined;
    private _dts: TextDocument[] | undefined;
    private _maps: TextDocument[] | undefined;

    constructor(host: CompilerHost, program: ts.Program, result: ts.EmitResult, diagnostics: ts.Diagnostic[]) {
        this.host = host;
        this.program = program;
        this.result = result;
        this.diagnostics = diagnostics;
    }

    public get ts() {
        return this.host.ts;
    }

    public get vfs() {
        return this.host.vfs;
    }

    public get options() {
        return this.program.getCompilerOptions();
    }

    public get outputs() {
        return this.host.outputs;
    }

    public get js(): TextDocument[] {
        return this._js || (this._js = this.outputs.filter(isJavaScriptDocument));
    }

    public get dts(): TextDocument[] {
        return this._dts || (this._dts = this.outputs.filter(isDeclarationDocument));
    }

    public get maps(): TextDocument[] {
        return this._maps || (this._maps = this.outputs.filter(isSourceMapDocument));
    }

    public get traces(): string[] {
        return this.host.traces;
    }

    public get emitSkipped(): boolean {
        return this.result.emitSkipped;
    }

    public get sourceMapData(): ts.SourceMapData[] {
        return this.result.sourceMaps;
    }

    public get singleFile() {
        return !!this.options.outFile || !!this.options.out;
    }

    public getOutputPath(path: string) {
        if (path.endsWith(".d.ts")) {
            // declaration files have no outputs
            return undefined;
        }

        const file = this.program.getSourceFile(path);
        if (!file) return undefined;

        let outFile = this.options.outFile || this.options.out;
        if (outFile) {
            return outFile;
        }

        outFile = vpath.resolve(this.vfs.currentDirectory, file.fileName);
        if (this.options.outDir) {
            // fix path relative to the output directory
            outFile = vpath.relative(this.program.getCommonSourceDirectory(), outFile, !this.vfs.useCaseSensitiveFileNames);
            outFile = vpath.combine(this.options.outDir, outFile);
        }

        // change the extension
        return vpath.chext(outFile, outFile.endsWith(".tsx") ? ".jsx" : ".js");
    }

    public getOutputs(path: string) {
        const outFile = this.getOutputPath(path);
        if (!outFile) return undefined;
        const dts = this.dts.find(document => this.vfs.sameName(outFile, vpath.chext(document.file, ".d.ts")));
        const js = this.js.find(document => this.vfs.sameName(outFile, document.file));
        return { dts, js };
    }
}

export function compileFiles(ts: ts.TypeScript, vfs: VirtualFileSystem, defaultLibLocation: string, rootFiles: string[], options: ts.CompilerOptions) {
    const host = new CompilerHost(ts, vfs, defaultLibLocation, "crlf");
    const program = ts.createProgram(rootFiles, options, host);
    const errors = ts.getPreEmitDiagnostics(program);
    const emitResult = program.emit();
    return new CompilationResult(host, program, emitResult, errors);
}