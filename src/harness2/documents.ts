import { isTypeScriptFile, isJavaScriptFile, isDeclarationFile, isSourceMapFile, isJsonFile } from "./utils";

export interface TextFragment {
    readonly parent: TextDocument;
    readonly pos: number;
    readonly end: number;
}

export class TextDocument {
    public readonly meta: Map<string, string>;
    public readonly parent: TextDocument | undefined;
    public readonly file: string;
    public readonly text: string;
    public readonly pos: number;
    public readonly end: number;
    constructor(file: string, content: string | TextFragment, meta?: Map<string, string>) {
        this.file = file;
        if (typeof content === "string") {
            this.parent = undefined;
            this.pos = 0;
            this.end = content.length;
            this.text = content;
        }
        else {
            this.parent = content.parent;
            this.pos = this.parent.pos + content.pos;
            this.end = this.parent.pos + content.end;
            this.text = this.parent.text.substring(this.pos, this.end);
        }
        this.meta = meta || new Map<string, string>();
    }
}

export function isTypeScriptDocument(document: TextDocument) {
    return isTypeScriptFile(document.file);
}

export function isJavaScriptDocument(document: TextDocument) {
    return isJavaScriptFile(document.file);
}

export function isDeclarationDocument(document: TextDocument) {
    return isDeclarationFile(document.file);
}

export function isSourceMapDocument(document: TextDocument) {
    return isSourceMapFile(document.file);
}

export function isJsonDocument(document: TextDocument) {
    return isJsonFile(document.file);
}