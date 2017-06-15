import * as vpath from "./vpath";
import { TextDocument } from "./documents";

const optionRegExp = /^\/{2}\s*@(\w+)\s*:\s*(.*?)\s*(?:\r\n?|\n|$)/gm;

export interface TestCaseParseResult {
    meta: Map<string, any>;
    documents: TextDocument[];
}

export function parseTestCase(document: TextDocument): TestCaseParseResult {
    const text = document.text;
    const meta = new Map<string, string>();
    const documents: TextDocument[] = [];
    let documentName: string | undefined;
    let documentMeta: Map<string, string> | undefined;
    let pos = optionRegExp.lastIndex = 0;
    let match: RegExpExecArray | null;
    while (match = optionRegExp.exec(text)) {
        const key = match[1].trim().toLowerCase();
        const value = match[2].trim();
        if (key === "filename") {
            // add previous document
            if (documentName && documentMeta) {
                documents.push(new TextDocument(documentName, { parent: document, pos, end: match.index }, documentMeta));
            }

            // start new document
            documentName = value;
            documentMeta = new Map<string, string>();
            documentMeta.set("filename", documentName);
        }
        else {
            meta.set(key, value);
            if (documentMeta) {
                documentMeta.set(key, value);
            }
        }
        pos = optionRegExp.lastIndex;
    }

    // Add remaining document
    documents.push(new TextDocument(documentName || vpath.basename(document.file), { parent: document, pos, end: text.length }, documentMeta || meta));
    return { meta, documents };
}