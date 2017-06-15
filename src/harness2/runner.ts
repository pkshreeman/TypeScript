import * as ts from "./api";

export interface TestCase {
    /**
     * The id of the associated runner.
     */
    runner: string;

    /**
     * The id of the test case
     */
    id: string;
}

export abstract class Runner<TId extends string = string> {
    private _ts: ts.TypeScript | undefined;

    public readonly id: TId;

    constructor(id: TId) {
        this.id = id;
    }

    public get ts(): ts.TypeScript {
        if (this._ts === undefined) {
            this._ts = require("../../built/local/typescript.js") as ts.TypeScript;
        }
        return this._ts;
    }

    /**
     * Discover test cases for the runner.
     */
    public abstract discover(): string[];

    /**
     * Setup the runner's tests so that they are ready to be executed by the harness.
     * @param tests The tests for this run.
     */
    public test(tests = this.discover()): void {
        describe(`${this.id} tests`, () => {
            if (this.before !== Runner.prototype.before) before(() => this.before());
            if (this.beforeEach !== Runner.prototype.beforeEach) beforeEach(() => this.beforeEach());
            if (this.afterEach !== Runner.prototype.afterEach) afterEach(() => this.afterEach());
            if (this.after !== Runner.prototype.after) after(() => this.after());
            for (const test of tests) this.describe(test);
        });
    }

    /**
     * Override to perform initialization before any tests in the runner are executed.
     */
    protected before(): void { }

    /**
     * Override to perform initialization before each test in the runner is executed.
     */
    protected beforeEach(): void { }

    /**
     * Override to perform cleanup after any tests in the runner are executed.
     */
    protected after(): void {}

    /**
     * Override to perform cleanup after each test in the runner is executed.
     */
    protected afterEach(): void { }

    /**
     * Override to describe test suites and tests for a specific test case.
     * @param id The id of the test case.
     */
    protected abstract describe(id: string): void;
}