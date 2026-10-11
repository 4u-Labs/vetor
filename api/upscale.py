#!/usr/bin/env python3
import sys
import os
import io
import json
import base64
import numpy as np
from PIL import Image
import onnxruntime as ort

MODEL_PATH = os.path.join(os.path.dirname(__file__), "..", "realesr-general-x4v3.onnx")
if not os.path.exists(MODEL_PATH):
    MODEL_PATH = "/opt/ai_upscaler/realesr-general-x4v3.onnx"
if not os.path.exists(MODEL_PATH):
    MODEL_PATH = "/home/ubuntu/realesr-general-x4v3.onnx"
if not os.path.exists(MODEL_PATH):
    MODEL_PATH = "/home/fabiano/public_html/app/vetor/realesr-general-x4v3.onnx"

def main():
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Usage: upscale.py <input_path> <output_path>"}))
        sys.exit(1)

    input_path = sys.argv[1]
    output_path = sys.argv[2]

    try:
        # Load image
        img = Image.open(input_path)
        has_alpha = img.mode in ('RGBA', 'LA') or (img.mode == 'P' and 'transparency' in img.info)
        
        # Convert to RGBA for consistency
        img_rgba = img.convert('RGBA')
        w, h = img_rgba.size

        if w * h * 16 > 64000000:
            raise ValueError("A saída 4x excede 64 megapixels.")
        alpha = np.array(img_rgba)[:, :, 3]
        opts = ort.SessionOptions()
        opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        session = ort.InferenceSession(MODEL_PATH, opts)
        out_w, out_h = w * 4, h * 4
        out_rgb = np.empty((out_h, out_w, 3), dtype=np.uint8)
        tile, pad = 128, 16
        for y in range(0, h, tile):
            for x in range(0, w, tile):
                left, top = max(0, x-pad), max(0, y-pad)
                right, bottom = min(w, x+tile+pad), min(h, y+tile+pad)
                rgb = np.array(img_rgba.crop((left, top, right, bottom)))[:, :, :3]
                tensor = np.transpose(rgb.astype(np.float32)/255.0, (2, 0, 1))[None]
                prediction = session.run(None, {session.get_inputs()[0].name: tensor})[0][0]
                prediction = (np.clip(np.transpose(prediction, (1, 2, 0)), 0, 1)*255).round().astype(np.uint8)
                dx, dy = (x-left)*4, (y-top)*4
                cw, ch = min(tile, w-x)*4, min(tile, h-y)*4
                out_rgb[y*4:y*4+ch, x*4:x*4+cw] = prediction[dy:dy+ch, dx:dx+cw]

        # Upscale alpha channel smoothly
        alpha_img = Image.fromarray(alpha)
        alpha_scaled = alpha_img.resize((out_w, out_h), Image.Resampling.BICUBIC)
        out_alpha = np.array(alpha_scaled)

        # Combine RGB + Alpha
        final_rgba = np.dstack((out_rgb, out_alpha))
        result_img = Image.fromarray(final_rgba, mode='RGBA')
        result_img.save(output_path, format='PNG', optimize=True)

        print(json.dumps({"success": True, "width": out_w, "height": out_h}))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)

if __name__ == '__main__':
    main()
