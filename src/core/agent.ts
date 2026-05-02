import { getResources } from "./resources";
import { runInference } from "./executor";

//global vars (Can change later) - can push to env vars later 
const OLLAMA_MODEL = "tinyllama";
const OLLAMA_MAX_TOKENS = 500;

export async function runAgent() {
    const args = process.argv.slice(2);

    //if force delegation present - skip local inference!
    const forceDelegate = args.includes('--force-delegate');
    if (forceDelegate) {
        console.log('[agent] Force delegating...');
    }

    //extract prompt
    const promptArg = args.find(a => a.startsWith('--prompt='));
    const prompt = (promptArg ? promptArg.split('=')[1] : null) || "Hello there!";

    //check local resources
    const resources = await getResources();

    const delegateUrl = `http://localhost:3002/delegate`;

    //if not constrained and can run ollama inference - try locally
    if (!forceDelegate && !resources.isConstrained && resources.ollamaReachable) {
        //run the inference locally
        const result = await runInference(OLLAMA_MODEL, prompt);

        //if success -> print result, return
        if (result) {
            console.log('[agent] Completed locally');
            console.log('[agent] Output:', result.output);
            console.log('[agent] Hash:', result.outputHash);
            return; // ← early return, done
        }

        //if fail -> fall through to delegate
        console.log('[agent] Local inference failed, delegating...');
    }

    //if no resources, no ollama, or local inference failed -> delegate
    const delegate_response = await fetch(delegateUrl, {
        method: 'POST',
        headers: {
            'Content-type': 'application/json'
        },
        body: JSON.stringify({
            model: OLLAMA_MODEL,
            prompt,
            maxTokens: OLLAMA_MAX_TOKENS
        })
    });

    const data = await delegate_response.json();
    console.log('[agent] Delegated result:', data);
}

runAgent().catch(console.error);