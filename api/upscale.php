<?php
require_once __DIR__ . '/run_model.php';
header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['error' => 'Method not allowed. Use POST.']);
    exit;
}

$tempIn = tempnam(sys_get_temp_dir(), 'upscale_in_');
$tempOut = tempnam(sys_get_temp_dir(), 'upscale_out_');

try {
    $rawInput = file_get_contents('php://input');
    $jsonData = json_decode($rawInput, true);

    if (isset($jsonData['image']) && is_string($jsonData['image'])) {
        $base64 = preg_replace('#^data:image/\w+;base64,#i', '', $jsonData['image']);
        $imgBytes = base64_decode($base64);
        if (!$imgBytes) {
            throw new Exception('Invalid base64 image data.');
        }
        file_put_contents($tempIn, $imgBytes);
    } elseif (isset($_FILES['image']) && is_uploaded_file($_FILES['image']['tmp_name'])) {
        move_uploaded_file($_FILES['image']['tmp_name'], $tempIn);
    } else {
        throw new Exception('Nenhuma imagem enviada.');
    }

    // Determine python binary path
    $pythonBin = '/opt/ai_upscaler/upscale_env/bin/python3';
    if (!file_exists($pythonBin)) {
        $pythonBin = '/home/ubuntu/upscale_env/bin/python3';
    }
    if (!file_exists($pythonBin)) {
        $pythonBin = '/usr/bin/python3';
    }

    $scriptPath = __DIR__ . '/upscale.py';
    $res = run_model([$pythonBin, $scriptPath, $tempIn, $tempOut]);

    if (!$res || empty($res['success']) || !file_exists($tempOut)) {
        $errMsg = ($res && isset($res['error'])) ? $res['error'] : 'Falha na inferência neural: ';
        throw new Exception($errMsg);
    }

    $outBytes = file_get_contents($tempOut);
    $outBase64 = 'data:image/png;base64,' . base64_encode($outBytes);

    echo json_encode([
        'success' => true,
        'width' => $res['width'],
        'height' => $res['height'],
        'image' => $outBase64
    ]);
} catch (Exception $e) {
    http_response_code(500);
    echo json_encode(['error' => $e->getMessage()]);
} finally {
    if (file_exists($tempIn)) @unlink($tempIn);
    if (file_exists($tempOut)) @unlink($tempOut);
}
