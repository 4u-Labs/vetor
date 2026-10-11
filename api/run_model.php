<?php
// Keep diagnostic stderr separate from the JSON response and bound server work.
function run_model(array $command): array {
    $process = proc_open($command, [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
    if (!is_resource($process)) throw new Exception('Não foi possível iniciar o processamento.');
    fclose($pipes[0]);
    stream_set_blocking($pipes[1], false);
    stream_set_blocking($pipes[2], false);
    $stdout = ''; $stderr = ''; $deadline = microtime(true) + 110;
    try {
        do {
            $stdout .= stream_get_contents($pipes[1]);
            $stderr .= stream_get_contents($pipes[2]);
            $status = proc_get_status($process);
            if (!$status['running']) break;
            if (microtime(true) > $deadline) {
                proc_terminate($process, 9);
                throw new Exception('Tempo limite do servidor excedido. Tente uma imagem menor.');
            }
            usleep(20000);
        } while (true);
        $stdout .= stream_get_contents($pipes[1]);
        $stderr .= stream_get_contents($pipes[2]);
        $result = json_decode($stdout, true);
        if (!$result || empty($result['success'])) {
            if ($stderr) error_log($stderr);
            throw new Exception($result['error'] ?? 'O modelo não conseguiu processar a imagem.');
        }
        return $result;
    } finally {
        fclose($pipes[1]); fclose($pipes[2]); proc_close($process);
    }
}
