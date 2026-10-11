/**
 * IndustrialExporter - High-Precision Vector Exporter for VectorAI
 * Generates print & CNC-ready vector assets:
 * 1. PDF Vetorial (PDF 1.4): Ready for digital and offset print shops
 * 2. EPS (Encapsulated PostScript 3.0): Universal graphic standard for CorelDraw (X7-X8+) & RIPs
 * 3. DXF (AutoCAD R12 ASCII): Universal CAM format for laser cutters, CNC routers & vinyl plotters
 */

class IndustrialExporter {
  constructor() {
    this.namedColors = {
      black: [0, 0, 0],
      white: [1, 1, 1],
      red: [1, 0, 0],
      green: [0, 0.5, 0],
      blue: [0, 0, 1],
      yellow: [1, 1, 0],
      cyan: [0, 1, 1],
      magenta: [1, 0, 1],
      gray: [0.5, 0.5, 0.5],
      grey: [0.5, 0.5, 0.5]
    };
  }

  /**
   * Parse SVG dimensions and viewBox bounding box
   */
  parseDimensions(svgString) {
    let width = 320, height = 320, minX = 0, minY = 0;
    const vbMatch = svgString.match(/viewBox="([^"]+)"/i);
    if (vbMatch) {
      const parts = vbMatch[1].trim().split(/[\s,]+/).map(Number);
      if (parts.length >= 4 && !isNaN(parts[2]) && !isNaN(parts[3]) && parts[2] > 0 && parts[3] > 0) {
        return {
          width: parts[2],
          height: parts[3],
          minX: isNaN(parts[0]) ? 0 : parts[0],
          minY: isNaN(parts[1]) ? 0 : parts[1]
        };
      }
    }
    const wMatch = svgString.match(/width="([0-9.]+)(?:px)?"/i);
    const hMatch = svgString.match(/height="([0-9.]+)(?:px)?"/i);
    if (wMatch && !isNaN(parseFloat(wMatch[1]))) width = parseFloat(wMatch[1]);
    if (hMatch && !isNaN(parseFloat(hMatch[1]))) height = parseFloat(hMatch[1]);
    return { width, height, minX, minY };
  }

  /**
   * Parse hex, rgb, rgba or named color into normalized [r, g, b] (0..1)
   */
  parseColor(colorStr) {
    if (!colorStr) return null;
    const str = colorStr.trim().toLowerCase();
    if (str === 'none' || str === 'transparent') return null;

    if (this.namedColors[str]) return this.namedColors[str];

    if (str.startsWith('#')) {
      let hex = str.slice(1);
      if (hex.length === 3) {
        hex = hex.split('').map(c => c + c).join('');
      } else if (hex.length === 8) {
        hex = hex.slice(0, 6);
      }
      if (hex.length === 6) {
        const num = parseInt(hex, 16);
        if (!isNaN(num)) {
          return [
            ((num >> 16) & 255) / 255,
            ((num >> 8) & 255) / 255,
            (num & 255) / 255
          ];
        }
      }
    }

    const rgbMatch = str.match(/rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (rgbMatch) {
      return [
        parseInt(rgbMatch[1], 10) / 255,
        parseInt(rgbMatch[2], 10) / 255,
        parseInt(rgbMatch[3], 10) / 255
      ];
    }

    return [0, 0, 0];
  }

  /**
   * Map normalized RGB to nearest AutoCAD Color Index (ACI 1-7)
   */
  rgbToAci(r, g, b) {
    const aciTable = [
      { id: 1, rgb: [1, 0, 0] },       // Red
      { id: 2, rgb: [1, 1, 0] },       // Yellow
      { id: 3, rgb: [0, 1, 0] },       // Green
      { id: 4, rgb: [0, 1, 1] },       // Cyan
      { id: 5, rgb: [0, 0, 1] },       // Blue
      { id: 6, rgb: [1, 0, 1] },       // Magenta
      { id: 7, rgb: [1, 1, 1] },       // White
      { id: 8, rgb: [0.5, 0.5, 0.5] }  // Gray
    ];
    let bestId = 7, minDiff = Infinity;
    for (const aci of aciTable) {
      const dr = r - aci.rgb[0];
      const dg = g - aci.rgb[1];
      const db = b - aci.rgb[2];
      const diff = dr * dr * 2 + dg * dg * 4 + db * db * 3;
      if (diff < minDiff) {
        minDiff = diff;
        bestId = aci.id;
      }
    }
    return bestId;
  }

  /**
   * Parse SVG path 'd' attribute string into command objects
   */
  parsePathD(d) {
    if (!d) return [];
    const tokens = [];
    const re = /([a-df-z]|[-+]?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?)/gi;
    let m;
    while ((m = re.exec(d)) !== null) {
      tokens.push(m[1]);
    }

    const commands = [];
    let i = 0;
    let currX = 0, currY = 0;
    let startX = 0, startY = 0;
    let lastControlX = 0, lastControlY = 0;

    while (i < tokens.length) {
      let token = tokens[i++];
      if (!/^[a-df-z]$/i.test(token)) continue;

      let type = token;
      let isRel = (type === type.toLowerCase());
      let upperType = type.toUpperCase();

      if (upperType === 'M') {
        let isFirst = true;
        while (i < tokens.length && !/^[a-df-z]$/i.test(tokens[i])) {
          const x = parseFloat(tokens[i++]);
          const y = parseFloat(tokens[i++]);
          const absX = isRel ? currX + x : x;
          const absY = isRel ? currY + y : y;
          if (isFirst) {
            commands.push({ type: 'M', x: absX, y: absY });
            startX = absX; startY = absY;
            isFirst = false;
          } else {
            commands.push({ type: 'L', x: absX, y: absY });
          }
          currX = absX; currY = absY;
          lastControlX = currX; lastControlY = currY;
        }
      } else if (upperType === 'L') {
        while (i < tokens.length && !/^[a-df-z]$/i.test(tokens[i])) {
          const x = parseFloat(tokens[i++]);
          const y = parseFloat(tokens[i++]);
          const absX = isRel ? currX + x : x;
          const absY = isRel ? currY + y : y;
          commands.push({ type: 'L', x: absX, y: absY });
          currX = absX; currY = absY;
          lastControlX = currX; lastControlY = currY;
        }
      } else if (upperType === 'H') {
        while (i < tokens.length && !/^[a-df-z]$/i.test(tokens[i])) {
          const x = parseFloat(tokens[i++]);
          const absX = isRel ? currX + x : x;
          commands.push({ type: 'L', x: absX, y: currY });
          currX = absX;
          lastControlX = currX; lastControlY = currY;
        }
      } else if (upperType === 'V') {
        while (i < tokens.length && !/^[a-df-z]$/i.test(tokens[i])) {
          const y = parseFloat(tokens[i++]);
          const absY = isRel ? currY + y : y;
          commands.push({ type: 'L', x: currX, y: absY });
          currY = absY;
          lastControlX = currX; lastControlY = currY;
        }
      } else if (upperType === 'C') {
        while (i < tokens.length && !/^[a-df-z]$/i.test(tokens[i])) {
          const x1 = parseFloat(tokens[i++]);
          const y1 = parseFloat(tokens[i++]);
          const x2 = parseFloat(tokens[i++]);
          const y2 = parseFloat(tokens[i++]);
          const x = parseFloat(tokens[i++]);
          const y = parseFloat(tokens[i++]);
          const absX1 = isRel ? currX + x1 : x1;
          const absY1 = isRel ? currY + y1 : y1;
          const absX2 = isRel ? currX + x2 : x2;
          const absY2 = isRel ? currY + y2 : y2;
          const absX = isRel ? currX + x : x;
          const absY = isRel ? currY + y : y;
          commands.push({
            type: 'C',
            x1: absX1, y1: absY1,
            x2: absX2, y2: absY2,
            x: absX, y: absY
          });
          lastControlX = absX2; lastControlY = absY2;
          currX = absX; currY = absY;
        }
      } else if (upperType === 'S') {
        while (i < tokens.length && !/^[a-df-z]$/i.test(tokens[i])) {
          const x2 = parseFloat(tokens[i++]);
          const y2 = parseFloat(tokens[i++]);
          const x = parseFloat(tokens[i++]);
          const y = parseFloat(tokens[i++]);
          const absX1 = 2 * currX - lastControlX;
          const absY1 = 2 * currY - lastControlY;
          const absX2 = isRel ? currX + x2 : x2;
          const absY2 = isRel ? currY + y2 : y2;
          const absX = isRel ? currX + x : x;
          const absY = isRel ? currY + y : y;
          commands.push({
            type: 'C',
            x1: absX1, y1: absY1,
            x2: absX2, y2: absY2,
            x: absX, y: absY
          });
          lastControlX = absX2; lastControlY = absY2;
          currX = absX; currY = absY;
        }
      } else if (upperType === 'Z') {
        commands.push({ type: 'Z' });
        currX = startX; currY = startY;
        lastControlX = currX; lastControlY = currY;
      } else {
        while (i < tokens.length && !/^[a-df-z]$/i.test(tokens[i])) {
          i++;
        }
      }
    }
    return commands;
  }

  /**
   * Parse entire SVG document into structured geometric paths
   */
  parseSvg(svgString, options = {}) {
    const dims=this.parseDimensions(svgString), paths=[];
    const root=new DOMParser().parseFromString(svgString,'image/svg+xml');
    if(root.querySelector('parsererror')) throw new Error('SVG inválido');
    const walk=(el,parentMatrix,inheritedFill='black',inheritedRule='nonzero')=>{
      let matrix=parentMatrix;
      if(el.hasAttribute('transform')) matrix=matrix.multiply(this.transformMatrix(el.getAttribute('transform')));
      const fill=el.getAttribute('fill') || inheritedFill;
      const rule=el.getAttribute('fill-rule') || inheritedRule;
      let commands;
      if(el.localName==='path') {
        const d=el.getAttribute('d') || '';
        if(/[aqt]/i.test(d)) throw new Error('Converta arcos e curvas quadráticas em Bézier cúbicas antes de exportar.');
        commands=this.parsePathD(d);
      } else if(el.localName==='rect') {
        const x=+(el.getAttribute('x')||0),y=+(el.getAttribute('y')||0),w=+el.getAttribute('width'),h=+el.getAttribute('height');
        commands=[{type:'M',x,y},{type:'L',x:x+w,y},{type:'L',x:x+w,y:y+h},{type:'L',x,y:y+h},{type:'Z'}];
      }
      if(commands?.length) {
        commands=commands.map(c=>{
          const result={...c};
          for(const suffix of ['', '1','2']) if(c['x'+suffix]!==undefined) {
            const point=matrix.transformPoint({x:c['x'+suffix],y:c['y'+suffix]});
            result['x'+suffix]=point.x;result['y'+suffix]=point.y;
          }
          return result;
        });
        paths.push({commands,fill:this.parseColor(fill),fillRule:rule});
      }
      if(!['defs','clipPath','mask'].includes(el.localName)) for(const child of el.children) walk(child,matrix,fill,rule);
    };
    walk(root.documentElement,new DOMMatrix());
    let scale=1;
    if(options.width) scale=options.width/dims.width;
    if(options.points) scale*=options.unit==='in'?72:72/25.4;
    for(const path of paths) for(const c of path.commands) for(const suffix of ['', '1','2']) if(c['x'+suffix]!==undefined) {
      c['x'+suffix]=(c['x'+suffix]-dims.minX)*scale;
      c['y'+suffix]=(c['y'+suffix]-dims.minY)*scale;
    }
    return {width:dims.width*scale,height:dims.height*scale,minX:0,minY:0,paths};
  }

  transformMatrix(value) {
    let m=new DOMMatrix();
    const re=/([a-z]+)\s*\(([^)]*)\)/gi;let match;
    while((match=re.exec(value))) {
      const n=match[2].trim().split(/[\s,]+/).map(Number);
      if(n.some(v=>!Number.isFinite(v))) throw new Error('Transformação SVG inválida');
      switch(match[1]) {
        case 'matrix':m=m.multiply(new DOMMatrix(n));break;
        case 'translate':m=m.translate(n[0],n[1]||0);break;
        case 'scale':m=m.scale(n[0],n[1]??n[0]);break;
        case 'rotate':m=m.translate(n[1]||0,n[2]||0).rotate(n[0]).translate(-(n[1]||0),-(n[2]||0));break;
        case 'skewX':m=m.skewX(n[0]);break;
        case 'skewY':m=m.skewY(n[0]);break;
        default:throw new Error('Transformação SVG não suportada: '+match[1]);
      }
    }
    return m;
  }

  flattenCubic(p0,p1,p2,p3,tolerance,depth=0) {
    // Distance to the finite chord bounds the deviation of the Bézier hull.
    const distance=p=>{
      const dx=p3.x-p0.x,dy=p3.y-p0.y,l=dx*dx+dy*dy;
      const t=l?Math.max(0,Math.min(1,((p.x-p0.x)*dx+(p.y-p0.y)*dy)/l)):0;
      return Math.hypot(p.x-p0.x-t*dx,p.y-p0.y-t*dy);
    };
    if(Math.max(distance(p1),distance(p2))<=tolerance) return [p3];
    if(depth>=20) throw new Error('Tolerância DXF excessivamente pequena.');
    const mid=(a,b)=>({x:(a.x+b.x)/2,y:(a.y+b.y)/2});
    const a=mid(p0,p1),b=mid(p1,p2),c=mid(p2,p3),d=mid(a,b),e=mid(b,c),f=mid(d,e);
    return [...this.flattenCubic(p0,a,d,f,tolerance,depth+1),...this.flattenCubic(f,e,c,p3,tolerance,depth+1)];
  }

  /**
   * Export valid PDF 1.4 Vector Binary Uint8Array
   */
  exportPdf(svgString, options = {}) {
    const { width, height, minX, minY, paths } = this.parseSvg(svgString, {...options, points:!!options.width});
    const f = (n) => (Math.round(n * 1000) / 1000).toString();

    let stream = '';
    for (const p of paths) {
      if (!p.fill) continue;
      const [r, g, b] = p.fill;

      stream += 'q\n';
      stream += `${f(r)} ${f(g)} ${f(b)} rg\n`;

      for (const cmd of p.commands) {
        if (cmd.type === 'M') {
          stream += `${f(cmd.x - minX)} ${f(height - (cmd.y - minY))} m\n`;
        } else if (cmd.type === 'L') {
          stream += `${f(cmd.x - minX)} ${f(height - (cmd.y - minY))} l\n`;
        } else if (cmd.type === 'C') {
          stream += `${f(cmd.x1 - minX)} ${f(height - (cmd.y1 - minY))} ${f(cmd.x2 - minX)} ${f(height - (cmd.y2 - minY))} ${f(cmd.x - minX)} ${f(height - (cmd.y - minY))} c\n`;
        } else if (cmd.type === 'Z') {
          stream += 'h\n';
        }
      }

      if (p.fillRule === 'evenodd') {
        stream += 'f*\n';
      } else {
        stream += 'f\n';
      }
      stream += 'Q\n';
    }

    const encoder = new TextEncoder();
    const streamBytes = encoder.encode(stream);

    // Objects
    const obj1 = '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n';
    const obj2 = '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n';
    const obj3 = `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${f(width)} ${f(height)}] /Contents 4 0 R /Resources << >> >>\nendobj\n`;
    const obj4 = `4 0 obj\n<< /Length ${streamBytes.length} >>\nstream\n${stream}endstream\nendobj\n`;

    const headerPart1 = encoder.encode('%PDF-1.4\n%');
    const binaryMark = new Uint8Array([226, 227, 207, 211, 10]); // High-byte binary marker + newline
    const headerBytes = new Uint8Array(headerPart1.length + binaryMark.length);
    headerBytes.set(headerPart1, 0);
    headerBytes.set(binaryMark, headerPart1.length);

    const objBytesList = [
      encoder.encode(obj1),
      encoder.encode(obj2),
      encoder.encode(obj3),
      encoder.encode(obj4)
    ];

    const offsets = [];
    let currentOffset = headerBytes.length;
    for (const b of objBytesList) {
      offsets.push(currentOffset);
      currentOffset += b.length;
    }

    const startXref = currentOffset;
    let xrefStr = `xref\n0 5\n0000000000 65535 f \n`;
    for (const off of offsets) {
      xrefStr += off.toString().padStart(10, '0') + ' 00000 n \n';
    }
    xrefStr += `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${startXref}\n%%EOF\n`;
    const xrefBytes = encoder.encode(xrefStr);

    const totalLength = currentOffset + xrefBytes.length;
    const finalBytes = new Uint8Array(totalLength);
    let pos = 0;
    finalBytes.set(headerBytes, pos); pos += headerBytes.length;
    for (const b of objBytesList) {
      finalBytes.set(b, pos); pos += b.length;
    }
    finalBytes.set(xrefBytes, pos);

    return finalBytes;
  }

  /**
   * Export Encapsulated PostScript (EPS 3.0) string
   */
  exportEps(svgString, options = {}) {
    const { width, height, minX, minY, paths } = this.parseSvg(svgString, {...options, points:!!options.width});
    const f = (n) => (Math.round(n * 1000) / 1000).toString();

    let eps = `%!PS-Adobe-3.0 EPSF-3.0\n`;
    eps += `%%BoundingBox: 0 0 ${Math.ceil(width)} ${Math.ceil(height)}\n`;
    eps += `%%HiResBoundingBox: 0 0 ${f(width)} ${f(height)}\n`;
    eps += `%%Creator: VectorAI (4u.ia.br)\n`;
    eps += `%%Title: vectorai.eps\n`;
    eps += `%%Pages: 1\n`;
    eps += `%%LanguageLevel: 3\n`;
    eps += `%%EndComments\n\n`;
    eps += `%%BeginProlog\n%%EndProlog\n\n`;
    eps += `%%Page: 1 1\n`;
    eps += `gsave\n`;

    for (const p of paths) {
      if (!p.fill) continue;
      const [r, g, b] = p.fill;

      eps += `gsave\n`;
      eps += `${f(r)} ${f(g)} ${f(b)} setrgbcolor\n`;
      eps += `newpath\n`;

      for (const cmd of p.commands) {
        if (cmd.type === 'M') {
          eps += `${f(cmd.x - minX)} ${f(height - (cmd.y - minY))} moveto\n`;
        } else if (cmd.type === 'L') {
          eps += `${f(cmd.x - minX)} ${f(height - (cmd.y - minY))} lineto\n`;
        } else if (cmd.type === 'C') {
          eps += `${f(cmd.x1 - minX)} ${f(height - (cmd.y1 - minY))} ${f(cmd.x2 - minX)} ${f(height - (cmd.y2 - minY))} ${f(cmd.x - minX)} ${f(height - (cmd.y - minY))} curveto\n`;
        } else if (cmd.type === 'Z') {
          eps += `closepath\n`;
        }
      }

      if (p.fillRule === 'evenodd') {
        eps += `eofill\n`;
      } else {
        eps += `fill\n`;
      }
      eps += `grestore\n`;
    }

    eps += `grestore\n`;
    eps += `showpage\n`;
    eps += `%%EOF\n`;
    return eps;
  }

  /**
   * Export AutoCAD R12 DXF ASCII format
   */
  exportDxf(svgString, options = {}) {
    const { width, height, minX, minY, paths } = this.parseSvg(svgString, options);
    const f = (n) => (Math.round(n * 1000) / 1000).toString();

    let dxf = '0\nSECTION\n2\nHEADER\n0\nENDSEC\n0\nSECTION\n2\nTABLES\n0\nENDSEC\n0\nSECTION\n2\nBLOCKS\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n';
    let layerIdx = 0;

    for (const p of paths) {
      const aci = p.fill ? this.rgbToAci(p.fill[0], p.fill[1], p.fill[2]) : 7;
      let curX = 0, curY = 0;
      let startX = 0, startY = 0;

      for (const c of p.commands) {
        if (c.type === 'M') {
          curX = c.x - minX; curY = c.y - minY;
          startX = curX; startY = curY;
        } else if (c.type === 'L') {
          const targetX = c.x - minX;
          const targetY = c.y - minY;
          dxf += `0\nLINE\n8\nCUT_${layerIdx}\n62\n${aci}\n`;
          dxf += `10\n${f(curX)}\n20\n${f(-curY)}\n30\n0.0\n`;
          dxf += `11\n${f(targetX)}\n21\n${f(-targetY)}\n31\n0.0\n`;
          curX = targetX; curY = targetY;
        } else if (c.type === 'C') {
          const targetX=c.x-minX,targetY=c.y-minY;
          const points=this.flattenCubic({x:curX,y:curY},{x:c.x1-minX,y:c.y1-minY},{x:c.x2-minX,y:c.y2-minY},{x:targetX,y:targetY},options.tolerance || 0.1);
          let prevX=curX,prevY=curY;
          for(const point of points) {
            dxf += `0\nLINE\n8\nCUT_${layerIdx}\n62\n${aci}\n`;
            dxf += `10\n${f(prevX)}\n20\n${f(-prevY)}\n30\n0.0\n`;
            dxf += `11\n${f(point.x)}\n21\n${f(-point.y)}\n31\n0.0\n`;
            prevX=point.x;prevY=point.y;
          }
          curX = targetX; curY = targetY;
        } else if (c.type === 'Z') {
          if (Math.hypot(curX - startX, curY - startY) > 0.01) {
            dxf += `0\nLINE\n8\nCUT_${layerIdx}\n62\n${aci}\n`;
            dxf += `10\n${f(curX)}\n20\n${f(-curY)}\n30\n0.0\n`;
            dxf += `11\n${f(startX)}\n21\n${f(-startY)}\n31\n0.0\n`;
          }
          curX = startX; curY = startY;
        }
      }
      layerIdx++;
    }

    dxf += '0\nENDSEC\n0\nEOF\n';
    return dxf;
  }

  /**
   * Helper to trigger download in browser
   */
  downloadFile(content, filename, mimeType) {
    const blob = (content instanceof Blob) ? content : new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 200);
  }

  downloadPdf(svgString, baseName = 'vectorai', options = {}) {
    const bytes = this.exportPdf(svgString, options = {});
    const blob = new Blob([bytes], { type: 'application/pdf' });
    this.downloadFile(blob, `${baseName}_${Date.now()}.pdf`, 'application/pdf');
  }

  downloadEps(svgString, baseName = 'vectorai', options = {}) {
    const eps = this.exportEps(svgString, options = {});
    this.downloadFile(eps, `${baseName}_${Date.now()}.eps`, 'application/postscript');
  }

  downloadDxf(svgString, baseName = 'vectorai', options = {}) {
    const dxf = this.exportDxf(svgString, options = {});
    this.downloadFile(dxf, `${baseName}_${Date.now()}.dxf`, 'application/dxf');
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = IndustrialExporter;
}
if (typeof window !== 'undefined') {
  window.IndustrialExporter = IndustrialExporter;
}
