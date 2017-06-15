import * as vpath from "../vpath";
import * as io from "../io";
import { Runner } from "../runner";
import { TextDocument, isDeclarationDocument, isTypeScriptDocument } from "../documents";
import { VirtualFileSystem } from "../vfs";
import { parseTestCase } from "../testCaseParser";
import { compareStrings } from "../utils";
import { compileFiles, CompilationResult, ParseConfigHost } from "../compiler";
import { assert } from "chai";
import { baseline } from "../baselines";
import * as ts from "../api";
import { formatDiagnostics, formatJavaScript, formatSourceMaps } from "../formatters";

export const enum CompilerTestType {
    Conformance,
    Regressions,
    Test262
}

export class CompilerRunner extends Runner<"conformance" | "compiler"> {
    public readonly basePath: string;

    constructor(id: "conformance" | "compiler") {
        super(id);
        this.basePath = vpath.combine("tests/cases", id);
    }

    // nee. enumerateTestFiles()
    public discover(): string[] {
        return io.getFiles(this.basePath, { recursive: true, pattern: /\.tsx?$/, qualified: true });
    }

    // nee. initializeTests()
    protected describe(file: string): void {
        describe(`compiler tests for ${file}`, () => {
            let compilerTest: CompilerTest | undefined;
            before(() => compilerTest = new CompilerTest(this.ts, file));
            it("errors", () => compilerTest && compilerTest.verifyDiagnostics());
            it("module resolution", () => compilerTest && compilerTest.verifyModuleResolution());
            it("sourcemap record", () => compilerTest && compilerTest.verifySourceMapRecord());
            it("output", () => compilerTest && compilerTest.verifyJavaScriptOutput());
            it("sourcemap", () => compilerTest && compilerTest.verifySourceMapOutput());
            it("types", () => compilerTest && compilerTest.verifyTypes());
            it("symbols", () => compilerTest && compilerTest.verifySymbols());
            after(() => compilerTest = undefined);
        });
    }
}

class CompilerTest {
    private result: CompilationResult;
    private declarationResult: CompilationResult | undefined;
    private ts: ts.TypeScript;
    private basename: string;
    private document: TextDocument;
    private documents: TextDocument[];
    private configFile: TextDocument | undefined;
    private meta: Map<string, string>;
    private vfs: VirtualFileSystem;
    private defaultLibLocation = vpath.resolve(__dirname, "../../built/local");
    private rootFiles: string[] = [];
    private declarationRootFiles: string[] | undefined;
    private config: ts.ParsedCommandLine | undefined;
    private options: ts.CompilerOptions;
    private hasNonDeclarationFiles = false;
    private useCaseSensitiveFileNames: boolean;
    private fullEmitPaths: boolean;
    private noTypeBaseline: boolean;
    private noSymbolBaseline: boolean;
    // private typesAndSymbols: Map<string, TypeWriterResult[]> | undefined;

    constructor(ts: ts.TypeScript, file: string) {
        this.ts = ts;
        this.basename = vpath.basename(file);
        this.document = new TextDocument(file, io.readFile(file) || "");

        const { documents, meta } = parseTestCase(this.document);
        this.documents = documents;
        this.meta = meta;

        // TODO: parse tsconfig.json
        // TODO: @baseUrl
        // TODO: @includeBuiltFile
        // TODO: @baselineFile
        // TODO: @libFiles
        // TODO: @noImplicitReferences

        this.noTypeBaseline = compareStrings(this.meta.get("notypebaseline"), "true", /*ignoreCase*/ true) === 0;
        this.noSymbolBaseline = compareStrings(this.meta.get("nosymbolbaseline"), "true", /*ignoreCase*/ true) === 0;
        this.useCaseSensitiveFileNames = compareStrings(this.meta.get("usecasesensitivefilenames"), "true", /*ignoreCase*/ true) === 0;
        this.fullEmitPaths = compareStrings(this.meta.get("fullemitpaths"), "true", /*ignoreCase*/ true) === 0;
        this.vfs = VirtualFileSystem.getBuiltLocal(this.useCaseSensitiveFileNames).clone();

        const currentDirectory = this.meta.get("currentDirectory");
        this.vfs.changeDirectory(currentDirectory || vpath.dirname(file));

        // Add documents
        for (const document of this.documents) {
            const file = this.vfs.addFile(document.file, document.text);
            if (!file) throw new Error(`Failed to add file: '${document.file}'`);

            // Add symlinks
            const symlink = document.meta.get("symlink");
            if (file && symlink) {
                for (const link of symlink.split(",")) {
                    this.vfs.addSymlink(vpath.resolve(this.vfs.currentDirectory, link.trim()), file);
                }
            }

            if (this.vfs.sameName(file.name, "tsconfig.json")) {
                if (!this.configFile) {
                    this.configFile = document;
                }
            }
            else {
                if (!vpath.extname(document.file, { extensions: [".d.ts" ] })) {
                    this.hasNonDeclarationFiles = true;
                }
                this.rootFiles.push(document.file);
            }
        }

        let compilerOptions: ts.CompilerOptions;
        if (this.configFile) {
            const { config } = this.ts.parseConfigFileTextToJson(this.configFile.file, this.configFile.text);
            assert.isDefined(config);
            const baseDir = vpath.dirname(this.configFile.file);
            const host = new ParseConfigHost(this.ts, this.vfs);
            this.config = this.ts.parseJsonConfigFileContent(config, host, baseDir, /*existingOptions*/ undefined, this.configFile.file);
            compilerOptions = this.config.options;
        }
        else {
            compilerOptions = {};
        }

        this.result = compileFiles(this.ts, this.vfs, this.defaultLibLocation, this.rootFiles, compilerOptions);
        this.options = this.result.options;

        // check declaration files
        if (this.hasNonDeclarationFiles && this.options.declaration && this.result.diagnostics.length === 0 && this.result.dts.length > 0) {
            this.declarationRootFiles = [];
            for (const document of this.documents) {
                if (isDeclarationDocument(document)) {
                    this.declarationRootFiles.push(document.file);
                }
                else if (isTypeScriptDocument(document)) {
                    const outputs = this.result.getOutputs(document.file);
                    assert.isDefined(outputs, `Program has no source file with name '${document.file}'`);
                    const dts = outputs && outputs.dts;
                    if (dts) this.declarationRootFiles.push(dts.file);
                }
            }

            this.declarationResult = compileFiles(this.ts, this.vfs, this.defaultLibLocation, this.declarationRootFiles, this.options);
        }

        // walk types and symbols
        if (this.result.diagnostics.length === 0 && (!this.noTypeBaseline || !this.noSymbolBaseline)) {
            // The full walker simulates the types that you would get from doing a full
            // compile.  The pull walker simulates the types you get when you just do
            // a type query for a random node (like how the LS would do it).  Most of the
            // time, these will be the same.  However, occasionally, they can be different.
            // Specifically, when the compiler internally depends on symbol IDs to order
            // things, then we may see different results because symbols can be created in a
            // different order with 'pull' operations, and thus can produce slightly differing
            // output.
            //
            // For example, with a full type check, we may see a type displayed as: number | string
            // But with a pull type check, we may see it as:                        string | number
            //
            // These types are equivalent, but depend on what order the compiler observed
            // certain parts of the program.

            // const program = this.result.program;
            // const fullWalker = new TypeWriterWalker(program, /*fullTypeCheck*/ true);
            // this.typesAndSymbols = new Map<string, TypeWriterResult[]>();
            // for (const document of this.documents) {
            //     this.typesAndSymbols.set(document.file, fullWalker.getTypeAndSymbols(document.file));
            // }
        }
    }

    private get isEmitSkipped() {
        return this.options.noEmitOnError && this.result.diagnostics.length > 0;
    }

    public verifyDiagnostics(): void {
        const hasContent = this.result.diagnostics.length > 0;
        const content = hasContent ? formatDiagnostics(this.documents, this.result) : undefined;
        baseline(vpath.chext(this.basename, ".errors.txt"), content);
    }

    public verifyModuleResolution(): void {
        if (!this.options.traceResolution) return;
        const content = JSON.stringify(this.result.traces, /*replacer*/ undefined, "    ");
        baseline(vpath.chext(this.basename, ".trace.json"), content);
    }

    public verifySourceMapRecord(): void {
        // if (this.options.sourceMap || this.options.inlineSourceMap) {
        //     const sourceMapContent = this.isEmitSkipped ? undefined : this.result.getSourceMapRecord();
        //     baseline(this.name + ".sourcemap.text", sourceMapContent);
        // }
    }

    public verifyJavaScriptOutput(): void {
        if (!this.hasNonDeclarationFiles) return;
        assert.isOk(this.options.noEmit || this.result.js.length || this.result.diagnostics.length, "Expected at least one js file to be emitted or at least one error to be created.");
        assert.isOk(!this.options.declaration || this.result.diagnostics.length > 0 || this.result.dts.length === this.result.js.length, "There were no errors and declFiles generated did not match number of js files generated.");
        const hasContent = this.result.js.length > 0 || this.result.dts.length > 0 || (this.declarationResult && this.declarationResult.diagnostics.length > 0);
        const content = hasContent ? formatJavaScript(this.basename, this.fullEmitPaths, this.documents, this.result, this.declarationResult) : undefined;
        baseline(vpath.chext(this.basename, ".js"), content);
    }

    public verifySourceMapOutput(): void {
        if (this.options.inlineSourceMap) {
            assert.lengthOf(this.result.maps, 0, "No sourcemap files should be generated if inlineSourceMaps was set.");
            return;
        }

        if (!this.options.sourceMap) return;
        assert.lengthOf(this.result.maps, this.result.js.length, "Number of sourcemap files should be same as js files.");
        const hasContent = !this.isEmitSkipped && this.result.maps.length > 0;
        const content = hasContent ? formatSourceMaps(this.fullEmitPaths, this.result) : undefined;
        baseline(vpath.chext(this.basename, ".js.map"), content);
    }

    public verifyTypes(): void {
        if (this.noTypeBaseline || this.result.diagnostics.length > 0) return;
    }

    public verifySymbols(): void {
        if (this.noSymbolBaseline || this.result.diagnostics.length > 0) return;
    }
}