import { runInference } from "../core/executor";

async function testInference() {
    const result = await runInference("tinyllama", "whats 68 + 100 - 70 in one sentence?");
    console.log(result);
}

testInference();
