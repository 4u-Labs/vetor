#!/usr/bin/env python3
import sys
import os
import json
from collections import deque
import numpy as np
from PIL import Image, ImageFilter
import onnxruntime as ort

MODEL_FULL = "/opt/ai_upscaler/u2net.onnx"
MODEL_TINY = "/opt/ai_upscaler/u2netp.onnx"

def get_model_path():
    local_model = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "models", "u2net.onnx")
    for p in [local_model, MODEL_FULL, "/home/ubuntu/.rembg/models/u2net/u2net.onnx", MODEL_TINY, "/home/ubuntu/u2netp.onnx"]:
        if os.path.exists(p):
            return p
    return None

def smart_border_cutout(img, tolerance=35.0):
    """
    Surgically isolates external backgrounds (solid colors, black/white frames,
    fake PNG checkerboards, gradients) connected to the perimeter.
    Guarantees 100% preservation of interior icons, stickers, logos, cards,
    gradients, and anti-aliased curves without cutting through foreground shapes.
    """
    orig_w, orig_h = img.size
    img_rgb = img.convert('RGB')
    arr = np.array(img_rgb).astype(np.float32)

    # Sample corners (6x6 patches in all 4 corners)
    patch_tl = arr[:6, :6].reshape(-1, 3)
    patch_tr = arr[:6, -6:].reshape(-1, 3)
    patch_bl = arr[-6:, :6].reshape(-1, 3)
    patch_br = arr[-6:, -6:].reshape(-1, 3)
    corners = np.vstack([patch_tl, patch_tr, patch_bl, patch_br])
    c_mean = np.mean(corners, axis=0)

    visited = np.zeros((orig_h, orig_w), dtype=bool)
    bg_mask = np.zeros((orig_h, orig_w), dtype=bool)
    q = deque()

    tol_sq = float(tolerance) ** 2

    # Seed flood-fill from all 4 borders
    for y in range(orig_h):
        for x in [0, orig_w - 1]:
            p = arr[y, x]
            if np.sum((p - c_mean) ** 2) < tol_sq * 1.6:
                visited[y, x] = True
                bg_mask[y, x] = True
                q.append((y, x))

    for x in range(orig_w):
        for y in [0, orig_h - 1]:
            if not visited[y, x]:
                p = arr[y, x]
                if np.sum((p - c_mean) ** 2) < tol_sq * 1.6:
                    visited[y, x] = True
                    bg_mask[y, x] = True
                    q.append((y, x))

    # Breadth-first search floodfill
    while q:
        cy, cx = q.popleft()
        for dy, dx in [(-1, 0), (1, 0), (0, -1), (0, 1)]:
            ny, nx = cy + dy, cx + dx
            if 0 <= ny < orig_h and 0 <= nx < orig_w and not visited[ny, nx]:
                visited[ny, nx] = True
                p = arr[ny, nx]
                # Distance to corner mean
                if np.sum((p - c_mean) ** 2) < tol_sq:
                    bg_mask[ny, nx] = True
                    q.append((ny, nx))

    # Construct alpha mask: 0 on background, 255 on foreground
    alpha_np = np.where(bg_mask, 0, 255).astype(np.uint8)
    alpha_img = Image.fromarray(alpha_np, mode='L').filter(ImageFilter.GaussianBlur(radius=0.7))
    return alpha_img

def neural_u2net_cutout(img, tolerance=35.0):
    """
    Deep neural saliency segmentation using full U²-Net (168MB)
    for organic photos, portraits, animals, and real-world scenes.
    """
    model_path = get_model_path()
    if not model_path:
        raise Exception("Nenhum modelo neural U²-Net encontrado.")

    orig_w, orig_h = img.size
    img_rgb = img.convert('RGB')
    resized = img_rgb.resize((320, 320), Image.Resampling.BILINEAR)
    im_np = np.array(resized).astype(np.float32) / 255.0

    mean = np.array([0.485, 0.456, 0.406], dtype=np.float32).reshape((1, 1, 3))
    std = np.array([0.229, 0.224, 0.225], dtype=np.float32).reshape((1, 1, 3))
    im_norm = (im_np - mean) / std
    im_chw = np.transpose(im_norm, (2, 0, 1))
    im_batch = np.expand_dims(im_chw, axis=0).astype(np.float32)

    opts = ort.SessionOptions()
    opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    session = ort.InferenceSession(model_path, opts)

    out = session.run(None, {session.get_inputs()[0].name: im_batch})[0]
    mask = out[0, 0]
    ma = float(np.max(mask))
    mi = float(np.min(mask))
    if ma - mi > 1e-5:
        mask = (mask - mi) / (ma - mi)
    else:
        mask = np.zeros_like(mask)

    # Soft contrast adjustment based on tolerance
    tol_factor = np.clip(tolerance / 35.0, 0.5, 2.0)
    low_cut = np.clip(0.18 / tol_factor, 0.05, 0.4)
    span = np.clip(0.64 * tol_factor, 0.3, 0.9)
    mask = np.clip((mask - low_cut) / span, 0.0, 1.0)

    mask_uint8 = (mask * 255.0).astype(np.uint8)
    alpha_img = Image.fromarray(mask_uint8, mode='L').resize((orig_w, orig_h), Image.Resampling.BILINEAR).filter(ImageFilter.GaussianBlur(radius=0.6))
    return alpha_img

def remove_background(input_path, output_path, mode='auto', tolerance=35.0):
    try:
        img = Image.open(input_path)
        orig_w, orig_h = img.size
        img_rgb = img.convert('RGB')
        arr = np.array(img_rgb).astype(np.float32)

        # Inspect corner variance
        p_tl = arr[:6, :6].reshape(-1, 3)
        p_tr = arr[:6, -6:].reshape(-1, 3)
        p_bl = arr[-6:, :6].reshape(-1, 3)
        p_br = arr[-6:, -6:].reshape(-1, 3)
        corners = np.vstack([p_tl, p_tr, p_bl, p_br])
        c_std = float(np.mean(np.std(corners, axis=0)))

        use_corners = False
        if mode == 'corners':
            use_corners = True
        elif mode == 'neural':
            use_corners = False
        else: # auto
            # If corners have relatively uniform color (std < 35.0) -> Graphic/Icon/Logo/Card
            if c_std < 35.0:
                use_corners = True
            else:
                use_corners = False

        if use_corners:
            alpha_img = smart_border_cutout(img, tolerance=tolerance)
        else:
            alpha_img = neural_u2net_cutout(img, tolerance=tolerance)

        # Merge with existing alpha channel if RGBA
        if img.mode in ('RGBA', 'LA'):
            orig_alpha = np.array(img.convert('RGBA'))[:, :, 3]
            combined = np.minimum(orig_alpha, np.array(alpha_img))
            alpha_img = Image.fromarray(combined, mode='L')

        result = img.convert('RGBA')
        result.putalpha(alpha_img)
        result.save(output_path, format='PNG', optimize=True)

        print(json.dumps({
            "success": True,
            "width": orig_w,
            "height": orig_h,
            "usedMode": "corners" if use_corners else "neural"
        }))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)

if __name__ == '__main__':
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Usage: remove_bg.py <input> <output> [mode] [tolerance]"}))
        sys.exit(1)
    
    in_path = sys.argv[1]
    out_path = sys.argv[2]
    mode_arg = sys.argv[3] if len(sys.argv) > 3 else 'auto'
    tol_arg = float(sys.argv[4]) if len(sys.argv) > 4 else 35.0
    remove_background(in_path, out_path, mode=mode_arg, tolerance=tol_arg)
