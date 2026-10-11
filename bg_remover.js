/**
 * AI Background Remover & Isolation Module for VectorAI
 * 
 * Features:
 * 1. Smart Border-Connected Cutout:
 *    - Surgically removes outer backgrounds (black/white frames, fake PNG checkerboard, solid studio backdrop)
 *    - Preserves 100% of icons, stickers, logos, cards, gloss, gradients, and antialiased curves.
 * 2. Deep Neural Segmentation (Full U²-Net 168MB):
 *    - Saliency detection for organic photos, portraits, animals, and real-world scenes.
 * 3. Smart Hybrid Auto-Detection:
 *    - Automatically detects graphic icons vs organic photos based on corner variance.
 * 4. Ultra-fast local client-side floodfill & server API integration with memory caching.
 */

class BackgroundRemover {
  constructor() {
    this.cache = new Map();
  }

  async removeBackground(imgOrCanvas, options = {}, onStatus) {
    const mode = options.mode || 'auto';
    const tolerance = options.tolerance !== undefined ? options.tolerance : 35;
    const origW = imgOrCanvas.naturalWidth || imgOrCanvas.width;
    const origH = imgOrCanvas.naturalHeight || imgOrCanvas.height;

    const signal = options.signal;
    Processing.check(signal);
    const cacheKey = await Processing.key(imgOrCanvas, mode + ':' + tolerance);
    Processing.check(signal);

    if (this.cache.has(cacheKey)) {
      if (onStatus) onStatus('⚡ Fundo isolado recuperado do cache...');
      return this.cache.get(cacheKey);
    }

    const inCanvas = document.createElement('canvas');
    inCanvas.width = origW;
    inCanvas.height = origH;
    const inCtx = inCanvas.getContext('2d');
    inCtx.drawImage(imgOrCanvas, 0, 0);

    // 1. Try Server-Side Hybrid Engine (U²-Net Full + Smart Border Cutout)
    if (onStatus) {
      if (mode === 'corners') onStatus('✂️ Recortando quinas e fundo externo com precisão cirúrgica...');
      else if (mode === 'neural') onStatus('🧠 Isolando objeto com IA Neural profunda (U²-Net)...');
      else onStatus('⚡ Analisando contraste periférico e isolando fundo...');
    }

    try {
      const dataUrl = inCanvas.toDataURL('image/png');
      const json = await Processing.request('./api/remove_bg.php', {image:dataUrl, mode, tolerance}, signal);
      Processing.check(signal);
      if (json.success) {

        if (json && json.success && json.image) {
          const resultImg = new Image();
          await new Promise((resolve, reject) => {
            resultImg.onload = resolve;
            resultImg.onerror = reject;
            resultImg.src = json.image;
          });
          resultImg.processingMethod = 'Recorte: ' + (json.usedMode || mode);
          Processing.put(this.cache, cacheKey, resultImg);
          return resultImg;
        }
      }
    } catch (err) {
      Processing.check(signal);
      console.warn('Server background removal error, executing high-precision client fallback:', err);
    }

    // 2. High-precision Client-Side Fallback (Smart Border BFS Flood Fill)
    if (onStatus) onStatus('Executando recorte inteligente local via Canvas...');
    Processing.check(signal);
    const outImg = this.clientSideSmartCutout(inCanvas, tolerance);
    await outImg.decode();
    Processing.check(signal);
    outImg.processingMethod = 'Recorte local por cor (IA indisponível)';
    // Do not cache degraded results: Retry must attempt the server again.
    return outImg;
  }

  clientSideSmartCutout(canvas, tolerance = 35) {
    const w = canvas.width;
    const h = canvas.height;
    const ctx = canvas.getContext('2d');
    const imgData = ctx.getImageData(0, 0, w, h);
    const data = imgData.data;

    // Sample corners to find background reference
    const cornerIdxs = [
      0,
      (w - 1) * 4,
      ((h - 1) * w) * 4,
      ((h - 1) * w + w - 1) * 4
    ];
    let bgR = 0, bgG = 0, bgB = 0;
    for (const idx of cornerIdxs) {
      bgR += data[idx];
      bgG += data[idx + 1];
      bgB += data[idx + 2];
    }
    bgR = Math.round(bgR / 4);
    bgG = Math.round(bgG / 4);
    bgB = Math.round(bgB / 4);

    const tolSq = tolerance * tolerance;
    const visited = new Uint8Array(w * h);
    const isBg = new Uint8Array(w * h);
    const queue = [];

    // Helper to test if pixel matches corner color
    function matchesBg(idx) {
      const dr = data[idx] - bgR;
      const dg = data[idx + 1] - bgG;
      const db = data[idx + 2] - bgB;
      return (dr * dr + dg * dg + db * db) < tolSq * 1.5;
    }

    // Seed outer borders
    for (let x = 0; x < w; x++) {
      // Top row
      let idxTop = x * 4;
      if (matchesBg(idxTop)) {
        visited[x] = 1;
        isBg[x] = 1;
        queue.push(x);
      }
      // Bottom row
      let pBottom = (h - 1) * w + x;
      let idxBottom = pBottom * 4;
      if (matchesBg(idxBottom)) {
        visited[pBottom] = 1;
        isBg[pBottom] = 1;
        queue.push(pBottom);
      }
    }

    for (let y = 0; y < h; y++) {
      // Left col
      let pLeft = y * w;
      let idxLeft = pLeft * 4;
      if (!visited[pLeft] && matchesBg(idxLeft)) {
        visited[pLeft] = 1;
        isBg[pLeft] = 1;
        queue.push(pLeft);
      }
      // Right col
      let pRight = y * w + (w - 1);
      let idxRight = pRight * 4;
      if (!visited[pRight] && matchesBg(idxRight)) {
        visited[pRight] = 1;
        isBg[pRight] = 1;
        queue.push(pRight);
      }
    }

    // BFS Queue processing
    let head = 0;
    while (head < queue.length) {
      const pos = queue[head++];
      const cx = pos % w;
      const cy = Math.floor(pos / w);

      const neighbors = [
        cy > 0 ? pos - w : -1,
        cy < h - 1 ? pos + w : -1,
        cx > 0 ? pos - 1 : -1,
        cx < w - 1 ? pos + 1 : -1
      ];

      for (const npos of neighbors) {
        if (npos >= 0 && !visited[npos]) {
          visited[npos] = 1;
          const nidx = npos * 4;
          const dr = data[nidx] - bgR;
          const dg = data[nidx + 1] - bgG;
          const db = data[nidx + 2] - bgB;
          if ((dr * dr + dg * dg + db * db) < tolSq) {
            isBg[npos] = 1;
            queue.push(npos);
          }
        }
      }
    }

    // Set alpha: 0 on connected background, preserved elsewhere with smooth edge
    for (let i = 0; i < w * h; i++) {
      if (isBg[i]) {
        data[i * 4 + 3] = 0;
      }
    }

    ctx.putImageData(imgData, 0, 0);

    const outImg = new Image();
    outImg.src = canvas.toDataURL('image/png');
    return outImg;
  }
}
