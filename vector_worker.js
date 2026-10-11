self.window=self;
self.document={createElement(name){if(name==='canvas') return new OffscreenCanvas(1,1);throw new Error('Elemento não disponível no worker');}};
importScripts('./vtracer_web.js','./geometric_snapper.js','./vector_engine.js');
self.onmessage=async ({data})=>{try {const result=await new VectorEngine().process(data.image,data.options);data.image.close();self.postMessage({result});}catch(error){self.postMessage({error:error.message});}};
