class WorkerEngine {
  async process(source, options, signal) {
    Processing.check(signal);
    const image=await createImageBitmap(source);
    if(signal?.aborted) {image.close();Processing.check(signal);}
    return new Promise((resolve,reject)=>{
      const worker=new Worker('./vector_worker.js');
      const cleanup=()=>{worker.terminate();signal?.removeEventListener('abort',abort);};
      const abort=()=>{cleanup();reject(new DOMException('Cancelado','AbortError'));};
      signal?.addEventListener('abort',abort,{once:true});
      worker.onmessage=({data})=>{cleanup();data.error?reject(new Error(data.error)):resolve(data.result);};
      worker.onerror=(e)=>{cleanup();reject(new Error(e.message || 'Falha no motor de vetorização'));};
      worker.postMessage({image,options},[image]);
    });
  }
}
