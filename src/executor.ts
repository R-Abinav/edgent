import { ENV } from "./config/env.config";
import { createHash } from 'crypto';

export async function runInference(model: string, prompt: string): Promise<{ 
    output: string;
    tokensGenerated: number;
    durationMs: number;
    outputHash: string
} | null>{
    const controller = new AbortController();
    const signal = controller.signal;
    
    //ollama can timeout on slow hardware.
    //lets keep 60 second time out
    const timeout = setTimeout(() => {
        controller.abort()
    }, 60000);

    try{
        //pass the controller signal to fetch()!
        const response = await fetch(`${ENV.OLLAMA_BASE_URL}/api/generate`, {
            method: 'POST',
            signal,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model,
                prompt,
                stream: false,
            })
        });

        if(!response.ok){
            throw new Error(`Failed to call OLLAMA!!: ${response.status} ${response.statusText}`);
        }

        //extract the data
        const data = await response.json();
        
        const model_response = data.response;
        const model_eval_count = data.eval_count;
        const model_total_duration = data.total_duration;

        //hash the output
        const outputHash = createHash('sha256').update(model_response).digest('hex');

        //return a clean object
        return {
            output: model_response,
            tokensGenerated: model_eval_count,
            durationMs: Math.round(model_total_duration / 1_000_000),
            outputHash
        }

    }catch(err: any){
        if(err.name == "AbortError"){
            console.error("Operation aborted");
        }else{
            console.error("Failed to return output from OLLAMA due to slow operation:", err);
        }
        return null;
    }finally{
        clearTimeout(timeout);
    }
}