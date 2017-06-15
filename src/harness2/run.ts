import { Runner } from "./runner";
import { CompilerRunner } from "./runners/compiler";

let iterations = 1;

function getRunners(): Runner[] {
    const runners: Runner[] = [];
    runners.push(createRunner("conformance"));
    return runners;
}

function createRunner(kind: CompilerRunner["id"]) {
    switch (kind) {
        case "conformance": return new CompilerRunner(kind);
        case "compiler": return new CompilerRunner(kind);
    }
}

function runTests(runners: Runner[]) {
    for (let i = iterations; i > 0; i--) {
        for (const runner of runners) {
            runner.test();
        }
    }
}

runTests(getRunners());