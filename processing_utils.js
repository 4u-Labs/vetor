// Shared processing primitives: content identity, bounded caches and cancellation.
window.Processing = {
  check(signal) { if (signal?.aborted) throw new DOMException('Cancelado', 'AbortError'); },
  async key(source, options = '') {
    const c = document.createElement('canvas');
    c.width = source.naturalWidth || source.width; c.height = source.naturalHeight || source.height;
    const ctx = c.getContext('2d'); ctx.drawImage(source, 0, 0);
    const bytes = ctx.getImageData(0, 0, c.width, c.height).data;
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return `${c.width}x${c.height}:${options}:` + Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  },
  put(cache, key, value) {
    const pixels=v=>(v.naturalWidth || v.width)*(v.naturalHeight || v.height);
    if(pixels(value)>24000000) return;
    cache.set(key,value);
    while(cache.size>3 || [...cache.values()].reduce((n,v)=>n+pixels(v),0)>24000000) cache.delete(cache.keys().next().value);
  },
  async image(src) { const img = new Image(); img.src = src; await img.decode(); return img; },
  async request(url, payload, signal) {
    this.check(signal);
    const controller = new AbortController();
    const abort = () => controller.abort(); signal?.addEventListener('abort', abort, {once:true});
    const timer = setTimeout(abort, 120000);
    try {
      const response = await fetch(url, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload), signal:controller.signal});
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || 'Servidor indisponível');
      return data;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
};
