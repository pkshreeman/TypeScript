import { EventEmitter } from "events";
import { compareStrings } from "./utils";
import * as vpath from "./vpath";
import * as io from "./io";

export interface FileSystemResolver {
    getEntries(dir: VirtualDirectory): { files: string[], directories: string[] };
    getContent(file: VirtualFile): string | undefined;
}

export function createResolver(io: io.IO): FileSystemResolver {
    return {
        getEntries(dir) {
            return io.getAccessibleFileSystemEntries(dir.path);
        },
        getContent(file) {
            return io.readFile(file.path);
        }
    };
}

export abstract class VirtualFileSystemEntry extends EventEmitter {
    private _readOnly = false;
    private _path: string | undefined;

    public readonly fileSystem: VirtualFileSystem;
    public readonly parent: VirtualFileSystemContainer;
    public readonly name: string;

    constructor(parent: VirtualFileSystemContainer | undefined, name: string) {
        super();

        if (this instanceof VirtualFileSystem) {
            this.parent = this.fileSystem = this;
        }
        else if (parent instanceof VirtualDirectoryRoot) {
            this.parent = this.fileSystem = parent.fileSystem;
        }
        else if (parent) {
            this.parent = parent;
            this.fileSystem = parent.fileSystem;
        }
        else {
            throw new TypeError("Argument not optional: parent");
        }

        this.name = name;
    }

    public get isReadOnly(): boolean {
        return this._readOnly;
    }

    public get path(): string {
        return this._path || (this._path = vpath.combine(this.parent.path, this.name));
    }

    public get relative(): string {
        return this.relativeTo(this.fileSystem.currentDirectory);
    }

    public get exists(): boolean {
        return this.parent.exists
            && this.parent.getEntry(this.name) as VirtualFileSystemEntry === this;
    }

    public makeReadOnly(): void {
        this.makeReadOnlyCore();
        this._readOnly = true;
    }

    public relativeTo(other: string | VirtualFileSystemEntry) {
        if (other) {
            const otherPath = typeof other === "string" ? other : other.path;
            const ignoreCase = !this.fileSystem.useCaseSensitiveFileNames;
            return vpath.relative(otherPath, this.path, ignoreCase);
        }
        return this.path;
    }

    public abstract clone(parent: VirtualFileSystemContainer): VirtualFileSystemEntry;

    protected abstract makeReadOnlyCore(): void;

    protected writePreamble(): void {
        if (this._readOnly) throw new Error("Cannot modify a frozen entry.");
    }
}

export abstract class VirtualFileSystemContainer extends VirtualFileSystemEntry {
    public getEntries(options: { recursive?: boolean, pattern?: RegExp, kind: "file" }): VirtualFile[];
    public getEntries(options: { recursive?: boolean, pattern?: RegExp, kind: "directory" }): VirtualDirectory[];
    public getEntries(options?: { recursive?: boolean, pattern?: RegExp, kind?: "file" | "directory" }): (VirtualFile | VirtualDirectory)[];
    public getEntries(options: { recursive?: boolean, pattern?: RegExp, kind?: "file" | "directory" } = {}): (VirtualFile | VirtualDirectory)[] {
        if (options.recursive) {
            const results: (VirtualFile | VirtualDirectory)[] = [];
            for (const entry of this.getOwnEntries()) {
                if (entry instanceof VirtualFile) {
                    if (isMatch(entry, options)) {
                        results.push(entry);
                    }
                }
                else if (entry instanceof VirtualDirectory) {
                    if (isMatch(entry, options)) {
                        results.push(entry);
                    }
                    for (const child of entry.getEntries(options)) {
                        results.push(child);
                    }
                }
            }
            return results;
        }
        return this.getOwnEntries().filter(entry => isMatch(entry, options));
    }

    public getDirectories(options: { recursive?: boolean, pattern?: RegExp } = {}): VirtualDirectory[] {
        return this.getEntries({ kind: "directory", ...options });
    }

    public getFiles(options: { recursive?: boolean, pattern?: RegExp } = {}): VirtualFile[] {
        return this.getEntries({ kind: "file", ...options });
    }

    public getEntryNames(options: { recursive?: boolean, qualified?: boolean, pattern?: RegExp, kind?: "file" | "directory" } = {}): string[] {
        return this.getEntries(options).map(entry =>
            options && options.qualified ? entry.path :
            options && options.recursive ? entry.relativeTo(this) :
            entry.name);
    }

    public getDirectoryNames(options: { recursive?: boolean, qualified?: boolean, pattern?: RegExp } = {}): string[] {
        return this.getEntryNames({ kind: "directory", ...options });
    }

    public getFileNames(options: { recursive?: boolean, qualified?: boolean, pattern?: RegExp } = {}): string[] {
        return this.getEntryNames({ kind: "file", ...options });
    }

    public getEntry(path: string, options: { followSymlinks?: boolean, pattern?: RegExp, kind: "file" }): VirtualFile | undefined;
    public getEntry(path: string, options: { followSymlinks?: boolean, pattern?: RegExp, kind: "directory" }): VirtualDirectory | undefined;
    public getEntry(path: string, options?: { followSymlinks?: boolean, pattern?: RegExp, kind?: "file" | "directory" }): VirtualFile | VirtualDirectory | undefined;
    public getEntry(path: string, options: { followSymlinks?: boolean, pattern?: RegExp, kind?: "file" | "directory" } = {}): VirtualFile | VirtualDirectory | undefined {
        const basename = vpath.basename(path);
        if (!basename) return undefined;
        const dirname = vpath.dirname(path);
        if (dirname) {
            const directory = this.getDirectory(dirname);
            return directory && directory.getEntry(basename, options);
        }
        for (const entry of this.getEntries()) {
            if (this.fileSystem.sameName(entry.name, basename)) {
                if (!isMatch(entry, options)) return undefined;
                return options.followSymlinks ? this.fileSystem.getRealEntry(entry) : entry;
            }
        }
        return undefined;
    }

    public getDirectory(path: string, options: { followSymlinks?: boolean, pattern?: RegExp } = {}): VirtualDirectory | undefined {
        return this.getEntry(path, { kind: "directory", ...options });
    }

    public getFile(path: string, options: { followSymlinks?: boolean, pattern?: RegExp } = {}): VirtualFile | undefined {
        return this.getEntry(path, { kind: "file", ...options });
    }

    protected abstract getOwnEntries(): (VirtualFile | VirtualDirectory)[];
}

export interface VirtualFileSystemContainer {
    on(name: "childAdded", handler: (entry: VirtualFile | VirtualDirectory) => void): this;
    on(name: "childRemoved", handler: (entry: VirtualFile | VirtualDirectory) => void): this;
}

export class VirtualFileSystem extends VirtualFileSystemContainer {
    private static _builtLocal: VirtualFileSystem | undefined;
    private static _builtLocalCI: VirtualFileSystem | undefined;
    private static _builtLocalCS: VirtualFileSystem | undefined;

    private _root: VirtualDirectoryRoot;
    private _useCaseSensitiveFileNames: boolean;
    private _currentDirectory: string;

    constructor(currentDirectory: string, useCaseSensitiveFileNames: boolean) {
        super(/*parent*/ undefined, "");
        this._currentDirectory = currentDirectory.replace(/\\/g, "/");
        this._useCaseSensitiveFileNames = useCaseSensitiveFileNames;
    }

    public get useCaseSensitiveFileNames() {
        return this._useCaseSensitiveFileNames;
    }

    public get currentDirectory() {
        return this._currentDirectory;
    }

    public get path() {
        return "";
    }

    public get relative() {
        return "";
    }

    public get exists() {
        return true;
    }

    private get root() {
        if (this._root === undefined) {
            this._root = new VirtualDirectoryRoot(this);
            if (this.isReadOnly) this._root.makeReadOnly();
        }
        return this._root;
    }

    public static getBuiltLocal(useCaseSensitiveFileNames: boolean = io.useCaseSensitiveFileNames()): VirtualFileSystem {
        let vfs = useCaseSensitiveFileNames ? this._builtLocalCS : this._builtLocalCI;
        if (!vfs) {
            vfs = this._builtLocal;
            if (!vfs) {
                const resolver = createResolver(io);
                vfs = new VirtualFileSystem(vpath.resolve(__dirname, "../../"), io.useCaseSensitiveFileNames());
                vfs.addDirectory("built/local", resolver);
                vfs.addDirectory("tests/lib", resolver);
                vfs.makeReadOnly();
                this._builtLocal = vfs;
            }
            if (vfs._useCaseSensitiveFileNames !== useCaseSensitiveFileNames) {
                vfs = vfs.clone();
                vfs._useCaseSensitiveFileNames = useCaseSensitiveFileNames;
                vfs.makeReadOnly();
            }
            return useCaseSensitiveFileNames
                ? this._builtLocalCS = vfs
                : this._builtLocalCI = vfs;
        }
        return vfs;
    }

    public changeDirectory(path: string) {
        this.writePreamble();
        if (path) {
            this._currentDirectory = vpath.resolve(this._currentDirectory, path);
        }
    }

    public addDirectory(path: string, resolver?: FileSystemResolver) {
        return this.root.addDirectory(vpath.resolve(this.currentDirectory, path), resolver);
    }

    public addFile(path: string, content?: FileSystemResolver["getContent"] | string) {
        return this.root.addFile(vpath.resolve(this.currentDirectory, path), content);
    }

    public addSymlink(path: string, target: VirtualFile): VirtualFileSymlink | undefined;
    public addSymlink(path: string, target: VirtualDirectory): VirtualDirectorySymlink | undefined;
    public addSymlink(path: string, target: string | VirtualFile | VirtualDirectory): VirtualSymlink | undefined;
    public addSymlink(path: string, target: string | VirtualFile | VirtualDirectory) {
        if (typeof target === "string") target = vpath.resolve(this.currentDirectory, target);
        return this.root.addSymlink(vpath.resolve(this.currentDirectory, path), target);
    }

    public removeDirectory(path: string): boolean {
        return this.root.removeDirectory(vpath.resolve(this.currentDirectory, path));
    }

    public removeFile(path: string): boolean {
        return this.root.removeFile(vpath.resolve(this.currentDirectory, path));
    }

    public directoryExists(path: string) {
        return this.getEntry(path) instanceof VirtualDirectory;
    }

    public fileExists(path: string) {
        return this.getEntry(path) instanceof VirtualFile;
    }

    public sameName(a: string, b: string) {
        return compareStrings(a, b, !this.useCaseSensitiveFileNames) === 0;
    }

    public getRealEntry(entry: VirtualDirectory): VirtualDirectory | undefined;
    public getRealEntry(entry: VirtualFile): VirtualFile | undefined;
    public getRealEntry(entry: VirtualFile | VirtualDirectory): VirtualFile | VirtualDirectory | undefined;
    public getRealEntry(entry: VirtualFile | VirtualDirectory): VirtualFile | VirtualDirectory | undefined {
        if (entry instanceof VirtualFileSymlink || entry instanceof VirtualDirectorySymlink) {
            return findTarget(this, entry.target);
        }
        return entry;
    }

    public getEntry(path: string, options: { followSymlinks?: boolean, pattern?: RegExp, kind: "file" }): VirtualFile | undefined;
    public getEntry(path: string, options: { followSymlinks?: boolean, pattern?: RegExp, kind: "directory" }): VirtualDirectory | undefined;
    public getEntry(path: string, options?: { followSymlinks?: boolean, pattern?: RegExp, kind?: "file" | "directory" }): VirtualFile | VirtualDirectory | undefined;
    public getEntry(path: string, options?: { followSymlinks?: boolean, pattern?: RegExp, kind?: "file" | "directory" }) {
        return this.root.getEntry(vpath.resolve(this.currentDirectory, path), options);
    }

    public getFile(path: string, options?: { followSymlinks?: boolean, pattern?: RegExp }): VirtualFile | undefined {
        return this.root.getFile(vpath.resolve(this.currentDirectory, path), options);
    }

    public getDirectory(path: string, options?: { followSymlinks?: boolean, pattern?: RegExp }): VirtualDirectory | undefined {
        return this.root.getDirectory(vpath.resolve(this.currentDirectory, path), options);
    }

    public getAccessibleFileSystemEntries(path: string) {
        const entry = this.getEntry(path);
        if (entry instanceof VirtualDirectory) {
            return {
                files: entry.getFiles().map(f => f.name),
                directories: entry.getDirectories().map(d => d.name)
            };
        }
        return { files: [], directories: [] };
    }

    public clone(): VirtualFileSystem {
        const fs = new VirtualFileSystem(this.currentDirectory, this.useCaseSensitiveFileNames);
        fs._root = this.root.clone(fs);
        return fs;
    }

    protected makeReadOnlyCore() {
        this.root.makeReadOnly();
    }

    protected getOwnEntries() {
        return this.root.getEntries();
    }
}

export class VirtualDirectory extends VirtualFileSystemContainer {
    private _entries: (VirtualFile | VirtualDirectory)[] | undefined;
    private _resolver: FileSystemResolver | undefined;
    private _shadowRoot: VirtualDirectory | undefined;

    constructor(parent: VirtualFileSystemContainer, name: string, resolver?: FileSystemResolver) {
        super(parent, name);
        this._entries = undefined;
        this._resolver = resolver;
        this._shadowRoot = undefined;
    }

    public addDirectory(path: string, resolver?: FileSystemResolver): VirtualDirectory | undefined {
        this.writePreamble();
        const basename = vpath.basename(path);
        if (!basename) return undefined;
        const dirname = vpath.dirname(path);
        if (dirname) {
            const directory = this.ensureDirectory(dirname);
            return directory && directory.addDirectory(basename, resolver);
        }
        let entry = this.getEntry(basename);
        if (entry === undefined) {
            entry = new VirtualDirectory(this, basename, resolver);
            this.getOwnEntries().push(entry);
            this.emit("childAdded", entry);
        }
        return entry instanceof VirtualDirectory ? entry : undefined;
    }

    public addFile(path: string, content?: FileSystemResolver["getContent"] | string | undefined): VirtualFile | undefined {
        this.writePreamble();
        const basename = vpath.basename(path);
        if (!basename) return undefined;
        const dirname = vpath.dirname(path);
        if (dirname) {
            const directory = this.ensureDirectory(dirname);
            return directory && directory.addFile(basename, content);
        }
        let entry = this.getEntry(basename);
        if (entry === undefined) {
            entry = new VirtualFile(this, basename, content);
            this.getOwnEntries().push(entry);
            this.emit("childAdded", entry);
        }
        return entry instanceof VirtualFile ? entry : undefined;
    }

    public addSymlink(path: string, target: VirtualFile): VirtualFileSymlink | undefined;
    public addSymlink(path: string, target: VirtualDirectory): VirtualDirectorySymlink | undefined;
    public addSymlink(path: string, target: string | VirtualFile | VirtualDirectory): VirtualSymlink | undefined;
    public addSymlink(path: string, target: string | VirtualFile | VirtualDirectory): VirtualSymlink | undefined {
        this.writePreamble();

        const basename = vpath.basename(path);
        if (!basename) return undefined;

        const targetEntry = typeof target === "string"
            ? this.fileSystem.getEntry(vpath.resolve(this.path, target))
            : target;

        if (targetEntry === undefined) return undefined;

        const dirname = vpath.dirname(path);
        if (dirname) {
            const directory = this.ensureDirectory(dirname);
            return directory && directory.addSymlink(basename, targetEntry);
        }

        let entry = this.getEntry(path);
        if (entry === undefined) {
            if (targetEntry instanceof VirtualFile) {
                entry = new VirtualFileSymlink(this, path, targetEntry.path);
            }
            else if (targetEntry instanceof VirtualDirectory) {
                entry = new VirtualDirectorySymlink(this, path, targetEntry.path);
            }
            else {
                return undefined;
            }

            this.getOwnEntries().push(entry);
            this.emit("childAdded", entry);
        }

        if (target instanceof VirtualFile) {
            return entry instanceof VirtualFileSymlink ? entry : undefined;
        }
        else if (target instanceof VirtualDirectory) {
            return entry instanceof VirtualDirectorySymlink ? entry : undefined;
        }

        return entry instanceof VirtualFileSymlink || entry instanceof VirtualDirectorySymlink ? entry : undefined;
    }

    public removeDirectory(path: string): boolean {
        this.writePreamble();
        const basename = vpath.basename(path);
        if (!basename) return false;
        const dirname = vpath.dirname(path);
        if (dirname) {
            const directory = this.getDirectory(dirname);
            return directory && directory.removeDirectory(basename) || false;
        }
        const entries = this.getOwnEntries();
        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            if (this.fileSystem.sameName(path, entry.name) && entry instanceof VirtualDirectory) {
                entries.splice(i, 1);
                this.emit("childRemoved", entry);
                return true;
            }
        }

        return false;
    }

    public removeFile(path: string): boolean {
        this.writePreamble();
        const basename = vpath.basename(path);
        if (!basename) return false;
        const dirname = vpath.dirname(path);
        if (dirname) {
            const directory = this.getDirectory(dirname);
            return directory && directory.removeFile(basename) || false;
        }
        const entries = this.getOwnEntries();
        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            if (this.fileSystem.sameName(path, entry.name) && entry instanceof VirtualFile) {
                entries.splice(i, 1);
                this.emit("childRemoved", entry);
                return true;
            }
        }
        return false;
    }

    public clone(parent: VirtualFileSystemContainer): VirtualDirectory {
        const clone = new VirtualDirectory(parent, this.name);
        clone._shadowRoot = this;
        return clone;
    }

    protected makeReadOnlyCore(): void {
        if (this._entries) {
            for (const entry of this._entries) {
                entry.makeReadOnly();
            }
        }
    }

    protected getOwnEntries(): (VirtualFile | VirtualDirectory)[] {
        if (!this._entries) {
            const resolver = this._resolver;
            const shadowRoot = this._shadowRoot;
            this._entries = [];
            this._resolver = undefined;
            this._shadowRoot = undefined;
            if (resolver) {
                const { files, directories } = resolver.getEntries(this);
                for (const dir of directories) {
                    const vdir = new VirtualDirectory(this, dir, resolver);
                    if (this.isReadOnly) vdir.makeReadOnly();
                    this._entries.push(vdir);
                }
                for (const file of files) {
                    const vfile = new VirtualFile(this, file, file => resolver.getContent(file));
                    if (this.isReadOnly) vfile.makeReadOnly();
                    this._entries.push(vfile);
                }
            }
            else if (shadowRoot) {
                for (const entry of shadowRoot.getOwnEntries()) {
                    const clone = <VirtualFile | VirtualDirectory>(<VirtualFileSystemEntry>entry).clone(this);
                    if (this.isReadOnly) clone.makeReadOnly();
                    this._entries.push(clone);
                }
            }
        }
        return this._entries;
    }

    private ensureDirectory(path: string) {
        const components = vpath.parse(path);
        if (components.length <= 1 || components[0] || components[1] === "...") return undefined;
        let directory: VirtualDirectory | undefined = this;
        for (let i = 1; i < components.length; i++) {
            directory = directory.addDirectory(components[i]);
            if (directory === undefined) return undefined;
        }
        return directory;
    }
}

class VirtualDirectoryRoot extends VirtualDirectory {
    constructor(parent: VirtualFileSystem) {
        super(parent, "");
    }
}

export class VirtualDirectorySymlink extends VirtualDirectory {
    private _targetPath: string;
    private _target: VirtualDirectory | undefined;
    private _symLinks = new Map<VirtualFile | VirtualDirectory, VirtualSymlink>();
    private _symEntries: VirtualSymlink[] | undefined;
    private _onTargetParentChildRemoved: (entry: VirtualFile | VirtualDirectory) => void;
    private _onTargetChildRemoved: (entry: VirtualFile | VirtualDirectory) => void;
    private _onTargetChildAdded: (entry: VirtualFile | VirtualDirectory) => void;

    constructor(parent: VirtualFileSystemContainer, name: string, target: string) {
        super(parent, name);
        this._targetPath = target;
        this._onTargetParentChildRemoved = entry => this.onTargetParentChildRemoved(entry);
        this._onTargetChildAdded = entry => this.onTargetChildAdded(entry);
        this._onTargetChildRemoved = entry => this.onTargetChildRemoved(entry);
    }

    public get target() {
        return this._targetPath;
    }

    public set target(value: string) {
        this.writePreamble();
        if (this._targetPath !== value) {
            this._targetPath = value;
            this.invalidateTarget();
        }
    }

    public get isBroken(): boolean {
        return this.getRealDirectory() === undefined;
    }

    public getRealDirectory(): VirtualDirectory | undefined {
        this.resolveTarget();
        return this._target;
    }

    public addDirectory(path: string, resolver?: FileSystemResolver): VirtualDirectory | undefined {
        const target = this.getRealDirectory();
        return target && target.addDirectory(path, resolver);
    }

    public addFile(path: string, content?: FileSystemResolver["getContent"] | string | undefined): VirtualFile | undefined {
        const target = this.getRealDirectory();
        return target && target.addFile(path, content);
    }

    public removeDirectory(path: string): boolean {
        const target = this.getRealDirectory();
        return target && target.removeDirectory(path) || false;
    }

    public removeFile(path: string): boolean {
        const target = this.getRealDirectory();
        return target && target.removeFile(path) || false;
    }

    public clone(parent: VirtualFileSystemContainer): VirtualDirectory {
        return new VirtualDirectorySymlink(parent, this.name, this.target);
    }

    public resolveTarget(): void {
        if (!this._target) {
            const entry = findTarget(this.fileSystem, this.target);
            if (entry instanceof VirtualDirectory) {
                this._target = entry;
                this._target.parent.on("childRemoved", this._onTargetParentChildRemoved);
                this._target.on("childAdded", this._onTargetChildAdded);
                this._target.on("childRemoved", this._onTargetChildRemoved);
            }
        }
    }

    protected getOwnEntries(): VirtualSymlink[] {
        if (!this._symEntries) {
            const target = this.getRealDirectory();
            return this._symEntries = target && target.getEntries().map(entry => this.getWrappedEntry(entry)) || [];
        }
        return this._symEntries;
    }

    private getWrappedEntry(entry: VirtualFile | VirtualDirectory) {
        let symlink = this._symLinks.get(entry);
        if (entry instanceof VirtualFile) {
            if (symlink instanceof VirtualFileSymlink) {
                return symlink;
            }
            symlink = new VirtualFileSymlink(this, entry.name, entry.path);
            this._symLinks.set(entry, symlink);
        }
        else {
            if (symlink instanceof VirtualDirectorySymlink) {
                return symlink;
            }
            symlink = new VirtualDirectorySymlink(this, entry.name, entry.path);
            this._symLinks.set(entry, symlink);
        }
        return symlink;
    }

    private onTargetParentChildRemoved(entry: VirtualFileSystemEntry) {
        if (entry !== this._target) return;
        this.invalidateTarget();
    }

    private onTargetChildAdded(entry: VirtualFile | VirtualDirectory) {
        const wrapped = this.getWrappedEntry(entry);
        this.getOwnEntries().push(wrapped);
        this.emit("childAdded", wrapped);
    }

    private onTargetChildRemoved(entry: VirtualFile | VirtualDirectory) {
        const wrapped = this.getWrappedEntry(entry);
        const entries = this.getOwnEntries();
        const index = entries.indexOf(wrapped);
        if (index >= 0) entries.splice(index, 1);
        this._symLinks.delete(entry);
        this.emit("childRemoved", wrapped);
    }

    private invalidateTarget() {
        if (!this._target) return;
        this._target.parent.removeListener("childRemoved", this._onTargetParentChildRemoved);
        this._target.removeListener("childAdded", this._onTargetChildAdded);
        this._target.removeListener("childRemoved", this._onTargetChildRemoved);
        this._target = undefined;
        this._symLinks.clear();
        this._symEntries = undefined;
    }
}

export class VirtualFile extends VirtualFileSystemEntry {
    private _content: string | undefined;
    private _resolver: FileSystemResolver["getContent"] | undefined;
    private _shadowRoot: VirtualFile | undefined;

    constructor(parent: VirtualDirectory, name: string, content?: FileSystemResolver["getContent"] | string | undefined) {
        super(parent, name);
        this._content = typeof content === "string" ? content : undefined;
        this._resolver = typeof content === "function" ? content : undefined;
        this._shadowRoot = undefined;
    }

    public getContent(): string | undefined {
        if (this._content === undefined) {
            const resolver = this._resolver;
            const shadowRoot = this._shadowRoot;
            this._resolver = undefined;
            this._shadowRoot = undefined;
            if (resolver) {
                this._content = resolver(this);
            }
            else if (shadowRoot) {
                this._content = shadowRoot.getContent();
            }
        }
        return this._content;
    }

    public setContent(value: string | undefined) {
        this.writePreamble();
        this._resolver = undefined;
        this._content = value;
    }

    public clone(parent: VirtualDirectory): VirtualFile {
        const clone = new VirtualFile(parent, this.name);
        clone._shadowRoot = this;
        return clone;
    }

    protected makeReadOnlyCore(): void {
    }
}

export class VirtualFileSymlink extends VirtualFile {
    private _target: string;

    constructor(parent: VirtualDirectory, name: string, target: string) {
        super(parent, name);
        this._target = target;
    }

    public get target(): string {
        return this._target;
    }

    public set target(value: string) {
        this.writePreamble();
        this._target = value;
    }

    public get isBroken(): boolean {
        return this.getRealFile() === undefined;
    }

    public getRealFile(): VirtualFile | undefined {
        const entry = findTarget(this.fileSystem, this.target);
        return entry instanceof VirtualFile ? entry : undefined;
    }

    public getContent(): string | undefined {
        const target = this.getRealFile();
        return target && target.getContent();
    }

    public setContent(value: string | undefined) {
        const target = this.getRealFile();
        if (target) target.setContent(value);
    }

    public clone(parent: VirtualDirectory) {
        return new VirtualFileSymlink(parent, this.name, this.target);
    }
}

export type VirtualSymlink = VirtualDirectorySymlink | VirtualFileSymlink;

function findTarget(vfs: VirtualFileSystem, target: string, set?: Set<VirtualFileSymlink | VirtualDirectorySymlink>): VirtualFile | VirtualDirectory | undefined {
    const entry = vfs.getEntry(target);
    if (entry instanceof VirtualFileSymlink || entry instanceof VirtualDirectorySymlink) {
        if (!set) set = new Set<VirtualFileSymlink | VirtualDirectorySymlink>();
        if (set.has(entry)) return undefined;
        set.add(entry);
        return findTarget(vfs, entry.target, set);
    }
    return entry;
}

function isMatch(entry: VirtualFile | VirtualDirectory, options: { pattern?: RegExp, kind?: "file" | "directory" }) {
    return (options.pattern === undefined || options.pattern.test(entry.name))
        && (options.kind !== (entry instanceof VirtualFile ? "directory" : "file"));
}