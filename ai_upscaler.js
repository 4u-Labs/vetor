/**
 * AI Super-Resolution (Real-ESRGAN Compact 4x) for VectorAI
 * Reconstructs razor-sharp edges and removes compression artifacts before vectorization.
 */

class AIUpscaler {
  constructor() {
    this.session = null;
    this.initPromise = null;
    this.modelUrl = './realesr-general-x4v3.onnx';
    this.isSupported = typeof window !== 'undefined' && (typeof WebAssembly !== 'undefined');
  }

  async init(onStatus) {
    if (this.session) return this.session;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      if (onStatus) onStatus('Carregando biblioteca de IA (ONNX Runtime Web)...');

      if (typeof ort === 'undefined') {
        await this.loadScript('https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.0/dist/ort.min.js');
      }

      if (onStatus) onStatus('Inicializando modelo neural Real-ESRGAN 4x...');

      try {
        // Configure execution providers and CDN paths
        ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.0/dist/';
        ort.env.wasm.numThreads = 1;
        ort.env.wasm.simd = true;

        const options = {
          executionProviders: ['webgl', 'wasm']
        };

        this.session = await ort.InferenceSession.create(this.modelUrl, options);
        return this.session;
      } catch (err) {
        console.warn('WebGPU/WASM multi-thread error, trying basic WASM fallback:', err);
        const fallbackOptions = { executionProviders: ['wasm'] };
        this.session = await ort.InferenceSession.create(this.modelUrl, fallbackOptions);
        return this.session;
      }
    })();

    return this.initPromise;
  }

  loadScript(src) {
    return new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[src="${src}"]`);
      if (existing) {
        if (typeof ort !== 'undefined') return resolve();
        existing.addEventListener('load', resolve);
        existing.addEventListener('error', reject);
        return;
      }
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => {s.remove();reject(new Error('Falha ao carregar ' + src));};
      document.head.appendChild(s);
    });
  }

  async upscale(source, onStatus, signal) {
    this.cache ||= new Map();
    Processing.check(signal);
    const key = await Processing.key(source);
    Processing.check(signal);
    if (this.cache.has(key)) return this.cache.get(key);
    const w = source.naturalWidth || source.width, h = source.naturalHeight || source.height;
    if (w * h * 16 > 64000000) throw new Error('A saída 4x excede 64 megapixels. Use uma imagem menor.');
    const input = document.createElement('canvas'); input.width=w; input.height=h;
    input.getContext('2d').drawImage(source,0,0);
    try {
      onStatus?.('Super-resolução 4x no servidor…');
      const json = await Processing.request('./api/upscale.php', {image:input.toDataURL('image/png')}, signal);
      Processing.check(signal);
      const result = await Processing.image(json.image);
      if (result.naturalWidth !== w*4 || result.naturalHeight !== h*4) throw new Error('Servidor retornou dimensões diferentes de 4x');
      result.processingMethod='Real-ESRGAN 4x (servidor)';
      Processing.put(this.cache,key,result); return result;
    } catch (error) { Processing.check(signal); console.warn(error); }
    try {
      await this.init(onStatus); Processing.check(signal);
      const output = document.createElement('canvas'); output.width=w*4; output.height=h*4;
      const ctx=output.getContext('2d');
      const tileSize=128, padding=16;
      const total=Math.ceil(w/tileSize)*Math.ceil(h/tileSize); let done=0;
      for(let y=0;y<h;y+=tileSize) for(let x=0;x<w;x+=tileSize) {
        Processing.check(signal);
        onStatus?.(`IA local: bloco ${++done}/${total}`);
        await new Promise(resolve=>setTimeout(resolve,0));
        const left=Math.max(0,x-padding), top=Math.max(0,y-padding);
        const tw=Math.min(w,x+tileSize+padding)-left, th=Math.min(h,y+tileSize+padding)-top;
        const pixels=input.getContext('2d').getImageData(left,top,tw,th).data, n=tw*th;
        const floats=new Float32Array(n*3);
        for(let i=0;i<n;i++) for(let c=0;c<3;c++) floats[c*n+i]=pixels[i*4+c]/255;
        const tensor=new ort.Tensor('float32',floats,[1,3,th,tw]); let results;
        try {
          results=await this.session.run({[this.session.inputNames[0]]:tensor});
          Processing.check(signal);
          const values=results[this.session.outputNames[0]].data, count=n*16;
          const tile=document.createElement('canvas'); tile.width=tw*4;tile.height=th*4;
          const tc=tile.getContext('2d'), image=tc.createImageData(tw*4,th*4);
          for(let i=0;i<count;i++) { for(let c=0;c<3;c++) image.data[i*4+c]=Math.max(0,Math.min(255,Math.round(values[c*count+i]*255))); image.data[i*4+3]=255; }
          tc.putImageData(image,0,0);
          ctx.drawImage(tile,(x-left)*4,(y-top)*4,Math.min(tileSize,w-x)*4,Math.min(tileSize,h-y)*4,x*4,y*4,Math.min(tileSize,w-x)*4,Math.min(tileSize,h-y)*4);
        } finally { tensor.dispose(); if(results) Object.values(results).forEach(t=>t.dispose()); }
      }
      // Preserve the original alpha, scaled smoothly independently of RGB inference.
      ctx.globalCompositeOperation='destination-in'; ctx.drawImage(input,0,0,w*4,h*4); ctx.globalCompositeOperation='source-over';
      output.processingMethod='Real-ESRGAN 4x (local, em blocos)';
      Processing.put(this.cache,key,output); return output;
    } catch(error) {
      Processing.check(signal); this.initPromise=null;
      console.warn(error); onStatus?.('IA indisponível; usando ampliação convencional 4x.');
      const output=document.createElement('canvas');output.width=w*4;output.height=h*4;
      const ctx=output.getContext('2d');ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';ctx.drawImage(source,0,0,w*4,h*4);
      output.processingMethod='Ampliação convencional 4x (IA indisponível)';return output;
    }
  }
}
window.AIUpscaler = AIUpscaler;
