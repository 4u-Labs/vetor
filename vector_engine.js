/**
 * Vector4U Core Engine - High Precision Sub-Pixel Vectorizer
 * Moore-Neighbor Boundary Tracing + Sub-pixel Gradient Refinement
 * + Line Snapping + Philip J. Schneider's Cubic Bézier Fitting
 */

class VectorEngine {
  constructor() {
    if (typeof document !== 'undefined') {
      this.canvas = document.createElement('canvas');
      this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    }
  }

  async process(img, options = {}) {
    const opts = {
      mode: options.mode || 'logo',
      numColors: options.numColors !== undefined ? parseInt(options.numColors) : 8,
      lineTolerance: options.lineTolerance !== undefined ? options.lineTolerance : 1.2,
      cornerAngle: options.cornerAngle !== undefined ? options.cornerAngle : 50,
      bezierTolerance: options.bezierTolerance !== undefined ? options.bezierTolerance : 1.5,
      denoise: options.denoise !== undefined ? options.denoise : 1,
      transparentBg: options.transparentBg || false,
      ...options
    };

    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;
    if (!this.canvas && typeof document !== 'undefined') {
      this.canvas = document.createElement('canvas');
      this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    }
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx.drawImage(img, 0, 0);

    const imgData = this.ctx.getImageData(0, 0, width, height);
    const data = imgData.data;

    // 1. Try State-of-the-art VTracer (Visioncortex Rust/WASM) Engine
    const vtracer = (typeof window !== 'undefined' && window.VTracer) ? window.VTracer : (typeof global !== 'undefined' ? global.VTracer : null);
    if (vtracer) {
      try {
        if (!vtracer.isReady()) {
          await vtracer.init('./vtracer_wasm_bg.wasm');
        }

        const isLogoBinary = (opts.mode === 'logo' && opts.numColors === 2);
        
        let colorPrecision = 8;
        let layerDifference = 8;
        let maxColors = undefined;

        if (isLogoBinary) {
          maxColors = 2;
          colorPrecision = 6;
          layerDifference = 20;
        } else if (opts.numColors && opts.numColors !== 'auto' && opts.numColors < 24) {
          maxColors = parseInt(opts.numColors);
          if (maxColors <= 4) {
            colorPrecision = 6;
            layerDifference = 16;
          } else if (maxColors <= 8) {
            colorPrecision = 8;
            layerDifference = 10;
          } else {
            colorPrecision = 8;
            layerDifference = 8;
          }
        } else {
          // Full continuous gradients (Auto / Illustration mode / Vector Magic parity)
          colorPrecision = 8;
          layerDifference = 8;
          maxColors = undefined;
        }

        const smoothGradients = opts.numColors === 'auto' && opts.gradientQuality !== 'balanced';
        if (smoothGradients) layerDifference = 2;

        const vtracerOpts = {
          hierarchical: 'stacked',
          mode: 'spline',
          filterSpeckle: smoothGradients ? 1 : Math.max(1, Math.round((opts.denoise !== undefined ? opts.denoise : 1) * 2)),
          colorPrecision: colorPrecision,
          layerDifference: layerDifference,
          cornerThreshold: Math.max(30, Math.min(90, Math.round(opts.cornerAngle || 50))),
          lengthThreshold: opts.lineTolerance ? Math.max(1.5, opts.lineTolerance * 2.0) : 2.5,
          maxIterations: 10,
          spliceThreshold: Math.max(10, Math.min(90, 20 + Number(opts.bezierTolerance) * 10)),
          pathPrecision: 4
        };

        if (maxColors !== undefined) {
          vtracerOpts.maxColors = maxColors;
        }

        // Also supply snake_case aliases for compatibility
        vtracerOpts.filter_speckle = vtracerOpts.filterSpeckle;
        vtracerOpts.color_precision = vtracerOpts.colorPrecision;
        vtracerOpts.layer_difference = vtracerOpts.layerDifference;
        vtracerOpts.corner_threshold = vtracerOpts.cornerThreshold;
        vtracerOpts.length_threshold = vtracerOpts.lengthThreshold;
        vtracerOpts.max_iterations = vtracerOpts.maxIterations;
        vtracerOpts.splice_threshold = vtracerOpts.spliceThreshold;
        vtracerOpts.path_precision = vtracerOpts.pathPrecision;
        if (maxColors !== undefined) {
          vtracerOpts.max_colors = maxColors;
        }

        let svgString = vtracer.vectorize_rgba(data, width, height, vtracerOpts);

        // Background transparency handling
        if (opts.transparentBg) {
          svgString = svgString.replace(/<path\s+d="M0,0C[^"]+"[^>]*\/>/, '');
        }

        // Ensure proper viewBox and responsive 100% sizing
        if (!svgString.includes('viewBox')) {
          svgString = svgString.replace('<svg ', `<svg viewBox="0 0 ${width} ${height}" `);
        }
        svgString = svgString.replace(/width="[^"]*"/, 'width="100%"').replace(/height="[^"]*"/, 'height="100%"');

        // Store raw SVG (with guaranteed viewBox and 100% responsive sizing) for fast interactive toggling
        const rawSvgString = svgString;

        // Apply Mathematical Geometrization & Snapping (Passo 2)
        if (opts.geometricSnapping !== false && typeof GeometricSnapper !== 'undefined') {
          try {
            const coordScale = (opts.originalWidth && opts.originalWidth > 0) ? (width / opts.originalWidth) : 1.0;
            const lineTol = (opts.lineTolerance !== undefined ? opts.lineTolerance : 1.2) * coordScale;
            const linesEnabled = opts.snapOrthogonal !== false;
            const snapper = new GeometricSnapper({
              snapOrthogonal: linesEnabled,
              orthoToleranceDeg: opts.orthoTolerance || 3.5,
              snapRightAngles: opts.snapRightAngles !== false,
              rightAngleToleranceDeg: opts.rightAngleTolerance || 6.0,
              flatBezierTolerance: linesEnabled ? lineTol : 0,
              detectCircles: opts.detectCircles !== false,
              circleVarianceThreshold: opts.circleTolerance || 0.045,
              detectEllipses: opts.detectEllipses !== false,
              smoothTangents: opts.smoothTangents !== false,
              tangentToleranceDeg: opts.tangentTolerance || 12.0
            });
            svgString = snapper.regularizeSvg(svgString);
          } catch (geomErr) {
            console.warn('GeometricSnapper error, using raw SVG:', geomErr);
          }
        }

        // Extract palette
        const matches = [...svgString.matchAll(/fill="([^"]+)"/g)].map(m => m[1].toUpperCase());
        const counts = {};
        matches.forEach(c => counts[c] = (counts[c] || 0) + 1);
        const palette = Object.keys(counts)
          .sort((a, b) => counts[b] - counts[a])
          .slice(0, Math.max(8, (typeof opts.numColors === 'number' ? opts.numColors : 16)))
          .map(c => ({
            color: c,
            percent: ((counts[c] / (matches.length || 1)) * 100).toFixed(1)
          }));

        return {
          svgString,
          rawSvgString,
          palette,
          width,
          height,
          engine: 'vtracer_wasm'
        };
      } catch (err) {
        console.warn('VTracer WASM error, falling back to JS engine:', err);
      }
    }

    // 2. Fallback to Sub-pixel JS Engine
    if (opts.numColors > 2) {
      return this.processMultiColor(data, width, height, opts);
    } else {
      return this.processMonochrome(data, width, height, opts);
    }
  }

  processMonochrome(data, width, height, opts) {
    // 1. Dominant Palette
    const palette = this.extractPalette(data, width, height);

    // 2. Luminance map & Denoising
    const lum = this.computeLuminance(data, width, height, opts.denoise);

    // 3. Adaptive Otsu Threshold
    const threshold = this.findOtsuThreshold(lum, width, height);

    // 4. Continuous Sub-pixel Marching Squares (True floating-point iso-contours)
    const fgIsBrighter = palette.fgLuminance > palette.bgLuminance;
    const contours = this.extractContinuousContours(lum, width, height, threshold, fgIsBrighter);

    // 5. Vectorize contours using Line Snapping & Schneider Bezier Splines
    const vectorPaths = [];
    for (let i = 0; i < contours.length; i++) {
      const c = contours[i];
      if (c.length < 8) continue;

      const cmds = this.fitContour(c, opts);
      if (cmds.length > 0) {
        vectorPaths.push({
          index: i,
          points: c.length,
          commands: cmds,
          isHole: this.isInnerHole(c, contours)
        });
      }
    }

    // 6. Generate SVG
    const svgString = this.buildSvg(vectorPaths, width, height, palette, opts);

    const palList = [
      { color: palette.background, percent: '50' },
      { color: palette.foreground[0] || '#FFFFFF', percent: '50' }
    ];

    return {
      svgString,
      vectorPaths,
      palette: palList,
      width,
      height
    };
  }

  processMultiColor(data, w, h, opts) {
    const numColors = opts.numColors || 8;
    const centroids = this.quantizeKMeans(data, w, h, numColors);
    const K = centroids.length;

    const colorMap = new Uint8Array(w * h);
    const counts = new Int32Array(K);
    let transparentCount = 0;

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = (y * w + x) * 4;
        const a = data[idx + 3];
        if (a !== undefined && a < 64) {
          colorMap[y * w + x] = 255;
          transparentCount++;
          continue;
        }

        const r = data[idx], g = data[idx + 1], b = data[idx + 2];
        let bestK = 0, bestDist = Infinity;
        for (let k = 0; k < K; k++) {
          const c = centroids[k];
          const d = (r - c[0]) ** 2 + (g - c[1]) ** 2 + (b - c[2]) ** 2;
          if (d < bestDist) { bestDist = d; bestK = k; }
        }
        colorMap[y * w + x] = bestK;
        counts[bestK]++;
      }
    }

    const minArea = Math.max(10, Math.floor(w * h * 0.0003));
    const activeIndices = Array.from({ length: K }, (_, i) => i)
      .filter(i => counts[i] >= minArea)
      .sort((a, b) => counts[b] - counts[a]);

    const palette = activeIndices.map(i => ({
      index: i,
      color: this.rgbToHex(centroids[i][0], centroids[i][1], centroids[i][2]),
      count: counts[i],
      percent: (counts[i] / (w * h) * 100).toFixed(1)
    }));

    if (palette.length === 0) {
      return { svgString: `<svg viewBox="0 0 ${w} ${h}"></svg>`, palette: [], vectorPaths: [], width: w, height: h };
    }

    // Check if the most dominant color covers the border perimeter (is a true canvas background)
    const bgIdx = palette[0].index;
    let borderBgCount = 0;
    let borderTotal = 0;
    for (let x = 0; x < w; x++) {
      if (colorMap[x] === bgIdx) borderBgCount++;
      if (colorMap[(h - 1) * w + x] === bgIdx) borderBgCount++;
      borderTotal += 2;
    }
    for (let y = 1; y < h - 1; y++) {
      if (colorMap[y * w] === bgIdx) borderBgCount++;
      if (colorMap[y * w + (w - 1)] === bgIdx) borderBgCount++;
      borderTotal += 2;
    }

    const hasSignificantTransparency = transparentCount > (w * h * 0.02);
    const isCanvasBg = (borderBgCount / borderTotal) > 0.45 && !hasSignificantTransparency;

    let svg = `<?xml version="1.0" encoding="UTF-8"?>\n`;
    svg += `<svg version="1.1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="100%" height="100%">\n`;
    if (isCanvasBg && !opts.transparentBg) {
      svg += `  <path id="background" d="M 0 0 L ${w} 0 L ${w} ${h} L 0 ${h} Z" fill="${palette[0].color}" />\n`;
    }

    const weights = [0.25, 0.5, 0.25];
    const vectorPaths = [];
    const startRank = isCanvasBg ? 1 : 0;

    for (let rank = startRank; rank < palette.length; rank++) {
      const p = palette[rank];
      const cIdx = p.index;

      const rawMask = new Float32Array(w * h);
      for (let i = 0; i < w * h; i++) {
        rawMask[i] = (colorMap[i] === cIdx) ? 1.0 : 0.0;
      }

      // Separable 3x3 Gaussian smoothing
      const temp = new Float32Array(w * h);
      const smoothMask = new Float32Array(w * h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          let sum = 0;
          for (let k = -1; k <= 1; k++) {
            const nx = Math.min(w - 1, Math.max(0, x + k));
            sum += rawMask[y * w + nx] * weights[k + 1];
          }
          temp[y * w + x] = sum;
        }
      }
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          let sum = 0;
          for (let k = -1; k <= 1; k++) {
            const ny = Math.min(h - 1, Math.max(0, y + k));
            sum += temp[ny * w + x] * weights[k + 1];
          }
          smoothMask[y * w + x] = sum;
        }
      }

      const contours = this.extractContinuousContours(smoothMask, w, h, 0.5, true);
      let layerD = '';
      for (const c of contours) {
        if (c.length < 6) continue;
        const cmds = this.fitContour(c, opts);
        layerD += this.commandsToPathString(cmds) + ' ';
        vectorPaths.push({ color: p.color, points: c.length });
      }

      if (layerD.trim().length > 0) {
        svg += `  <path id="color_${rank}" fill="${p.color}" d="${layerD.trim()}" fill-rule="evenodd" />\n`;
      }
    }

    svg += `</svg>`;
    return { svgString: svg, palette, vectorPaths, width: w, height: h };
  }

  quantizeKMeans(data, w, h, maxK) {
    const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 3000)));
    const samples = [];
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        const idx = (y * w + x) * 4;
        const a = data[idx + 3];
        if (a !== undefined && a < 64) continue;
        samples.push([data[idx], data[idx + 1], data[idx + 2]]);
      }
    }

    const cornerIndices = [0, (w - 1) * 4, ((h - 1) * w) * 4, ((h - 1) * w + (w - 1)) * 4];
    const validCorners = [];
    for (const cIdx of cornerIndices) {
      if (data[cIdx + 3] === undefined || data[cIdx + 3] >= 64) {
        validCorners.push([data[cIdx], data[cIdx + 1], data[cIdx + 2]]);
      }
    }

    let bgCentroid = [255, 255, 255];
    if (validCorners.length > 0) {
      bgCentroid = [
        Math.round(validCorners.reduce((s, c) => s + c[0], 0) / validCorners.length),
        Math.round(validCorners.reduce((s, c) => s + c[1], 0) / validCorners.length),
        Math.round(validCorners.reduce((s, c) => s + c[2], 0) / validCorners.length)
      ];
    } else if (samples.length > 0) {
      bgCentroid = samples[0].slice();
    }

    const centroids = [bgCentroid.slice()];
    while (centroids.length < maxK && samples.length > 0) {
      let maxDist = -1;
      let bestCand = null;
      for (let i = 0; i < samples.length; i += 2) {
        const s = samples[i];
        let minDist = Infinity;
        for (const c of centroids) {
          const d = (s[0] - c[0]) ** 2 + (s[1] - c[1]) ** 2 + (s[2] - c[2]) ** 2;
          if (d < minDist) minDist = d;
        }
        if (minDist > maxDist) { maxDist = minDist; bestCand = s; }
      }
      if (bestCand && maxDist > 120) {
        centroids.push(bestCand.slice());
      } else {
        break;
      }
    }

    const K = centroids.length;
    for (let iter = 0; iter < 6; iter++) {
      const sums = Array.from({ length: K }, () => [0, 0, 0, 0]);
      for (let i = 0; i < samples.length; i++) {
        const s = samples[i];
        let bestK = 0, bestDist = Infinity;
        for (let k = 0; k < K; k++) {
          const c = centroids[k];
          const d = (s[0] - c[0]) ** 2 + (s[1] - c[1]) ** 2 + (s[2] - c[2]) ** 2;
          if (d < bestDist) { bestDist = d; bestK = k; }
        }
        sums[bestK][0] += s[0];
        sums[bestK][1] += s[1];
        sums[bestK][2] += s[2];
        sums[bestK][3]++;
      }
      for (let k = 0; k < K; k++) {
        if (sums[k][3] > 0) {
          centroids[k][0] = Math.round(sums[k][0] / sums[k][3]);
          centroids[k][1] = Math.round(sums[k][1] / sums[k][3]);
          centroids[k][2] = Math.round(sums[k][2] / sums[k][3]);
        }
      }
    }
    return centroids;
  }

  // --- Palette & Luminance ---

  extractPalette(data, w, h) {
    const corners = [0, (w - 1) * 4, ((h - 1) * w) * 4, ((h - 1) * w + (w - 1)) * 4];
    let bgR = 0, bgG = 0, bgB = 0;
    for (const c of corners) {
      bgR += data[c]; bgG += data[c + 1]; bgB += data[c + 2];
    }
    bgR = Math.round(bgR / 4);
    bgG = Math.round(bgG / 4);
    bgB = Math.round(bgB / 4);

    let fgR = 255, fgG = 255, fgB = 255, maxDist = 0;
    for (let y = Math.floor(h * 0.2); y < h * 0.8; y += 4) {
      for (let x = Math.floor(w * 0.2); x < w * 0.8; x += 4) {
        const idx = (y * w + x) * 4;
        const r = data[idx], g = data[idx + 1], b = data[idx + 2];
        const dist = Math.hypot(r - bgR, g - bgG, b - bgB);
        if (dist > maxDist) {
          maxDist = dist;
          fgR = r; fgG = g; fgB = b;
        }
      }
    }

    return {
      background: this.rgbToHex(bgR, bgG, bgB),
      foreground: [this.rgbToHex(fgR, fgG, fgB)],
      bgLuminance: (0.299 * bgR + 0.587 * bgG + 0.114 * bgB) / 255,
      fgLuminance: (0.299 * fgR + 0.587 * fgG + 0.114 * fgB) / 255
    };
  }

  computeLuminance(data, w, h, denoiseLevel) {
    const lum = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const idx = i * 4;
      lum[i] = (0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2]) / 255.0;
    }

    if (denoiseLevel <= 0) return lum;

    // Fast separable Gaussian 3x3 or 5x5
    const smoothed = new Float32Array(w * h);
    const radius = Math.min(2, Math.max(1, denoiseLevel));
    const weights = radius === 1 ? [0.25, 0.5, 0.25] : [0.06, 0.24, 0.4, 0.24, 0.06];
    const half = Math.floor(weights.length / 2);

    const temp = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sum = 0;
        for (let k = -half; k <= half; k++) {
          const nx = Math.min(w - 1, Math.max(0, x + k));
          sum += lum[y * w + nx] * weights[k + half];
        }
        temp[y * w + x] = sum;
      }
    }

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sum = 0;
        for (let k = -half; k <= half; k++) {
          const ny = Math.min(h - 1, Math.max(0, y + k));
          sum += temp[ny * w + x] * weights[k + half];
        }
        smoothed[y * w + x] = sum;
      }
    }

    return smoothed;
  }

  findOtsuThreshold(lum, w, h) {
    const hist = new Int32Array(256);
    for (let i = 0; i < w * h; i++) {
      const v = Math.min(255, Math.max(0, Math.round(lum[i] * 255)));
      hist[v]++;
    }

    const total = w * h;
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];

    let sumB = 0, wB = 0, wF = 0, maxVar = 0, bestThreshold = 128;

    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (wB === 0) continue;
      wF = total - wB;
      if (wF === 0) break;

      sumB += t * hist[t];
      const mB = sumB / wB;
      const mF = (sum - sumB) / wF;
      const betweenVar = wB * wF * (mB - mF) * (mB - mF);

      if (betweenVar > maxVar) {
        maxVar = betweenVar;
        bestThreshold = t;
      }
    }

    return bestThreshold / 255.0;
  }

  // --- Continuous Sub-pixel Marching Squares (O(N) with spatial hashing) ---

  extractContinuousContours(lum, w, h, level, fgIsBrighter = true) {
    function interp(val1, val2, p1, p2) {
      if (Math.abs(val2 - val1) < 1e-6) return (p1 + p2) * 0.5;
      const t = (level - val1) / (val2 - val1);
      return p1 + t * (p2 - p1);
    }

    const segments = [];
    for (let y = 0; y < h - 1; y++) {
      for (let x = 0; x < w - 1; x++) {
        const v00 = lum[y * w + x];
        const v10 = lum[y * w + (x + 1)];
        const v11 = lum[(y + 1) * w + (x + 1)];
        const v01 = lum[(y + 1) * w + x];

        let cellCase = 0;
        if (fgIsBrighter) {
          if (v00 >= level) cellCase |= 1;
          if (v10 >= level) cellCase |= 2;
          if (v11 >= level) cellCase |= 4;
          if (v01 >= level) cellCase |= 8;
        } else {
          if (v00 <= level) cellCase |= 1;
          if (v10 <= level) cellCase |= 2;
          if (v11 <= level) cellCase |= 4;
          if (v01 <= level) cellCase |= 8;
        }

        if (cellCase === 0 || cellCase === 15) continue;

        const top = [interp(v00, v10, x, x + 1), y];
        const right = [x + 1, interp(v10, v11, y, y + 1)];
        const bottom = [interp(v01, v11, x, x + 1), y + 1];
        const left = [x, interp(v00, v01, y, y + 1)];

        switch (cellCase) {
          case 1:  segments.push([left, top]); break;
          case 2:  segments.push([top, right]); break;
          case 3:  segments.push([left, right]); break;
          case 4:  segments.push([right, bottom]); break;
          case 5:  segments.push([left, top]); segments.push([right, bottom]); break;
          case 6:  segments.push([top, bottom]); break;
          case 7:  segments.push([left, bottom]); break;
          case 8:  segments.push([bottom, left]); break;
          case 9:  segments.push([bottom, top]); break;
          case 10: segments.push([bottom, right]); segments.push([top, left]); break;
          case 11: segments.push([bottom, right]); break;
          case 12: segments.push([right, left]); break;
          case 13: segments.push([right, top]); break;
          case 14: segments.push([top, left]); break;
        }
      }
    }

    const key = (p) => `${Math.round(p[0] * 1000)}_${Math.round(p[1] * 1000)}`;
    const startMap = new Map();
    const endMap = new Map();
    const contours = new Map();
    let nextId = 0;

    for (const [fromPt, toPt] of segments) {
      const kFrom = key(fromPt);
      const kTo = key(toPt);

      const headInfo = endMap.get(kFrom);
      const tailInfo = startMap.get(kTo);

      if (headInfo && tailInfo) {
        const [cHead, idHead] = headInfo;
        const [cTail, idTail] = tailInfo;
        endMap.delete(kFrom);
        startMap.delete(kTo);

        if (idHead === idTail) {
          cHead.push(toPt);
        } else {
          for (const p of cTail) cHead.push(p);
          contours.delete(idTail);
          endMap.set(key(cTail[cTail.length - 1]), [cHead, idHead]);
        }
      } else if (headInfo) {
        const [cHead, idHead] = headInfo;
        endMap.delete(kFrom);
        cHead.push(toPt);
        endMap.set(kTo, [cHead, idHead]);
      } else if (tailInfo) {
        const [cTail, idTail] = tailInfo;
        startMap.delete(kTo);
        cTail.unshift(fromPt);
        startMap.set(kFrom, [cTail, idTail]);
      } else {
        const newContour = [fromPt, toPt];
        const id = nextId++;
        contours.set(id, newContour);
        startMap.set(kFrom, [newContour, id]);
        endMap.set(kTo, [newContour, id]);
      }
    }

    return [...contours.values()].filter(c => c.length > 8);
  }

  isInnerHole(contour, allContours) {
    const cx = contour.reduce((sum, p) => sum + p[0], 0) / contour.length;
    const cy = contour.reduce((sum, p) => sum + p[1], 0) / contour.length;

    let insideCount = 0;
    for (const other of allContours) {
      if (other === contour) continue;
      if (this.pointInPolygon([cx, cy], other)) {
        insideCount++;
      }
    }
    return insideCount % 2 === 1;
  }

  pointInPolygon(pt, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][0], yi = poly[i][1];
      const xj = poly[j][0], yj = poly[j][1];
      const intersect = ((yi > pt[1]) !== (yj > pt[1])) &&
        (pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  // --- Hybrid Line Snapping & Philip J. Schneider Curve Fitting ---

  fitContour(pts, opts) {
    const n = pts.length;
    if (n < 4) return [];

    const corners = this.detectCorners(pts, opts.cornerAngle);
    if (corners.length === 0) {
      corners.push(0, Math.floor(n / 2));
    }

    const commands = [['M', pts[corners[0]]]];
    const numCorners = corners.length;

    for (let i = 0; i < numCorners; i++) {
      const cStart = corners[i];
      const cEnd = corners[(i + 1) % numCorners];

      let subPts = [];
      if (cEnd > cStart) {
        subPts = pts.slice(cStart, cEnd + 1);
      } else {
        subPts = pts.slice(cStart).concat(pts.slice(0, cEnd + 1));
      }

      if (subPts.length <= 2) {
        commands.push(['L', subPts[subPts.length - 1]]);
        continue;
      }

      const p0 = subPts[0];
      const pEnd = subPts[subPts.length - 1];
      const chord = [pEnd[0] - p0[0], pEnd[1] - p0[1]];
      const chordLen = Math.hypot(chord[0], chord[1]);

      let isStraightLine = false;
      if (chordLen > 1.0) {
        let maxDist = 0;
        for (const p of subPts) {
          const t = Math.max(0, Math.min(1, ((p[0] - p0[0]) * chord[0] + (p[1] - p0[1]) * chord[1]) / (chordLen * chordLen)));
          const projX = p0[0] + t * chord[0];
          const projY = p0[1] + t * chord[1];
          const dist = Math.hypot(p[0] - projX, p[1] - projY);
          if (dist > maxDist) maxDist = dist;
        }
        if (maxDist < opts.lineTolerance) {
          isStraightLine = true;
        }
      }

      if (isStraightLine) {
        commands.push(['L', pEnd]);
      } else {
        const m = subPts.length;
        const t1 = this.normalize([subPts[Math.min(3, m - 1)][0] - subPts[0][0], subPts[Math.min(3, m - 1)][1] - subPts[0][1]]);
        const t2 = this.normalize([subPts[Math.max(0, m - 4)][0] - subPts[m - 1][0], subPts[Math.max(0, m - 4)][1] - subPts[m - 1][1]]);
        const curveCmds = this.fitBezierRecursive(subPts, t1, t2, opts.bezierTolerance);
        commands.push(...curveCmds);
      }
    }

    commands.push(['Z', null]);
    return commands;
  }

  detectCorners(pts, thresholdDeg = 50, window = 5) {
    const n = pts.length;
    const angles = [];

    for (let i = 0; i < n; i++) {
      const pPrev = pts[(i - window + n) % n];
      const pCurr = pts[i];
      const pNext = pts[(i + window) % n];

      const v1 = this.normalize([pCurr[0] - pPrev[0], pCurr[1] - pPrev[1]]);
      const v2 = this.normalize([pNext[0] - pCurr[0], pNext[1] - pCurr[1]]);

      const dot = Math.max(-1.0, Math.min(1.0, v1[0] * v2[0] + v1[1] * v2[1]));
      const deg = Math.acos(dot) * (180 / Math.PI);
      angles.push({ deg, idx: i });
    }

    const corners = [];
    for (const item of angles) {
      if (item.deg > thresholdDeg) {
        let isLocalMax = true;
        for (let offset = -window; offset <= window; offset++) {
          if (offset === 0) continue;
          const otherIdx = (item.idx + offset + n) % n;
          if (angles[otherIdx].deg > item.deg) {
            isLocalMax = false;
            break;
          }
        }
        if (isLocalMax && !corners.includes(item.idx)) {
          if (!corners.some(c => Math.min(Math.abs(item.idx - c), n - Math.abs(item.idx - c)) < window)) {
            corners.push(item.idx);
          }
        }
      }
    }

    if (corners.length < 2) {
      return [0, Math.floor(n / 2)];
    }

    return corners.sort((a, b) => a - b);
  }

  fitBezierRecursive(pts, t1, t2, maxError) {
    const n = pts.length;
    if (n <= 2) return [['L', pts[n - 1]]];

    const p0 = pts[0];
    const p3 = pts[n - 1];

    const u = this.chordParameterize(pts);
    const { c1, c2 } = this.solveCubicControlPoints(pts, p0, p3, t1, t2, u);

    let maxErr = 0;
    let maxIdx = 1;

    for (let i = 0; i < n; i++) {
      const t = u[i];
      const bx = Math.pow(1 - t, 3) * p0[0] + 3 * Math.pow(1 - t, 2) * t * c1[0] + 3 * (1 - t) * Math.pow(t, 2) * c2[0] + Math.pow(t, 3) * p3[0];
      const by = Math.pow(1 - t, 3) * p0[1] + 3 * Math.pow(1 - t, 2) * t * c1[1] + 3 * (1 - t) * Math.pow(t, 2) * c2[1] + Math.pow(t, 3) * p3[1];
      const err = Math.hypot(pts[i][0] - bx, pts[i][1] - by);
      if (err > maxErr) {
        maxErr = err;
        maxIdx = i;
      }
    }

    if (maxErr < maxError || n <= 4) {
      return [['C', c1, c2, p3]];
    }

    const splitIdx = Math.max(2, Math.min(n - 3, maxIdx));
    const step = Math.min(3, Math.min(splitIdx, n - 1 - splitIdx));
    const tCenterForward = this.normalize([pts[splitIdx + step][0] - pts[splitIdx - step][0], pts[splitIdx + step][1] - pts[splitIdx - step][1]]);
    const tCenterBackward = [-tCenterForward[0], -tCenterForward[1]];

    const left = this.fitBezierRecursive(pts.slice(0, splitIdx + 1), t1, tCenterBackward, maxError);
    const right = this.fitBezierRecursive(pts.slice(splitIdx), tCenterForward, t2, maxError);
    return left.concat(right);
  }

  solveCubicControlPoints(pts, p0, p3, t1, t2, u) {
    const n = pts.length;
    let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;

    for (let i = 0; i < n; i++) {
      const t = u[i];
      const b1 = 3 * t * Math.pow(1 - t, 2);
      const b2 = 3 * Math.pow(t, 2) * (1 - t);
      const b0 = Math.pow(1 - t, 3);
      const b3 = Math.pow(t, 3);

      const a1x = b1 * t1[0], a1y = b1 * t1[1];
      const a2x = b2 * t2[0], a2y = b2 * t2[1];

      const rhsX = pts[i][0] - (b0 * p0[0] + b1 * p0[0] + b2 * p3[0] + b3 * p3[0]);
      const rhsY = pts[i][1] - (b0 * p0[1] + b1 * p0[1] + b2 * p3[1] + b3 * p3[1]);

      c00 += a1x * a1x + a1y * a1y;
      c01 += a1x * a2x + a1y * a2y;
      c11 += a2x * a2x + a2y * a2y;

      x0 += a1x * rhsX + a1y * rhsY;
      x1 += a2x * rhsX + a2y * rhsY;
    }

    const det = c00 * c11 - c01 * c01;
    const totalDist = Math.hypot(p3[0] - p0[0], p3[1] - p0[1]);

    if (Math.abs(det) < 1e-9) {
      const d = totalDist / 3.0;
      return { c1: [p0[0] + t1[0] * d, p0[1] + t1[1] * d], c2: [p3[0] + t2[0] * d, p3[1] + t2[1] * d] };
    }

    const alpha1 = (x0 * c11 - x1 * c01) / det;
    const alpha2 = (c00 * x1 - c01 * x0) / det;

    if (alpha1 <= 0 || alpha2 <= 0 || alpha1 > totalDist * 2.5 || alpha2 > totalDist * 2.5) {
      const d = totalDist / 3.0;
      return { c1: [p0[0] + t1[0] * d, p0[1] + t1[1] * d], c2: [p3[0] + t2[0] * d, p3[1] + t2[1] * d] };
    }

    return {
      c1: [p0[0] + t1[0] * alpha1, p0[1] + t1[1] * alpha1],
      c2: [p3[0] + t2[0] * alpha2, p3[1] + t2[1] * alpha2]
    };
  }

  chordParameterize(pts) {
    const n = pts.length;
    const u = new Float32Array(n);
    let total = 0;
    for (let i = 1; i < n; i++) {
      total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      u[i] = total;
    }
    if (total > 0) {
      for (let i = 1; i < n; i++) u[i] /= total;
    }
    return u;
  }

  normalize(v) {
    const len = Math.hypot(v[0], v[1]);
    return len > 1e-6 ? [v[0] / len, v[1] / len] : [1, 0];
  }

  rgbToHex(r, g, b) {
    return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('').toUpperCase();
  }

  buildSvg(paths, w, h, palette, opts) {
    let svg = `<?xml version="1.0" encoding="UTF-8"?>\n`;
    svg += `<svg version="1.1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="100%" height="100%">\n`;

    if (!opts.transparentBg) {
      svg += `  <path id="background" d="M 0 0 L ${w} 0 L ${w} ${h} L 0 ${h} Z" fill="${palette.background}" />\n`;
    }

    let compoundD = '';
    for (const p of paths) {
      compoundD += this.commandsToPathString(p.commands) + ' ';
    }

    const fgColor = palette.foreground[0] || '#FFFFFF';
    if (compoundD.trim().length > 0) {
      svg += `  <path id="vector_artwork" d="${compoundD.trim()}" fill="${fgColor}" fill-rule="evenodd" />\n`;
    }
    svg += `</svg>`;

    return svg;
  }

  commandsToPathString(commands) {
    const parts = [];
    for (const cmd of commands) {
      const type = cmd[0];
      if (type === 'M') parts.push(`M ${cmd[1][0].toFixed(2)} ${cmd[1][1].toFixed(2)}`);
      else if (type === 'L') parts.push(`L ${cmd[1][0].toFixed(2)} ${cmd[1][1].toFixed(2)}`);
      else if (type === 'C') parts.push(`C ${cmd[1][0].toFixed(2)} ${cmd[1][1].toFixed(2)}, ${cmd[2][0].toFixed(2)} ${cmd[2][1].toFixed(2)}, ${cmd[3][0].toFixed(2)} ${cmd[3][1].toFixed(2)}`);
      else if (type === 'Z') parts.push('Z');
    }
    return parts.join(' ');
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = VectorEngine;
}
