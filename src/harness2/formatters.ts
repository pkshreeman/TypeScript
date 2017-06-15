import * as ts from "./api";
import * as vpath from "./vpath";
import { TextDocument } from "./documents";
import { TextWriter } from "./textWriter";
import { isDefaultLibraryFile, padLeft, repeatString, isBuiltFile } from "./utils";
import { assert } from "chai";
import { CompilationResult } from "./compiler";

export function formatJavaScript(header: string, fullEmitPaths: boolean, documents: TextDocument[], result: CompilationResult, declarationResult: CompilationResult | undefined) {
    const writer = new TextWriter();

    // add header if needed
    if (documents.length > 1) writer.writeln(`//// [${header}] ////`);

    // add each input document
    for (const document of documents) {
        if (writer.size > 0) writer.writeln();
        writer.writeln(`//// [${vpath.basename(document.file)}]`);
        writer.write(document.text);
    }

    // add space between ts and js/dts emit
    if (result.js.length > 0 || result.dts.length > 0 || (declarationResult && declarationResult.diagnostics.length > 0)) writer.writeln();

    // add each script output
    for (const document of result.js) {
        const file = fullEmitPaths ? document.file : vpath.basename(document.file);
        if (writer.size > 0) writer.writeln();
        writer.writeln(`//// [${file}]`);
        writer.write(document.text);
    }

    // Add space between js and dts emit
    if (result.js.length > 0 && result.dts.length > 0) writer.writeln();

    // add each declaration output
    for (const document of result.dts) {
        const file = fullEmitPaths ? document.file : vpath.basename(document.file);
        if (writer.size > 0) writer.writeln();
        writer.writeln(`//// [${file}]`);
        writer.write(document.text);
    }

    // add declaration diagnostics
    if (declarationResult && declarationResult.diagnostics.length > 0) {
        writer.writeln();
        writer.writeln();
        writer.writeln(`//// [DtsFileErrors]`);
        writer.writeln();
        writer.writeln();
        writer.write(formatDiagnostics(documents, declarationResult));
    }

    return writer.toString();
}

export function formatSourceMaps(fullEmitPaths: boolean, result: CompilationResult) {
    const writer = new TextWriter();
    for (const map of result.maps) {
        const file = fullEmitPaths ? map.file : vpath.basename(map.file);
        writer.writeln(`//// [${file}]`);
        writer.write(map.text);
    }
    return writer.toString();
}

export function formatDiagnostics(documents: TextDocument[], result: CompilationResult) {
    const ts = result.ts;
    const diagnostics = result.diagnostics;
    diagnostics.sort(ts.compareDiagnostics);

    let numNonLibraryDiagnostics = 0;
    let numLibraryDiagnostics = 0;
    let numTest262HarnessDiagnostics = 0;

    const writer = new TextWriter(ts.formatDiagnostics(diagnostics, {
        getCanonicalFileName: path => result.host.getCanonicalFileName(path),
        getCurrentDirectory: () => "",
        getNewLine: () => "\r\n"
    }));

    writer.writeln();
    writer.writeln();

    // write global diagnostics first
    for (const diagnostic of diagnostics) {
        if (!diagnostic.file) {
            writeDiagnostic(diagnostic);
        }
        else if (isDefaultLibraryFile(diagnostic.file.fileName) || isBuiltFile(diagnostic.file.fileName)) {
            numLibraryDiagnostics++;
        }
        else if (diagnostic.file.fileName.includes("test262-harness")) {
            numTest262HarnessDiagnostics++;
        }
    }

    // write file diagnostics
    for (const document of documents) {
        const fileDiagnostics = diagnostics.filter(diagnostic => {
            const file = diagnostic.file;
            return file !== undefined && file.fileName === document.file;
        });

        writer.writeln(`==== ${document.file} (${fileDiagnostics.length} errors) ====`);
        let numMarkedDiagnostics = 0;

        // For each line, emit the line followed by any error squiggles matching this line
        const lineStarts = ts.computeLineStarts(document.text);
        const lines = document.text.split(/\r\n?|\n/g);
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
            const line = lines[lineIndex];
            const thisLineStart = lineStarts[lineIndex];
            const nextLineStart = lineIndex === lines.length - 1 ? document.text.length : lineStarts[lineIndex + 1];
            // Emit this line from the original file
            writer.writeln(`    ${line}`);
            for (const diagnostic of fileDiagnostics) {
                if (diagnostic.start === undefined || diagnostic.length === undefined) continue;
                const end = diagnostic.start + diagnostic.length;
                // Does any error start or continue on to this line? Emit squiggles
                if (end >= thisLineStart && (diagnostic.start < nextLineStart || lineIndex === lines.length - 1)) {
                    // How many characters from the start of this line the error starts at (could be positive or negative)
                    const relativeOffset = diagnostic.start - thisLineStart;
                    // How many characters of the error are on this line (might be longer than this line in reality)
                    const length = diagnostic.length - Math.max(0, thisLineStart - diagnostic.start);
                    // Calculate the start of the squiggle
                    const squiggleStart = Math.max(0, relativeOffset);
                    const squiggleLength = Math.min(length, line.length - squiggleStart);
                    writer.writeln(`    ${padLeft("", squiggleStart)}${repeatString("~", squiggleLength)}`);

                    // If the error ended here, or we're at the end of the file, emit its message
                    if ((lineIndex === lines.length - 1) || nextLineStart > end) {
                        writeDiagnostic(diagnostic);
                        numMarkedDiagnostics++;
                    }
                }
            }
        }

        assert.lengthOf(fileDiagnostics, numMarkedDiagnostics, `Incorrect number of marked errors in ${document.file}`);
    }

    assert.lengthOf(diagnostics, numNonLibraryDiagnostics + numLibraryDiagnostics + numTest262HarnessDiagnostics, "total number of errors");
    return writer.toString();

    function writeDiagnostic(diagnostic: ts.Diagnostic) {
        writer.writeln(removeEmptyLines(formatDiagnostic(ts, diagnostic)));
        if (!diagnostic.file || !isDefaultLibraryFile(diagnostic.file.fileName)) {
            numNonLibraryDiagnostics++;
        }
    }
}

const errorPathRegExp = /^(.+?)\(\d+,\d+\):/;
export function formatDiagnostic(ts: ts.TypeScript, diagnostic: ts.Diagnostic) {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\r\n");
    const match = errorPathRegExp.exec(message);
    const path = match && match[1];
    return path && vpath.isAbsolute(path) ? vpath.basename(path) + message.slice(path.length) : message;
}

const lineRegExp = /(\r\n?|\n)(\s*(\r\n?|\n))+/g;
export function removeEmptyLines(text: string) {
    return text.replace(lineRegExp, "\r\n");
}