/**
 * GeometricSnapper - Mathematical Regularization & Snapping Engine for VectorAI
 * Converts noisy rasterized vectors into exact geometric primitives:
 * - Collinear and Orthogonal Line Snapping (Horizontal, Vertical, 45°)
 * - 90-degree Right Angle Snapping
 * - Flat Bézier Curve to Line Conversion
 * - Circular and Elliptical Arc Regularization (Exact 4-arc Bézier circles)
 * - G1 Tangent Continuity Smoothing for Smooth Spline Joints
 */

class GeometricSnapper {
  constructor(options = {}) {
    this.snapOrthogonal = options.snapOrthogonal !== false;
    this.orthoToleranceDeg = options.orthoToleranceDeg || 3.5;
    this.snapRightAngles = options.snapRightAngles !== false;
    this.rightAngleToleranceDeg = options.rightAngleToleranceDeg || 6.0;
    this.flatBezierTolerance = options.flatBezierTolerance !== undefined ? options.flatBezierTolerance : 1.2;
    this.detectCircles = options.detectCircles !== false;
    this.circleVarianceThreshold = options.circleVarianceThreshold || 0.045; // 4.5% radial variation
    this.detectEllipses = options.detectEllipses !== false;
    this.smoothTangents = options.smoothTangents !== false;
    this.tangentToleranceDeg = options.tangentToleranceDeg || 12.0;
  }

  regularizeSvg(svgString, options = {}) {
    if (!svgString || typeof svgString !== 'string') return svgString;
    const opts = { ...this, ...options };

    return svgString.replace(/<path\s+([^>]*?)d="([^"]+)"([^>]*?)\/?>/gi, (match, pre, d, post) => {
      try {
        const regularizedD = this.regularizePathD(d, opts);
        return `<path ${pre}d="${regularizedD}"${post}/>`;
      } catch (err) {
        console.warn('Regularization error on path, keeping original:', err);
        return match;
      }
    });
  }

  regularizePathD(d, opts) {
    const commands = this.parseSvgPath(d);
    if (!commands || commands.length === 0) return d;

    // Split into individual sub-paths (loops)
    const subPaths = this.splitSubPaths(commands);
    const regularizedSubPaths = subPaths.map(subPath => this.processSubPath(subPath, opts));

    return this.serializeCommands(regularizedSubPaths.flat());
  }

  splitSubPaths(commands) {
    const subPaths = [];
    let current = [];
    for (const cmd of commands) {
      if (cmd.type === 'M' && current.length > 0) {
        subPaths.push(current);
        current = [];
      }
      current.push(cmd);
      if (cmd.type === 'Z') {
        subPaths.push(current);
        current = [];
      }
    }
    if (current.length > 0) {
      subPaths.push(current);
    }
    return subPaths;
  }

  processSubPath(cmds, opts) {
    if (cmds.length < 2) return cmds;

    const isClosed = cmds[cmds.length - 1].type === 'Z';

    // 1. Circle & Ellipse detection for closed loops
    if (isClosed && (opts.detectCircles || opts.detectEllipses) && cmds.length >= 4) {
      const circleOrEllipse = this.tryFitCircleOrEllipse(cmds, opts);
      if (circleOrEllipse) {
        return circleOrEllipse;
      }
    }

    // 2. Flatten nearly-straight Bézier curves to lines
    let flattened = [];
    let currX = 0, currY = 0;
    const canFlatten = (opts.snapOrthogonal !== false) && (opts.flatBezierTolerance > 0);
    for (let i = 0; i < cmds.length; i++) {
      const cmd = cmds[i];
      if (cmd.type === 'M') {
        flattened.push({ ...cmd });
        currX = cmd.x; currY = cmd.y;
      } else if (cmd.type === 'C') {
        const chordDx = cmd.x - currX;
        const chordDy = cmd.y - currY;
        const chordLen = Math.hypot(chordDx, chordDy);

        if (canFlatten && chordLen > 0.001) {
          const d1 = Math.abs((cmd.x1 - currX) * chordDy - (cmd.y1 - currY) * chordDx) / chordLen;
          const d2 = Math.abs((cmd.x2 - currX) * chordDy - (cmd.y2 - currY) * chordDx) / chordLen;

          if (d1 <= opts.flatBezierTolerance && d2 <= opts.flatBezierTolerance) {
            flattened.push({ type: 'L', x: cmd.x, y: cmd.y });
          } else {
            flattened.push({ ...cmd });
          }
        } else {
          flattened.push({ ...cmd });
        }
        currX = cmd.x; currY = cmd.y;
      } else if (cmd.type === 'L') {
        flattened.push({ ...cmd });
        currX = cmd.x; currY = cmd.y;
      } else if (cmd.type === 'Z') {
        flattened.push({ ...cmd });
      }
    }

    // 3. Collinear line segment merging
    let merged = [];
    if (opts.snapOrthogonal !== false) {
      for (let i = 0; i < flattened.length; i++) {
        const cur = flattened[i];
        if (cur.type === 'L' && merged.length > 0 && merged[merged.length - 1].type === 'L') {
          const prev = merged[merged.length - 1];
          const prevPrev = merged.length >= 2 ? merged[merged.length - 2] : null;
          if (prevPrev && (prevPrev.x !== undefined)) {
            const v1x = prev.x - prevPrev.x;
            const v1y = prev.y - prevPrev.y;
            const v2x = cur.x - prev.x;
            const v2y = cur.y - prev.y;
            const len1 = Math.hypot(v1x, v1y);
            const len2 = Math.hypot(v2x, v2y);
            if (len1 > 0.5 && len2 > 0.5) {
              const dot = (v1x * v2x + v1y * v2y) / (len1 * len2);
              if (dot >= Math.cos(opts.orthoToleranceDeg * Math.PI / 180)) {
                // Same direction within tolerance, extend previous line
                prev.x = cur.x;
                prev.y = cur.y;
                continue;
              }
            }
          }
        }
        merged.push({ ...cur });
      }
    } else {
      merged = flattened;
    }

    // 4. Orthogonal Line Snapping (Horizontal / Vertical / 45-deg)
    if (opts.snapOrthogonal) {
      let pX = 0, pY = 0;
      for (let i = 0; i < merged.length; i++) {
        const cmd = merged[i];
        if (cmd.type === 'M') {
          pX = cmd.x; pY = cmd.y;
        } else if (cmd.type === 'L') {
          const dx = cmd.x - pX;
          const dy = cmd.y - pY;
          const len = Math.hypot(dx, dy);
          if (len > 0.5) {
            let deg = Math.atan2(dy, dx) * 180 / Math.PI;
            if (deg < 0) deg += 360;

            // Check near 0, 180, 360 (Horizontal)
            if (deg <= opts.orthoToleranceDeg || deg >= 360 - opts.orthoToleranceDeg || Math.abs(deg - 180) <= opts.orthoToleranceDeg) {
              cmd.y = pY;
            }
            // Check near 90, 270 (Vertical)
            else if (Math.abs(deg - 90) <= opts.orthoToleranceDeg || Math.abs(deg - 270) <= opts.orthoToleranceDeg) {
              cmd.x = pX;
            }
            // Check near 45, 135, 225, 315
            else {
              for (const diag of [45, 135, 225, 315]) {
                if (Math.abs(deg - diag) <= opts.orthoToleranceDeg * 0.7) {
                  const s = (Math.abs(dx) + Math.abs(dy)) / 2;
                  cmd.x = pX + Math.sign(dx) * s;
                  cmd.y = pY + Math.sign(dy) * s;
                  break;
                }
              }
            }
          }
          pX = cmd.x; pY = cmd.y;
        } else if (cmd.type === 'C') {
          pX = cmd.x; pY = cmd.y;
        }
      }
    }

    // 5. 90-degree Corner Snapping
    if (opts.snapRightAngles) {
      for (let i = 1; i < merged.length - 1; i++) {
        const prev = merged[i - 1];
        const cur = merged[i];
        const next = merged[i + 1];
        if (cur.type === 'L' && next.type === 'L' && (prev.x !== undefined)) {
          const isPrevH = Math.abs(cur.y - prev.y) < 0.01;
          const isPrevV = Math.abs(cur.x - prev.x) < 0.01;
          const isNextH = Math.abs(next.y - cur.y) < 0.01;
          const isNextV = Math.abs(next.x - cur.x) < 0.01;

          if (isPrevH && isNextV) {
            cur.y = prev.y;
            cur.x = next.x;
          } else if (isPrevV && isNextH) {
            cur.x = prev.x;
            cur.y = next.y;
          }
        }
      }
    }

    // 6. Tangent Continuity Smoothing for Béziers (G1 Continuity)
    if (opts.smoothTangents) {
      for (let i = 0; i < merged.length - 1; i++) {
        const cur = merged[i];
        const next = merged[i + 1];
        if (cur.type === 'C' && next.type === 'C') {
          const jointX = cur.x;
          const jointY = cur.y;
          // Incoming tangent vector: joint - cur(cp2)
          const inDx = jointX - cur.x2;
          const inDy = jointY - cur.y2;
          const inLen = Math.hypot(inDx, inDy);

          // Outgoing tangent vector: next(cp1) - joint
          const outDx = next.x1 - jointX;
          const outDy = next.y1 - jointY;
          const outLen = Math.hypot(outDx, outDy);

          if (inLen > 0.1 && outLen > 0.1) {
            const inAngle = Math.atan2(inDy, inDx);
            const outAngle = Math.atan2(outDy, outDx);
            let diffDeg = Math.abs((outAngle - inAngle) * 180 / Math.PI);
            if (diffDeg > 180) diffDeg = 360 - diffDeg;

            if (diffDeg <= opts.tangentToleranceDeg) {
              const avgAngle = inAngle + (outAngle - inAngle) * 0.5;
              const cosA = Math.cos(avgAngle);
              const sinA = Math.sin(avgAngle);

              cur.x2 = jointX - cosA * inLen;
              cur.y2 = jointY - sinA * inLen;

              next.x1 = jointX + cosA * outLen;
              next.y1 = jointY + sinA * outLen;
            }
          }
        }
      }
    }

    return merged;
  }

  tryFitCircleOrEllipse(cmds, opts) {
    const samplePts = [];
    let curX = 0, curY = 0;
    for (const cmd of cmds) {
      if (cmd.type === 'M' || cmd.type === 'L') {
        samplePts.push([cmd.x, cmd.y]);
        curX = cmd.x; curY = cmd.y;
      } else if (cmd.type === 'C') {
        for (let t = 0.2; t <= 1.0; t += 0.2) {
          const inv = 1 - t;
          const x = inv*inv*inv * curX + 3*inv*inv*t * cmd.x1 + 3*inv*t*t * cmd.x2 + t*t*t * cmd.x;
          const y = inv*inv*inv * curY + 3*inv*inv*t * cmd.y1 + 3*inv*t*t * cmd.y2 + t*t*t * cmd.y;
          samplePts.push([x, y]);
        }
        curX = cmd.x; curY = cmd.y;
      }
    }

    if (samplePts.length < 12) return null;

    // Centroid
    let sumX = 0, sumY = 0;
    for (const p of samplePts) { sumX += p[0]; sumY += p[1]; }
    const cx = sumX / samplePts.length;
    const cy = sumY / samplePts.length;

    // Radii from centroid
    const radii = samplePts.map(p => Math.hypot(p[0] - cx, p[1] - cy));
    const meanR = radii.reduce((a, b) => a + b, 0) / radii.length;
    if (meanR < 2.0) return null;

    const variance = radii.reduce((a, b) => a + Math.pow(b - meanR, 2), 0) / radii.length;
    const stdDev = Math.sqrt(variance);
    const cv = stdDev / meanR;

    // 1. Check Perfect Circle
    if (opts.detectCircles && cv <= opts.circleVarianceThreshold) {
      const R = meanR;
      const k = R * 0.55228474983;
      return [
        { type: 'M', x: cx + R, y: cy },
        { type: 'C', x1: cx + R, y1: cy + k, x2: cx + k, y2: cy + R, x: cx, y: cy + R },
        { type: 'C', x1: cx - k, y1: cy + R, x2: cx - R, y2: cy + k, x: cx - R, y: cy },
        { type: 'C', x1: cx - R, y1: cy - k, x2: cx - k, y2: cy - R, x: cx, y: cy - R },
        { type: 'C', x1: cx + k, y1: cy - R, x2: cx + R, y2: cy - k, x: cx + R, y: cy },
        { type: 'Z' }
      ];
    }

    // 2. Check Perfect Ellipse
    if (opts.detectEllipses) {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const p of samplePts) {
        if (p[0] < minX) minX = p[0];
        if (p[0] > maxX) maxX = p[0];
        if (p[1] < minY) minY = p[1];
        if (p[1] > maxY) maxY = p[1];
      }
      const rx = (maxX - minX) / 2;
      const ry = (maxY - minY) / 2;
      if (rx >= 3.0 && ry >= 3.0) {
        let ellipseErrSum = 0;
        for (const p of samplePts) {
          const val = Math.pow((p[0] - cx) / rx, 2) + Math.pow((p[1] - cy) / ry, 2);
          ellipseErrSum += Math.abs(val - 1.0);
        }
        const meanEllipseErr = ellipseErrSum / samplePts.length;
        if (meanEllipseErr <= opts.circleVarianceThreshold * 1.5) {
          const kx = rx * 0.55228474983;
          const ky = ry * 0.55228474983;
          return [
            { type: 'M', x: cx + rx, y: cy },
            { type: 'C', x1: cx + rx, y1: cy + ky, x2: cx + kx, y2: cy + ry, x: cx, y: cy + ry },
            { type: 'C', x1: cx - kx, y1: cy + ry, x2: cx - rx, y2: cy + ky, x: cx - rx, y: cy },
            { type: 'C', x1: cx - rx, y1: cy - ky, x2: cx - kx, y2: cy - ry, x: cx, y: cy - ry },
            { type: 'C', x1: cx + kx, y1: cy - ry, x2: cx + rx, y2: cy - ky, x: cx + rx, y: cy },
            { type: 'Z' }
          ];
        }
      }
    }

    return null;
  }

  parseSvgPath(d) {
    const tokenRegex = /([a-df-z]|[-+]?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?)/gi;
    const tokens = [];
    let match;
    while ((match = tokenRegex.exec(d)) !== null) {
      tokens.push(match[1]);
    }

    const commands = [];
    let i = 0;
    let currX = 0, currY = 0;
    let startX = 0, startY = 0;

    while (i < tokens.length) {
      const type = tokens[i++];
      if (type === 'M' || type === 'm') {
        const isRel = (type === 'm');
        let first = true;
        while (i < tokens.length && !/^[a-df-z]$/i.test(tokens[i])) {
          const x = parseFloat(tokens[i++]);
          const y = parseFloat(tokens[i++]);
          const absX = isRel ? currX + x : x;
          const absY = isRel ? currY + y : y;
          if (first) {
            commands.push({ type: 'M', x: absX, y: absY });
            startX = absX; startY = absY;
            first = false;
          } else {
            commands.push({ type: 'L', x: absX, y: absY });
          }
          currX = absX; currY = absY;
        }
      } else if (type === 'L' || type === 'l') {
        const isRel = (type === 'l');
        while (i < tokens.length && !/^[a-df-z]$/i.test(tokens[i])) {
          const x = parseFloat(tokens[i++]);
          const y = parseFloat(tokens[i++]);
          const absX = isRel ? currX + x : x;
          const absY = isRel ? currY + y : y;
          commands.push({ type: 'L', x: absX, y: absY });
          currX = absX; currY = absY;
        }
      } else if (type === 'H' || type === 'h') {
        const isRel = (type === 'h');
        while (i < tokens.length && !/^[a-df-z]$/i.test(tokens[i])) {
          const x = parseFloat(tokens[i++]);
          const absX = isRel ? currX + x : x;
          commands.push({ type: 'L', x: absX, y: currY });
          currX = absX;
        }
      } else if (type === 'V' || type === 'v') {
        const isRel = (type === 'v');
        while (i < tokens.length && !/^[a-df-z]$/i.test(tokens[i])) {
          const y = parseFloat(tokens[i++]);
          const absY = isRel ? currY + y : y;
          commands.push({ type: 'L', x: currX, y: absY });
          currY = absY;
        }
      } else if (type === 'C' || type === 'c') {
        const isRel = (type === 'c');
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
          currX = absX; currY = absY;
        }
      } else if (type === 'Z' || type === 'z') {
        commands.push({ type: 'Z' });
        currX = startX; currY = startY;
      } else {
        while (i < tokens.length && !/^[a-df-z]$/i.test(tokens[i])) {
          i++;
        }
      }
    }
    return commands;
  }

  serializeCommands(cmds) {
    const f = (n) => (Math.round(n * 100) / 100).toString();
    const parts = [];
    for (const cmd of cmds) {
      if (cmd.type === 'M') {
        parts.push(`M${f(cmd.x)},${f(cmd.y)}`);
      } else if (cmd.type === 'L') {
        parts.push(`L${f(cmd.x)},${f(cmd.y)}`);
      } else if (cmd.type === 'C') {
        parts.push(`C${f(cmd.x1)},${f(cmd.y1)} ${f(cmd.x2)},${f(cmd.y2)} ${f(cmd.x)},${f(cmd.y)}`);
      } else if (cmd.type === 'Z') {
        parts.push('Z');
      }
    }
    return parts.join('');
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = GeometricSnapper;
}
if (typeof window !== 'undefined') {
  window.GeometricSnapper = GeometricSnapper;
}
